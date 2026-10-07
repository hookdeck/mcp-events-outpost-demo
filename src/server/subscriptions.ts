import type { ServerConfig } from './config.js';
import { CallbackUrlError, assertPublicHost, parseCallbackUrl, verifyEndpoint, type VerifyEndpointOptions, type VerificationResult } from './callback.js';
import {
  callbackEndpointError,
  forbidden,
  internalError,
  invalidParams,
  notFound,
  resourceExhausted,
  unsupported,
  type CallbackFailureReason,
} from './errors.js';
import { ORDER_CREATED, argumentsToOutpostFilter, findEvent, orderCreatedArguments } from './events.js';
import { deriveSubscriptionId, hashSecret, tenantIdFor, verificationKey } from './identity.js';
import type { Outpost } from '@hookdeck/outpost-sdk';
import type { Attempt, DestinationUpdate } from '@hookdeck/outpost-sdk/models/components';
import { BadRequestError, NotFoundError, OutpostError } from '@hookdeck/outpost-sdk/models/errors';
import type { SubscriptionRecord, SubscriptionStore } from './store.js';
import { isValidWebhookSecret } from '../shared/secret.js';

export interface DeliveryStatus {
  active: boolean;
  lastDeliveryAt: string | null;
  lastError: CallbackFailureReason | null;
}

export interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: null;
  truncated: boolean;
  deliveryStatus?: DeliveryStatus;
}

export interface SubscriptionServiceDeps {
  config: ServerConfig;
  store: SubscriptionStore;
  outpost: Outpost;
  verify?: (options: VerifyEndpointOptions) => Promise<VerificationResult>;
  now?: () => Date;
  log?: (message: string) => void;
}

type Params = Record<string, unknown>;

/** Server-granted lifetime. Never null: this server does not grant no-expiry subscriptions. */
export function grantTtlMs(requested: unknown, config: Pick<ServerConfig, 'defaultTtlMs' | 'minTtlMs' | 'maxTtlMs'>): number {
  if (typeof requested !== 'number') return config.defaultTtlMs; // omitted, or null (no-expiry request we decline)
  return Math.min(Math.max(requested, config.minTtlMs), config.maxTtlMs);
}

const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Request params for the log, with the signing secret replaced by its shape. */
export function describeParams(params: Params): string {
  const delivery = params.delivery as Record<string, unknown> | undefined;
  if (!delivery || typeof delivery !== 'object' || !('secret' in delivery)) return JSON.stringify(params);
  const secret = delivery.secret;
  const shape = isValidWebhookSecret(secret)
    ? `whsec_ (${Buffer.from(secret.slice(6), 'base64').length} bytes)`
    : `invalid (${typeof secret})`;
  return JSON.stringify({ ...params, delivery: { ...delivery, secret: `<${shape}>` } });
}

function attemptToError(attempt: Attempt | undefined): CallbackFailureReason | null {
  if (!attempt || attempt.status === 'success') return null;
  const code = String(attempt.code ?? '');
  if (/^5\d\d$/.test(code)) return 'http_5xx';
  if (/^[34]\d\d$/.test(code)) return 'http_4xx';
  if (/timeout/i.test(code)) return 'timeout';
  if (/tls|certificate/i.test(code)) return 'tls_error';
  return 'connection_refused';
}

/**
 * MCP Events webhook subscriptions, backed by Outpost:
 * one Outpost tenant per principal, one webhook destination per subscription.
 */
export class SubscriptionService {
  private readonly verifiedUntil = new Map<string, number>();
  private readonly knownTenants = new Set<string>();
  private readonly verify: (options: VerifyEndpointOptions) => Promise<VerificationResult>;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.verify = deps.verify ?? verifyEndpoint;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  private parseKey(params: Params, { validateArguments }: { validateArguments: boolean }) {
    const { config } = this.deps;
    if (typeof params.name !== 'string') throw invalidParams('name is required');
    const event = findEvent(params.name);
    if (!event) throw notFound('event', `Unknown event: ${params.name}`);

    const delivery = params.delivery as Params | undefined;
    if (!delivery || typeof delivery !== 'object') throw invalidParams('delivery is required');
    if (delivery.mode !== undefined && delivery.mode !== 'webhook') throw unsupported('deliveryMode', delivery.mode);

    let url: URL;
    try {
      url = parseCallbackUrl(delivery.url, { allowLocal: config.allowLocalCallbacks });
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message, { field: 'delivery.url', reason: error.reason });
      throw error;
    }

    const rawArgs = params.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) throw invalidParams('arguments must be an object');
    let args = rawArgs as Record<string, unknown>;
    if (validateArguments) {
      const parsed = orderCreatedArguments.safeParse(rawArgs);
      if (!parsed.success) {
        throw invalidParams('arguments do not match the inputSchema', { issues: parsed.error.issues.map((i) => i.message) });
      }
      args = rawArgs as Record<string, unknown>; // keep the caller's exact arguments for the identity key
    }
    return { event, url, args, delivery };
  }

  async subscribe(principal: string | undefined, params: Params): Promise<SubscribeResult> {
    this.log(`events/subscribe from ${principal ?? '(none)'}: ${describeParams(params)}`);
    if (!principal) throw forbidden();
    const { config, store, outpost } = this.deps;
    const { event, url, args, delivery } = this.parseKey(params, { validateArguments: true });

    if (!isValidWebhookSecret(delivery.secret)) {
      throw invalidParams('delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes', { field: 'delivery.secret' });
    }
    const secret = delivery.secret;
    if (params.ttlMs !== undefined && params.ttlMs !== null && (typeof params.ttlMs !== 'number' || params.ttlMs < 0)) {
      throw invalidParams('ttlMs must be a non-negative number or null', { field: 'ttlMs' });
    }

    try {
      await assertPublicHost(url, { allowLocal: config.allowLocalCallbacks });
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message, { field: 'delivery.url', reason: error.reason });
      throw callbackEndpointError('connection_refused'); // DNS failure
    }

    const href = url.href;
    const id = deriveSubscriptionId(principal, href, event.name, args);
    const now = this.now();

    // 1. Endpoint verification, cached per (principal, url).
    const vKey = verificationKey(principal, href);
    if ((this.verifiedUntil.get(vKey) ?? 0) <= now.getTime()) {
      const result = await this.verify({
        url,
        secret,
        subscriptionId: id,
        allowLocal: config.allowLocalCallbacks,
        timeoutMs: config.verificationTimeoutMs,
      });
      if (!result.ok) {
        this.log(`verification failed for ${id}: ${result.reason}`);
        throw callbackEndpointError(result.reason);
      }
      this.verifiedUntil.set(vKey, now.getTime() + config.verificationCacheTtlMs);
      this.log(`verified callback for ${principal} -> ${href}`);
    }

    // 2. Outpost tenant + destination.
    const tenantId = tenantIdFor(config.tenantPrefix, principal);
    const expiresAt = new Date(now.getTime() + grantTtlMs(params.ttlMs, config));
    const existing = store.get(id);
    let deliveryStatus: DeliveryStatus | undefined;

    try {
      if (!this.knownTenants.has(tenantId)) {
        await outpost.tenants.upsert(tenantId, { metadata: { mcp_principal: principal } });
        this.knownTenants.add(tenantId);
      }
      const metadata = { mcp_principal: principal, mcp_event: event.name, mcp_expires_at: isoSeconds(expiresAt) };
      const create = () => this.createDestination(tenantId, id, event.name, href, secret, args, metadata);
      const created = existing ? false : await create();
      if (!created) {
        try {
          deliveryStatus = await this.refreshDestination(tenantId, id, secret, existing?.secretHash, metadata, now);
        } catch (error) {
          // The destination was removed in Outpost behind our back: recreate it.
          if (!(error instanceof NotFoundError)) throw error;
          await create();
        }
      }
    } catch (error) {
      if (error instanceof OutpostError && /maximum number of destinations/i.test(error.body)) {
        throw resourceExhausted('subscriptions', 'Subscription limit reached for this principal');
      }
      this.log(`Outpost error for ${id}: ${(error as Error).message}`);
      throw internalError('Failed to configure delivery');
    }

    store.put({
      id,
      principal,
      tenantId,
      destinationId: id,
      name: event.name,
      arguments: args,
      url: href,
      secretHash: hashSecret(secret),
      expiresAt: expiresAt.toISOString(),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    });

    return {
      id,
      refreshBefore: expiresAt.toISOString(),
      cursor: null, // order.created has no replay
      truncated: params.cursor !== undefined && params.cursor !== null, // we can't resume from a client cursor
      ...(deliveryStatus && { deliveryStatus }),
    };
  }

  /** Returns false when a destination with this id already exists (for example after the local store was lost). */
  private async createDestination(
    tenantId: string,
    id: string,
    topic: string,
    url: string,
    secret: string,
    args: Record<string, unknown>,
    metadata: Record<string, string>,
  ): Promise<boolean> {
    try {
      await this.deps.outpost.destinations.create(tenantId, {
        id,
        type: 'webhook',
        topics: [topic],
        filter: argumentsToOutpostFilter(orderCreatedArguments.parse(args)),
        config: { url, customHeaders: JSON.stringify({ 'X-MCP-Subscription-Id': id }) },
        credentials: { secret },
        metadata,
      });
      return true;
    } catch (error) {
      if (error instanceof BadRequestError && /already exists/i.test(error.body)) return false;
      throw error;
    }
  }

  /** Refresh: extend expiry, rotate the secret if it changed (dual-signing for a grace window), re-enable if disabled. */
  private async refreshDestination(
    tenantId: string,
    id: string,
    secret: string,
    knownSecretHash: string | undefined,
    metadata: Record<string, string>,
    now: Date,
  ): Promise<DeliveryStatus> {
    const { outpost, config } = this.deps;
    const patch: DestinationUpdate = { type: 'webhook', metadata };

    if (knownSecretHash !== hashSecret(secret)) {
      const current = await outpost.destinations.get(tenantId, id);
      const previous = current.type === 'webhook' ? current.credentials.secret : undefined;
      patch.credentials =
        previous && previous !== secret
          ? {
              secret,
              previousSecret: previous,
              previousSecretInvalidAt: new Date(now.getTime() + config.secretRotationGraceMs),
            }
          : { secret };
      if (previous && previous !== secret) this.log(`rotated secret for ${id}`);
    }

    const destination = await outpost.destinations.update(tenantId, id, patch);
    if (destination.disabledAt) {
      // A refresh is the subscriber's liveness signal: resume delivery.
      await outpost.destinations.enable(tenantId, id);
      this.log(`re-enabled ${id}`);
    }

    let attempt: Attempt | undefined;
    try {
      const { models } = await outpost.destinations.listAttempts({ tenantId, destinationId: id, limit: 1 });
      attempt = models?.[0];
    } catch {
      // deliveryStatus is optional; don't fail a refresh over it
    }
    return {
      active: true,
      lastDeliveryAt: attempt?.status === 'success' && attempt.time ? attempt.time.toISOString() : null,
      lastError: attemptToError(attempt),
    };
  }

  /** Idempotent: unknown subscriptions return an empty result (OpenAI's guidance) rather than NotFound. */
  async unsubscribe(principal: string | undefined, params: Params): Promise<Record<string, never>> {
    this.log(`events/unsubscribe from ${principal ?? '(none)'}: ${describeParams(params)}`);
    if (!principal) throw forbidden();
    const { url, args, event } = this.parseKey(params, { validateArguments: false });
    const id = deriveSubscriptionId(principal, url.href, event.name, args);
    const tenantId = tenantIdFor(this.deps.config.tenantPrefix, principal);
    try {
      await this.deleteDestination(tenantId, id);
    } catch (error) {
      this.log(`Outpost error deleting ${id}: ${(error as Error).message}`);
      throw internalError('Failed to remove delivery');
    }
    this.deps.store.delete(id);
    this.log(`unsubscribed ${id}`);
    return {};
  }

  /** Deletes a destination; one that's already gone (404) counts as deleted. */
  private async deleteDestination(tenantId: string, destinationId: string): Promise<void> {
    try {
      await this.deps.outpost.destinations.delete(tenantId, destinationId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  /** TTL sweeper: Outpost destinations don't expire, so delete them once the grant lapses. */
  async sweep(): Promise<string[]> {
    const now = this.now().getTime();
    const removed: string[] = [];
    for (const record of this.deps.store.all()) {
      if (Date.parse(record.expiresAt) > now) continue;
      try {
        await this.deleteDestination(record.tenantId, record.destinationId);
        this.deps.store.delete(record.id);
        removed.push(record.id);
        this.log(`expired ${record.id}`);
      } catch (error) {
        this.log(`sweep failed for ${record.id}, will retry: ${(error as Error).message}`);
      }
    }
    return removed;
  }

  /** Tenants with at least one live subscription to the event. */
  liveTenants(eventName: string = ORDER_CREATED): string[] {
    const now = this.now().getTime();
    const live = this.deps.store
      .all()
      .filter((record) => record.name === eventName && Date.parse(record.expiresAt) > now)
      .map((record: SubscriptionRecord) => record.tenantId);
    return [...new Set(live)];
  }
}
