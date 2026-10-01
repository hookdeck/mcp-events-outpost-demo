import http from 'node:http';
import { signStandardWebhook } from '../src/shared/standard-webhooks.js';
import { isValidWebhookSecret } from '../src/shared/secret.js';
import type { OutpostDestination, PublishRequest } from '../src/server/outpost.js';

/*
 * A tiny stand-in for Hookdeck Outpost's admin API: just the endpoints the
 * demo calls. Deliveries mimic Outpost's Standard Webhooks mode
 * (internal/destregistry/providers/destwebhookstandard):
 *   - body = the published `data`, sent as-is
 *   - webhook-id = the event id (same on every retry)
 *   - webhook-timestamp / webhook-signature regenerated per attempt
 *   - one `v1,` signature per valid secret (current first, then previous)
 *   - custom_headers added, plus a webhook-topic header
 *   - every non-2xx is retried, including 410 and 413 (like Outpost today)
 * The filter matcher is a subset of Outpost's simplejsonmatch.
 */

export interface MockDelivery {
  eventId: string;
  destinationId: string;
  status: number;
  attempt: number;
  headers: Record<string, string>;
  body: string;
}

export function matchesFilter(value: unknown, schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return JSON.stringify(value) === JSON.stringify(schema);
  }
  return Object.entries(schema as Record<string, unknown>).every(([key, expected]) => {
    const n = value as number;
    switch (key) {
      case '$eq': return JSON.stringify(value) === JSON.stringify(expected);
      case '$neq': return JSON.stringify(value) !== JSON.stringify(expected);
      case '$gte': return typeof value === 'number' && n >= (expected as number);
      case '$gt': return typeof value === 'number' && n > (expected as number);
      case '$lte': return typeof value === 'number' && n <= (expected as number);
      case '$lt': return typeof value === 'number' && n < (expected as number);
      default:
        if (key.startsWith('$')) throw new Error(`mock does not implement ${key}`);
        return value !== null && typeof value === 'object' && matchesFilter((value as Record<string, unknown>)[key], expected);
    }
  });
}

export class MockOutpost {
  readonly tenants = new Set<string>();
  readonly destinations = new Map<string, OutpostDestination & { tenant_id: string }>();
  readonly published: PublishRequest[] = [];
  readonly deliveries: MockDelivery[] = [];
  readonly requests: string[] = [];
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

  /** Re-sends a past event to a destination (simulates an Outpost retry or manual retry). */
  async redeliver(eventId: string, destinationId: string) {
    const event = this.published.find((e) => e.id === eventId)!;
    await this.deliver(event, this.destinations.get(destinationId)!);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body?: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    this.requests.push(`${req.method} ${url.pathname}`);

    if (req.headers.authorization !== `Bearer ${this.apiKey}`) return send(401, { message: 'unauthorized' });

    // PUT /tenants/:t
    if (req.method === 'PUT' && parts.length === 2 && parts[0] === 'tenants') {
      const existed = this.tenants.has(parts[1]!);
      this.tenants.add(parts[1]!);
      return send(existed ? 200 : 201, { id: parts[1] });
    }

    if (parts[0] === 'tenants' && parts[2] === 'destinations') {
      const tenantId = parts[1]!;
      if (!this.tenants.has(tenantId)) return send(404, { message: 'tenant not found' });
      const destId = parts[3];
      const dest = destId ? this.destinations.get(destId) : undefined;

      if (req.method === 'POST' && !destId) {
        if (this.destinations.has(body.id)) return send(400, { message: 'destination already exists' });
        if (body.credentials?.secret && !isValidWebhookSecret(body.credentials.secret)) return send(422, { message: 'credentials.secret pattern' });
        if (body.config?.custom_headers) JSON.parse(body.config.custom_headers);
        const created = { ...body, tenant_id: tenantId, disabled_at: null };
        this.destinations.set(body.id, created);
        return send(201, created);
      }
      if (!dest || dest.tenant_id !== tenantId) return send(404, { message: 'destination not found' });
      if (req.method === 'GET' && parts.length === 4) return send(200, dest);
      if (req.method === 'PATCH') {
        if (body.type !== dest.type) return send(422, { message: 'type mismatch' });
        Object.assign(dest, {
          ...(body.topics && { topics: body.topics }),
          ...(body.filter !== undefined && { filter: body.filter }),
          ...(body.config && { config: { ...dest.config, ...body.config } }),
          ...(body.credentials && { credentials: { ...body.credentials } }),
          ...(body.metadata && { metadata: { ...dest.metadata, ...body.metadata } }),
        });
        return send(200, dest);
      }
      if (req.method === 'DELETE') {
        this.destinations.delete(dest.id);
        return send(200, { success: true });
      }
      if (req.method === 'PUT' && parts[4] === 'enable') {
        dest.disabled_at = null;
        return send(200, dest);
      }
      if (req.method === 'GET' && parts[4] === 'attempts') {
        const last = this.deliveries.filter((d) => d.destinationId === dest.id).at(-1);
        const models = last
          ? [{ id: `atm_${last.attempt}`, status: last.status < 300 ? 'success' : 'failed', time: new Date().toISOString(), code: String(last.status) }]
          : [];
        return send(200, { models, pagination: {} });
      }
    }

    if (req.method === 'POST' && url.pathname === '/publish') {
      const event = body as PublishRequest;
      if (!event.tenant_id) return send(422, { message: 'tenant_id is required' });
      if (this.seenEventIds.has(event.id)) return send(202, { id: event.id, duplicate: true, destination_ids: [] });
      this.seenEventIds.add(event.id);
      this.published.push(event);
      const outpostEvent = { id: event.id, topic: event.topic, time: event.time, metadata: event.metadata ?? {}, data: event.data };
      const matched = [...this.destinations.values()].filter(
        (d) =>
          d.tenant_id === event.tenant_id &&
          !d.disabled_at &&
          (d.topics === '*' || d.topics.includes(event.topic)) &&
          (!d.filter || Object.keys(d.filter).length === 0 || matchesFilter(outpostEvent, d.filter)),
      );
      send(202, { id: event.id, duplicate: false, destination_ids: matched.map((d) => d.id) });
      for (const dest of matched) void this.deliver(event, dest);
      return;
    }
    send(404, { message: 'not found' });
  }

  private async deliver(event: PublishRequest, dest: OutpostDestination) {
    const body = JSON.stringify(event.data);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const secrets = [dest.credentials.secret!];
      const { previous_secret, previous_secret_invalid_at } = dest.credentials;
      if (previous_secret && previous_secret_invalid_at && Date.parse(previous_secret_invalid_at) > Date.now()) secrets.push(previous_secret);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...JSON.parse(dest.config.custom_headers ?? '{}'),
        ...signStandardWebhook(secrets, event.id, body),
        'webhook-topic': event.topic,
      };
      let status = 0;
      try {
        const response = await fetch(dest.config.url, { method: 'POST', headers, body, redirect: 'manual' });
        status = response.status;
      } catch {
        status = 0;
      }
      this.deliveries.push({ eventId: event.id, destinationId: dest.id, status, attempt, headers, body });
      if (status >= 200 && status < 300) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
