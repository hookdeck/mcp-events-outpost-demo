import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { createApp, type App } from '../src/server/app.js';
import type { ServerConfig } from '../src/server/config.js';
import { Subscriber, type McpEvent } from '../src/client/subscriber.js';
import { signStandardWebhook } from '../src/shared/standard-webhooks.js';
import { generateWebhookSecret } from '../src/shared/secret.js';
import { MockOutpost } from './mock-outpost.js';

/*
 * Whole flow, offline: MCP server + test subscriber + a mock Outpost that
 * signs and delivers like Outpost's Standard Webhooks mode.
 * subscribe -> challenge -> publish -> signed delivery -> verify -> refresh
 * (with secret rotation) -> unsubscribe, plus the failure paths.
 */

const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anyResult = z.record(z.string(), z.unknown());

let outpost: MockOutpost;
let app: App;
let serverUrl: string;
let storeUrl: string;
const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  port: 0,
  tokens: new Map([['tok-alice', 'alice'], ['tok-bob', 'bob']]),
  outpost: { baseUrl: outpost.baseUrl, apiKey: outpost.apiKey },
  allowLocalCallbacks: true,
  defaultTtlMs: 60 * 60 * 1000,
  maxTtlMs: 60 * 60 * 1000,
  minTtlMs: 0,
  sweepIntervalMs: 60 * 60 * 1000,
  verificationCacheTtlMs: 60 * 60 * 1000,
  verificationTimeoutMs: 1000,
  secretRotationGraceMs: 10 * 60 * 1000,
  storeFile: null,
  tenantPrefix: 'mcp_',
  ...overrides,
});

const placeOrder = async (order: Record<string, unknown>) => {
  const response = await fetch(`${storeUrl}/demo/orders`, { method: 'POST', body: JSON.stringify(order) });
  return (await response.json()) as { order: { orderId: string }; published: Array<{ tenantId: string; id: string; destination_ids: string[] }> };
};

async function rawClient(token: string) {
  const client = new Client({ name: 'raw', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

beforeAll(async () => {
  outpost = new MockOutpost();
  await outpost.start();
  app = createApp(config(), { log: () => {} });
  const port = await app.listen(0);
  serverUrl = `http://localhost:${port}/mcp`;
  storeUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await app.close();
  await outpost.stop();
});

describe('MCP Events over Outpost, end to end', () => {
  it('runs subscribe -> verify -> publish -> deliver -> refresh/rotate -> unsubscribe', async () => {
    const received: Array<{ event: McpEvent; headers: http.IncomingHttpHeaders }> = [];
    const logs: string[] = [];
    const subscriber = new Subscriber({
      serverUrl,
      token: 'tok-alice',
      eventName: 'order.created',
      arguments: { minTotal: 100, currency: 'USD' },
      onEvent: (event, headers) => received.push({ event, headers }),
      debug: true,
      log: (message) => logs.push(message),
    });

    // Subscribe: the server verifies the callback before activating it.
    const sub = await subscriber.start();
    expect(subscriber.client.getNegotiatedProtocolVersion?.()).toBe('2026-07-28');
    expect(sub.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(sub.cursor).toBeNull();
    expect(sub.truncated).toBe(false);
    expect(Date.parse(sub.refreshBefore!)).toBeGreaterThan(Date.now());
    expect(subscriber.verificationsAnswered).toHaveLength(1);
    expect(subscriber.verificationsAnswered[0]).toMatch(/^msg_verification_/);

    // Outpost now has one tenant per principal and one destination per subscription.
    expect(outpost.tenants.has('mcp_alice')).toBe(true);
    const destination = outpost.destinations.get(sub.id)!;
    expect(destination).toMatchObject({
      type: 'webhook',
      topics: ['order.created'],
      filter: { data: { data: { total: { $gte: 100 }, currency: 'USD' } } },
      config: { url: subscriber.callbackUrl },
      credentials: { secret: subscriber.currentSecret },
    });
    expect(JSON.parse(destination.config.custom_headers!)).toEqual({ 'X-MCP-Subscription-Id': sub.id });

    // A matching order is published and delivered, signed, with MCP's body shape.
    const { order, published } = await placeOrder({ total: 150, currency: 'USD', customerName: 'Ada' });
    expect(published).toEqual([expect.objectContaining({ tenantId: 'mcp_alice', destination_ids: [sub.id] })]);
    await waitFor(() => received.length === 1);
    const [{ event, headers }] = received as [typeof received[0]];
    expect(event).toMatchObject({ name: 'order.created', cursor: null, data: { orderId: order.orderId, total: 150, currency: 'USD' } });
    expect(event.eventId).toBe(published[0]!.id);
    expect(headers['webhook-id']).toBe(event.eventId);
    expect(headers['x-mcp-subscription-id']).toBe(sub.id);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);

    // A non-matching order is filtered out by Outpost.
    const small = await placeOrder({ total: 50, currency: 'USD' });
    const euro = await placeOrder({ total: 500, currency: 'EUR' });
    expect(small.published[0]!.destination_ids).toEqual([]);
    expect(euro.published[0]!.destination_ids).toEqual([]);
    await sleep(100);
    expect(received).toHaveLength(1);

    // Duplicate delivery (same webhook-id) is acknowledged but not processed twice.
    await outpost.redeliver(event.eventId, sub.id);
    await sleep(50);
    expect(received).toHaveLength(1);
    expect(outpost.deliveries.at(-1)!.status).toBe(200);

    // Forged and stale deliveries are rejected.
    const forgedBody = JSON.stringify({ ...event, eventId: 'evt_forged' });
    const forged = await fetch(subscriber.callbackUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-MCP-Subscription-Id': sub.id, ...signStandardWebhook([generateWebhookSecret()], 'evt_forged', forgedBody) },
      body: forgedBody,
    });
    expect(forged.status).toBe(401);
    const staleBody = JSON.stringify({ ...event, eventId: 'evt_stale' });
    const stale = await fetch(subscriber.callbackUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-MCP-Subscription-Id': sub.id,
        ...signStandardWebhook([subscriber.currentSecret], 'evt_stale', staleBody, new Date(Date.now() - 10 * 60 * 1000)),
      },
      body: staleBody,
    });
    expect(stale.status).toBe(401);
    expect(received).toHaveLength(1);

    // Refresh with secret rotation: same id, no new challenge, Outpost dual-signs.
    const oldSecret = subscriber.currentSecret;
    const refreshed = await subscriber.refresh({ rotateSecret: true });
    expect(refreshed.id).toBe(sub.id);
    expect(refreshed.deliveryStatus).toMatchObject({ active: true, lastError: null });
    expect(subscriber.verificationsAnswered).toHaveLength(1);
    expect(outpost.destinations.get(sub.id)!.credentials).toMatchObject({ secret: subscriber.currentSecret, previous_secret: oldSecret });
    await placeOrder({ total: 200, currency: 'USD' });
    await waitFor(() => received.length === 2);
    expect(String(received[1]!.headers['webhook-signature']).split(' ')).toHaveLength(2);
    // --debug shows which secret produced each entry; a verifier alone would pass with just the new one.
    expect(logs.some((line) => line.startsWith(`debug ${received[1]!.event.eventId}: 2 signature(s): #1 current, #2 previous; timestamp age `))).toBe(true);

    // Unsubscribe removes the destination; later orders are not published to this tenant.
    await subscriber.stop();
    expect(outpost.destinations.has(sub.id)).toBe(false);
    expect((await placeOrder({ total: 999, currency: 'USD' })).published).toEqual([]);
  });

  it('declares the events capability over server/discover and lists order.created', async () => {
    const client = await rawClient('tok-bob');
    const discover = await client.request({ method: 'server/discover', params: {} }, anyResult);
    expect(discover).toMatchObject({ supportedVersions: expect.arrayContaining(['2026-07-28']), capabilities: { events: {} } });
    const list = await client.request({ method: 'events/list', params: {} } as never, anyResult);
    expect(list.events).toEqual([expect.objectContaining({ name: 'order.created', delivery: ['webhook'] })]);
    await client.close();
  });

  it('rejects unauthenticated MCP requests', async () => {
    await expect(rawClient('wrong-token')).rejects.toThrow();
  });

  it('subscribes with an external callback URL and a fixed secret (a forwarding gateway in front of the receiver)', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const secret = generateWebhookSecret();
    const received: McpEvent[] = [];
    const subscriber = new Subscriber({
      serverUrl,
      token: 'tok-bob',
      eventName: 'order.created',
      receiverPort: port,
      // A gateway would forward to its own path; the receiver must accept it.
      callbackUrl: `http://localhost:${port}/forwarded/by/gateway`,
      secret,
      onEvent: (event) => received.push(event),
      log: () => {},
    });
    const sub = await subscriber.start();
    expect(subscriber.callbackUrl).toBe(`http://localhost:${port}/forwarded/by/gateway`);
    expect(outpost.destinations.get(sub.id)!.credentials.secret).toBe(secret);
    await placeOrder({ total: 42, currency: 'USD' });
    await waitFor(() => received.length === 1);
    await subscriber.stop();
    expect(() => new Subscriber({ serverUrl, token: 'x', eventName: 'order.created', secret: 'nope' })).toThrow(/whsec_/);
    expect(() => new Subscriber({ serverUrl, token: 'x', eventName: 'order.created', secret, rotateSecretOnRefresh: true })).toThrow(/cannot be combined/);
  });

  it('rejects requests with no token unless ANONYMOUS_PRINCIPAL is set', async () => {
    const noToken = () => new Client({ name: 'anon', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await expect(noToken().connect(new StreamableHTTPClientTransport(new URL(serverUrl)))).rejects.toThrow();

    const logs: string[] = [];
    const anonApp = createApp(config({ anonymousPrincipal: 'anon' }), { log: (message) => logs.push(message) });
    const port = await anonApp.listen(0);
    try {
      const client = noToken();
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
      const subscriber = new Subscriber({ serverUrl: `http://localhost:${port}/mcp`, token: '', eventName: 'order.created', log: () => {} });
      const sub = await subscriber.start();
      expect(sub.id).toMatch(/^sub_/);
      expect(logs.some((line) => line.startsWith('verified callback for anon '))).toBe(true);
      // The subscribe log shows the request but never the secret.
      const subscribeLog = logs.find((line) => line.startsWith('events/subscribe from anon: '))!;
      expect(subscribeLog).toContain('<whsec_ (32 bytes)>');
      expect(subscribeLog).not.toContain(subscriber.currentSecret);
      await subscriber.stop();
      await client.close();
    } finally {
      await anonApp.close();
    }
  });

  it('returns the sketch error codes for bad subscribe requests', async () => {
    const client = await rawClient('tok-bob');
    const subscribe = (params: Record<string, unknown>) => client.request({ method: 'events/subscribe', params } as never, anyResult);
    const delivery = { mode: 'webhook', url: 'http://localhost:9/hook', secret: generateWebhookSecret() };

    await expect(subscribe({ name: 'order.created', delivery: { ...delivery, secret: 'whsec_dG9vc2hvcnQ=' } })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe({ name: 'order.created', arguments: { minTotal: -5 }, delivery })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe({ name: 'order.created', delivery: { ...delivery, url: 'ftp://x' } })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe({ name: 'nope', delivery })).rejects.toMatchObject({ code: -32011, data: { kind: 'event' } });
    await expect(subscribe({ name: 'order.created', delivery: { ...delivery, mode: 'push' } })).rejects.toMatchObject({
      code: -32014,
      data: { feature: 'deliveryMode', value: 'push' },
    });
    // Nothing listening on port 9: verification can't connect.
    await expect(subscribe({ name: 'order.created', delivery })).rejects.toMatchObject({ code: -32015, data: { reason: 'connection_refused' } });
    await client.close();
  });

  it('fails with challenge_failed when the endpoint does not echo the challenge, and creates nothing', async () => {
    const liar = http.createServer((_req, res) => res.writeHead(200).end('{"challenge":"wrong"}'));
    await new Promise<void>((r) => liar.listen(0, r));
    const url = `http://localhost:${(liar.address() as { port: number }).port}/hook`;
    const client = await rawClient('tok-bob');
    const before = outpost.destinations.size;
    await expect(
      client.request({ method: 'events/subscribe', params: { name: 'order.created', delivery: { mode: 'webhook', url, secret: generateWebhookSecret() } } } as never, anyResult),
    ).rejects.toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
    expect(outpost.destinations.size).toBe(before);
    await client.close();
    liar.close();
  });

  it('is idempotent: same key -> same id, and unsubscribe of an unknown key returns {}', async () => {
    const subscriber = new Subscriber({ serverUrl, token: 'tok-bob', eventName: 'order.created', log: () => {} });
    const first = await subscriber.start();
    const again = await subscriber.subscribe();
    expect(again.id).toBe(first.id);
    expect([...outpost.destinations.values()].filter((d) => d.config.url === subscriber.callbackUrl)).toHaveLength(1);

    const client = await rawClient('tok-alice'); // a different principal can't touch bob's subscription
    const result = await client.request(
      { method: 'events/unsubscribe', params: { name: 'order.created', arguments: {}, delivery: { url: subscriber.callbackUrl } } } as never,
      anyResult,
    );
    expect(result).not.toHaveProperty('error');
    expect(outpost.destinations.has(first.id)).toBe(true);
    await client.close();
    await subscriber.stop();
    expect(outpost.destinations.has(first.id)).toBe(false);
  });

  it('sweeps expired subscriptions from Outpost', async () => {
    const subscriber = new Subscriber({ serverUrl, token: 'tok-bob', eventName: 'order.created', ttlMs: 1, log: () => {} });
    const sub = await subscriber.start();
    expect(outpost.destinations.has(sub.id)).toBe(true);
    await sleep(5);
    expect(app.subscriptions.liveTenants()).not.toContain('mcp_bob');
    expect(await app.subscriptions.sweep()).toContain(sub.id);
    expect(outpost.destinations.has(sub.id)).toBe(false);
    await subscriber.stop({ unsubscribe: false });
  });
});
