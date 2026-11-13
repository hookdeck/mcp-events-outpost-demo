import http from 'node:http';
import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { signStandardWebhook } from '../src/shared/standard-webhooks.js';
import { isValidWebhookSecret } from '../src/shared/secret.js';

/*
 * A small stand-in for Hookdeck Outpost (v1.9.0) with MCP Events on: the
 * endpoints the demo calls, with the status codes and `mcp_error` bodies real
 * Outpost answers (checked against a local v1.9.0). What it copies:
 *   - GET /mcp/events/list serves mcp-events.json
 *   - subscribe validates, sends a signed verification challenge (cached per
 *     tenant and callback URL), and stores the subscription; the same tenant,
 *     event, arguments and URL refresh it (same id, new expiry, the old secret
 *     keeps signing alongside the new one)
 *   - ttlMs: omitted = 24 hours, null = no expiry, <= 0 = expired
 *   - unsubscribe of an unknown subscription answers NotFound (-32023)
 *   - publish matches a tenant's subscriptions by event name and argument
 *     equality on top-level `data` fields, and delivers the MCP envelope with
 *     a random `msg_` webhook-id per delivery, kept across retries
 *   - 410 and 413 aren't retried
 * Real Outpost also refuses non-https and non-public callback URLs unless
 * insecure callbacks are allowed; the mock allows them, as a dev Outpost would.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const definitions = JSON.parse(fs.readFileSync(new URL('../mcp-events.json', import.meta.url), 'utf8')) as {
  events: Array<{ name: string; inputSchema?: { properties?: Record<string, { type: string }> } }>;
};

export interface PublishRequest {
  id: string;
  tenant_id: string;
  topic: string;
  eligible_for_retry: boolean;
  time?: string;
  metadata?: Record<string, string>;
  data: Record<string, unknown>;
}

export interface MockSubscription {
  id: string;
  tenantId: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  previousSecret?: { secret: string; until: number };
  expiresAt: number | null;
}

export interface MockDelivery {
  eventId: string;
  subscriptionId: string;
  status: number;
  attempt: number;
  headers: Record<string, string>;
  body: string;
}

const sortedJson = (value: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

class McpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

export class MockOutpost {
  readonly tenants = new Set<string>();
  readonly subscriptions = new Map<string, MockSubscription>();
  readonly published: PublishRequest[] = [];
  readonly deliveries: MockDelivery[] = [];
  readonly verifications: string[] = [];
  /** Answer GET /mcp/events/list with this status instead (404 = MCP Events off, 503 = invalid definitions). */
  listStatus = 200;
  private readonly verified = new Set<string>();
  private readonly seenEventIds = new Set<string>();
  private readonly server: http.Server;
  baseUrl = '';

  constructor(readonly apiKey = 'test-outpost-key', private readonly maxAttempts = 3) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.baseUrl;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Re-sends a past delivery with the same webhook-id (an Outpost retry). */
  async redeliver(delivery: MockDelivery) {
    const sub = this.subscriptions.get(delivery.subscriptionId)!;
    await this.post(sub, delivery.headers['webhook-id']!, delivery.body, delivery.eventId);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body?: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.headers.authorization !== `Bearer ${this.apiKey}`) return send(401, { message: 'unauthorized' });

    try {
      if (req.method === 'GET' && url.pathname === '/mcp/events/list') {
        if (this.listStatus !== 200) return send(this.listStatus, { message: 'unavailable' });
        return send(200, { resultType: 'complete', ...definitions });
      }
      if (req.method === 'POST' && parts[0] === 'tenants' && parts[2] === 'mcp' && parts[3] === 'events') {
        const tenantId = parts[1]!;
        if (parts[4] === 'subscribe') return send(200, await this.subscribe(tenantId, body));
        if (parts[4] === 'unsubscribe') return send(200, this.unsubscribe(tenantId, body));
      }
      if (req.method === 'POST' && url.pathname === '/publish') return send(202, this.publish(body as PublishRequest));
    } catch (error) {
      if (error instanceof McpError) {
        return send(422, { mcp_error: { code: error.code, message: error.message, ...(error.data && { data: error.data }) } });
      }
      throw error;
    }
    send(404, { message: 'not found' });
  }

  private key(tenantId: string, name: string, args: Record<string, unknown>, url: string) {
    return `sub_${createHash('sha256').update(JSON.stringify([tenantId, name, sortedJson(args), url])).digest('hex').slice(0, 32)}`;
  }

  private parseKey(tenantId: string, params: Record<string, unknown>) {
    const delivery = (params.delivery ?? {}) as Record<string, unknown>;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const definition = definitions.events.find((event) => event.name === params.name);
    if (!definition) throw new McpError(-32023, 'NotFound', { kind: 'event' });
    const properties = definition.inputSchema?.properties ?? {};
    for (const [name, value] of Object.entries(args)) {
      const type = properties[name]?.type;
      if (!type || (type === 'integer' ? !Number.isInteger(value) : typeof value !== type)) throw new McpError(-32602, 'InvalidParams');
    }
    let callback: URL;
    try {
      callback = new URL(String(delivery.url));
    } catch {
      throw new McpError(-32602, 'InvalidParams');
    }
    if (!/^https?:$/.test(callback.protocol)) throw new McpError(-32602, 'InvalidParams');
    return { name: definition.name, args, url: callback.href, delivery, id: this.key(tenantId, definition.name, args, callback.href) };
  }

  private async subscribe(tenantId: string, params: Record<string, unknown>) {
    const delivery = (params.delivery ?? {}) as Record<string, unknown>;
    if (delivery.mode !== 'webhook') throw new McpError(-32026, 'Unsupported', { feature: 'deliveryMode', value: delivery.mode });
    const { name, args, url, id } = this.parseKey(tenantId, params);
    const secret = String(delivery.secret ?? '');
    if (!isValidWebhookSecret(secret)) throw new McpError(-32602, 'InvalidParams');

    const verifiedKey = JSON.stringify([tenantId, url]);
    if (!this.verified.has(verifiedKey)) {
      await this.verify(url, secret, id);
      this.verified.add(verifiedKey);
    }

    this.tenants.add(tenantId);
    const ttl = params.ttlMs;
    const expiresAt = ttl === null ? null : Date.now() + (typeof ttl === 'number' ? ttl : DAY_MS);
    const existing = this.subscriptions.get(id);
    const previousSecret =
      existing && existing.secret !== secret ? { secret: existing.secret, until: Date.now() + DAY_MS } : existing?.previousSecret;
    this.subscriptions.set(id, { id, tenantId, name, arguments: args, url, secret, previousSecret, expiresAt });
    return {
      resultType: 'complete',
      id,
      refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    };
  }

  private async verify(url: string, secret: string, subscriptionId: string) {
    const challenge = randomBytes(24).toString('base64url');
    const msgId = `msg_verification_${randomBytes(12).toString('hex')}`;
    const body = JSON.stringify({ type: 'verification', challenge });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', 'X-MCP-Subscription-Id': subscriptionId, ...signStandardWebhook([secret], msgId, body) },
        body,
      });
    } catch {
      throw new McpError(-32027, 'CallbackEndpointError', { reason: 'connection_refused' });
    }
    this.verifications.push(msgId);
    if (response.status >= 500) throw new McpError(-32027, 'CallbackEndpointError', { reason: 'http_5xx' });
    if (response.status >= 300) throw new McpError(-32027, 'CallbackEndpointError', { reason: 'http_4xx' });
    const echoed = ((await response.json().catch(() => ({}))) as { challenge?: unknown }).challenge;
    const ok =
      typeof echoed === 'string' && echoed.length === challenge.length && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
    if (!ok) throw new McpError(-32027, 'CallbackEndpointError', { reason: 'challenge_failed' });
  }

  private unsubscribe(tenantId: string, params: Record<string, unknown>) {
    const { id } = this.parseKey(tenantId, params);
    const sub = this.subscriptions.get(id);
    if (!sub || sub.tenantId !== tenantId) throw new McpError(-32023, 'NotFound', { kind: 'subscription' });
    this.subscriptions.delete(id);
    return { resultType: 'complete' };
  }

  private publish(event: PublishRequest) {
    if (!event.tenant_id) throw new Error('tenant_id is required');
    if (this.seenEventIds.has(event.id)) return { id: event.id, duplicate: true, destination_ids: [] };
    this.seenEventIds.add(event.id);
    this.published.push(event);
    const now = Date.now();
    const matched = [...this.subscriptions.values()].filter(
      (sub) =>
        sub.tenantId === event.tenant_id &&
        sub.name === event.topic &&
        (sub.expiresAt === null || sub.expiresAt > now) &&
        Object.entries(sub.arguments).every(([field, value]) => event.data[field] === value),
    );
    for (const sub of matched) void this.deliver(event, sub);
    return { id: event.id, duplicate: false, destination_ids: matched.map((sub) => sub.id) };
  }

  private async deliver(event: PublishRequest, sub: MockSubscription) {
    const envelope = { eventId: event.id, name: event.topic, timestamp: event.time ?? new Date().toISOString(), data: event.data, cursor: null };
    const body = JSON.stringify(envelope);
    const msgId = `msg_${randomBytes(16).toString('base64url')}`;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const status = await this.post(sub, msgId, body, event.id, attempt);
      if ((status >= 200 && status < 300) || status === 410 || status === 413) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async post(sub: MockSubscription, msgId: string, body: string, eventId: string, attempt = 1): Promise<number> {
    const secrets = [sub.secret];
    if (sub.previousSecret && sub.previousSecret.until > Date.now()) secrets.push(sub.previousSecret.secret);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-MCP-Subscription-Id': sub.id,
      ...signStandardWebhook(secrets, msgId, body),
    };
    let status = 0;
    try {
      status = (await fetch(sub.url, { method: 'POST', headers, body, redirect: 'manual' })).status;
    } catch {
      status = 0;
    }
    this.deliveries.push({ eventId, subscriptionId: sub.id, status, attempt, headers, body });
    return status;
  }
}
