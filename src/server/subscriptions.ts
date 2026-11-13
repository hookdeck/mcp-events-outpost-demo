import { ProtocolError } from '@modelcontextprotocol/server';
import type { ServerConfig } from './config.js';
import { EventsErrorCode, forbidden, invalidParams } from './errors.js';
import { tenantIdFor } from './identity.js';
import type { McpResult, OutpostMcp } from './outpost-mcp.js';
import type { TenantRegistry } from './store.js';

export interface SubscriptionServiceDeps {
  config: Pick<ServerConfig, 'defaultTtlMs' | 'maxTtlMs' | 'minTtlMs' | 'tenantPrefix'>;
  outpost: OutpostMcp;
  tenants: TenantRegistry;
  log?: (message: string) => void;
}

/**
 * MCP Events, with Outpost doing the work. For subscribe and unsubscribe this
 * server only:
 *   1. resolves the Outpost tenant from the authenticated principal,
 *   2. checks the principal may receive the event,
 *   3. applies its lifetime policy to `ttlMs`,
 *   4. forwards the params to Outpost and returns Outpost's answer.
 * Outpost validates the request, verifies the callback URL, stores the
 * subscription, expires it, and delivers matching events.
 */
export class SubscriptionService {
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.log = deps.log ?? (() => {});
  }

  list(params: Record<string, unknown> | undefined): Promise<McpResult> {
    const cursor = typeof params?.cursor === 'string' ? params.cursor : undefined;
    return this.deps.outpost.listEvents({ cursor });
  }

  async subscribe(principal: string | undefined, params: Record<string, unknown>): Promise<McpResult> {
    const tenantId = this.tenantFor(principal, params);
    const forwarded = { ...params, ttlMs: this.grantTtlMs(params.ttlMs) };
    const result = await this.deps.outpost.subscribe(tenantId, forwarded);
    this.deps.tenants.add(tenantId);
    this.log(`subscribed ${String(result.id)} for ${tenantId} to ${String(params.name)}, refreshBefore ${String(result.refreshBefore)}`);
    return result;
  }

  async unsubscribe(principal: string | undefined, params: Record<string, unknown>): Promise<McpResult> {
    const tenantId = this.tenantFor(principal, params);
    try {
      const result = await this.deps.outpost.unsubscribe(tenantId, params);
      this.log(`unsubscribed ${tenantId} from ${String(params.name)}`);
      return result;
    } catch (error) {
      // Outpost answers NotFound for a subscription that doesn't exist. OpenAI's guide
      // asks for an idempotent unsubscribe, so treat it as already removed.
      const notFound =
        error instanceof ProtocolError &&
        error.code === EventsErrorCode.NotFound &&
        (error.data as { kind?: string } | undefined)?.kind === 'subscription';
      if (!notFound) throw error;
      return { resultType: 'complete' };
    }
  }

  /** The Outpost tenants to publish to. */
  tenantIds(): string[] {
    return this.deps.tenants.all();
  }

  private tenantFor(principal: string | undefined, params: Record<string, unknown>): string {
    if (!principal) throw forbidden();
    if (typeof params.name !== 'string') throw invalidParams('name is required');
    // Permission check. MCP Events requires the server to check that the caller may
    // receive this event with these arguments; Outpost can't know your access rules.
    // In this demo every principal may receive every order.created event.
    return tenantIdFor(this.deps.config.tenantPrefix, principal);
  }

  /**
   * Outpost grants the forwarded `ttlMs` exactly (omitted means 24 hours, null
   * means no expiry), so the server's own limits apply here: a default when the
   * client sends none (ChatGPT doesn't), and a clamp to [min, max]. A null
   * (no expiry) request gets the maximum.
   */
  grantTtlMs(requested: unknown): number {
    const { defaultTtlMs, minTtlMs, maxTtlMs } = this.deps.config;
    if (requested === undefined) return defaultTtlMs;
    if (requested === null) return maxTtlMs;
    if (typeof requested !== 'number' || !Number.isFinite(requested)) throw invalidParams('ttlMs must be a number');
    return Math.min(Math.max(requested, minTtlMs), maxTtlMs);
  }
}
