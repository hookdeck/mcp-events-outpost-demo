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
 * Whole flow, offline: MCP server + test subscriber + a mock Outpost with MCP
 * Events on. subscribe -> Outpost's challenge -> publish -> signed delivery ->
 * verify -> refresh (with secret rotation) -> unsubscribe, plus failure paths.
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
const HOUR_MS = 60 * 60 * 1000;

let outpost: MockOutpost;
let app: App;
let serverUrl: string;
let storeUrl: string;
const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  port: 0,
  tokens: new Map([['tok-alice', 'alice'], ['tok-bob', 'bob']]),
  outpost: { baseUrl: outpost.baseUrl, apiKey: outpost.apiKey },
  defaultTtlMs: HOUR_MS,
  maxTtlMs: 2 * HOUR_MS,
  minTtlMs: 60 * 1000,
  tenantsFile: null,
  tenantPrefix: 'mcp_',
  ...overrides,
});

const placeOrder = async (order: Record<string, unknown>) => {
  const response = await fetch(`${storeUrl}/demo/orders`, { method: 'POST', body: JSON.stringify(order) });
  return (await response.json()) as {
    order: { orderId: string; highValue: boolean };
    published: Array<{ tenantId: string; id: string; destinationIds: string[] }>;
  };
};

async function rawClient(token: string, url = serverUrl) {
  const client = new Client({ name: 'raw', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
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

describe('MCP Events with Outpost, end to end', () => {
  it('runs subscribe -> verify -> publish -> deliver -> refresh/rotate -> unsubscribe', async () => {
    const received: Array<{ event: McpEvent; headers: http.IncomingHttpHeaders }> = [];
    const logs: string[] = [];
    const subscriber = new Subscriber({
      serverUrl,
      token: 'tok-alice',
      eventName: 'order.created',
      arguments: { currency: 'USD', highValue: true },
      onEvent: (event, headers) => received.push({ event, headers }),
      debug: true,
      log: (message) => logs.push(message),
    });

    // Subscribe: Outpost verifies the callback before it stores the subscription.
    const sub = await subscriber.start();
    expect(subscriber.client.getNegotiatedProtocolVersion?.()).toBe('2026-07-28');
    expect(sub.id).toMatch(/^sub_/);
    expect(sub.cursor).toBeNull();
    expect(sub.truncated).toBe(false);
    expect(subscriber.verificationsAnswered).toHaveLength(1);
    expect(subscriber.verificationsAnswered[0]).toMatch(/^msg_verification_/);

    // The subscription lives in Outpost, in the principal's tenant, with the server's default lifetime.
    const stored = outpost.subscriptions.get(sub.id)!;
    expect(stored).toMatchObject({ tenantId: 'mcp_alice', name: 'order.created', arguments: { currency: 'USD', highValue: true } });
    expect(Math.abs(Date.parse(sub.refreshBefore!) - (Date.now() + HOUR_MS))).toBeLessThan(5000);

    // A matching order is delivered as the MCP event envelope, signed by Outpost.
    const { order, published } = await placeOrder({ total: 150, currency: 'USD', customerName: 'Ada' });
    expect(order.highValue).toBe(true);
    expect(published).toEqual([expect.objectContaining({ tenantId: 'mcp_alice', destinationIds: [sub.id] })]);
    await waitFor(() => received.length === 1);
    const [{ event, headers }] = received as [(typeof received)[0]];
    expect(event).toMatchObject({ name: 'order.created', cursor: null, data: { orderId: order.orderId, total: 150, currency: 'USD', highValue: true } });
    expect(event.eventId).toBe(published[0]!.id);
    // webhook-id identifies the delivery, not the event.
    expect(String(headers['webhook-id'])).toMatch(/^msg_/);
    expect(headers['webhook-id']).not.toBe(event.eventId);
    expect(headers['x-mcp-subscription-id']).toBe(sub.id);

    // Orders that don't match the arguments are filtered out by Outpost.
    expect((await placeOrder({ total: 50, currency: 'USD' })).published[0]!.destinationIds).toEqual([]);
    expect((await placeOrder({ total: 500, currency: 'EUR' })).published[0]!.destinationIds).toEqual([]);
    await sleep(100);
    expect(received).toHaveLength(1);

    // A retried delivery (same webhook-id) is acknowledged but not processed twice.
    await outpost.redeliver(outpost.deliveries.find((d) => d.eventId === event.eventId)!);
    await sleep(50);
    expect(received).toHaveLength(1);
    expect(outpost.deliveries.at(-1)!.status).toBe(200);

    // Forged and stale deliveries are rejected.
    const forgedBody = JSON.stringify({ ...event, eventId: 'evt_forged' });
    const forged = await fetch(subscriber.callbackUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-MCP-Subscription-Id': sub.id, ...signStandardWebhook([generateWebhookSecret()], 'msg_forged', forgedBody) },
      body: forgedBody,
    });
    expect(forged.status).toBe(401);
    const staleBody = JSON.stringify({ ...event, eventId: 'evt_stale' });
    const stale = await fetch(subscriber.callbackUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-MCP-Subscription-Id': sub.id,
        ...signStandardWebhook([subscriber.currentSecret], 'msg_stale', staleBody, new Date(Date.now() - 10 * 60 * 1000)),
      },
      body: staleBody,
    });
    expect(stale.status).toBe(401);
    expect(received).toHaveLength(1);

    // Refresh with secret rotation: same id, no new challenge, Outpost signs with both secrets.
    const refreshed = await subscriber.refresh({ rotateSecret: true });
    expect(refreshed.id).toBe(sub.id);
    expect(subscriber.verificationsAnswered).toHaveLength(1);
    await placeOrder({ total: 200, currency: 'USD' });
    await waitFor(() => received.length === 2);
    expect(String(received[1]!.headers['webhook-signature']).split(' ')).toHaveLength(2);
    expect(logs.some((line) => line.startsWith(`debug ${received[1]!.headers['webhook-id']}: 2 signature(s): #1 current, #2 previous; timestamp age `))).toBe(true);

    // Unsubscribe removes the subscription in Outpost; later orders match nothing.
    await subscriber.stop();
    expect(outpost.subscriptions.has(sub.id)).toBe(false);
    expect((await placeOrder({ total: 999, currency: 'USD' })).published).toEqual([
      expect.objectContaining({ tenantId: 'mcp_alice', destinationIds: [] }),
    ]);
  });

  it('declares the events capability over server/discover and lists the events Outpost serves', async () => {
    const client = await rawClient('tok-bob');
    const discover = await client.request({ method: 'server/discover', params: {} }, anyResult);
    expect(discover).toMatchObject({
      supportedVersions: expect.arrayContaining(['2026-07-28']),
      capabilities: { events: {}, extensions: { 'io.modelcontextprotocol/events': {} } },
    });
    const list = await client.request({ method: 'events/list', params: {} } as never, anyResult);
    expect(list.events).toEqual([expect.objectContaining({ name: 'order.created', delivery: ['webhook'] })]);
    await client.close();
  });

  it('refuses an Mcp-Name header that disagrees with params.name, and accepts a missing one', async () => {
    const post = (headers: Record<string, string>) =>
      fetch(serverUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-bob', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'events/unsubscribe', params: { name: 'order.created', delivery: { url: 'https://example.com/x' } } }),
      });
    const mismatch = await post({ 'mcp-name': 'order.updated' });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ id: 7, error: { code: -32020, message: 'HeaderMismatch' } });
    const client = await rawClient('tok-bob'); // the SDK client sends no Mcp-Name for events/*
    await expect(
      client.request({ method: 'events/unsubscribe', params: { name: 'order.created', delivery: { url: 'https://example.com/x' } } } as never, anyResult),
    ).resolves.toBeDefined();
    await client.close();
  });

  it('reports MCP Events as unavailable when Outpost has it off or its definitions are invalid', async () => {
    const client = await rawClient('tok-bob');
    try {
      for (const status of [404, 503]) {
        outpost.listStatus = status;
        await expect(client.request({ method: 'events/list', params: {} } as never, anyResult)).rejects.toMatchObject({ code: -32603 });
      }
    } finally {
      outpost.listStatus = 200;
      await client.close();
    }
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
    expect(outpost.subscriptions.get(sub.id)!.secret).toBe(secret);
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
      const subscriber = new Subscriber({ serverUrl: `http://localhost:${port}/mcp`, token: '', eventName: 'order.created', log: () => {} });
      const sub = await subscriber.start();
      expect(outpost.subscriptions.get(sub.id)!.tenantId).toBe('mcp_anon');
      expect(logs.some((line) => line.startsWith(`subscribed ${sub.id} for mcp_anon `))).toBe(true);
      expect(logs.join('\n')).not.toContain(subscriber.currentSecret);
      await subscriber.stop();
    } finally {
      await anonApp.close();
    }
  });

  it("returns Outpost's MCP Events errors for bad subscribe requests", async () => {
    const client = await rawClient('tok-bob');
    const subscribe = (params: Record<string, unknown>) => client.request({ method: 'events/subscribe', params } as never, anyResult);
    const delivery = { mode: 'webhook', url: 'http://localhost:9/hook', secret: generateWebhookSecret() };

    await expect(subscribe({ name: 'order.created', delivery: { ...delivery, secret: 'whsec_dG9vc2hvcnQ=' } })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe({ name: 'order.created', arguments: { total: 5 }, delivery })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe({ name: 'order.created', arguments: { highValue: 'yes' }, delivery })).rejects.toMatchObject({ code: -32602 });
    await expect(subscribe({ name: 'nope', delivery })).rejects.toMatchObject({ code: -32023, data: { kind: 'event' } });
    await expect(subscribe({ name: 'order.created', delivery: { ...delivery, mode: 'push' } })).rejects.toMatchObject({
      code: -32026,
      data: { feature: 'deliveryMode', value: 'push' },
    });
    await expect(subscribe({ name: 'order.created', delivery, ttlMs: 'soon' })).rejects.toMatchObject({ code: -32602 });
    // Nothing listening on port 9: Outpost's verification can't connect.
    await expect(subscribe({ name: 'order.created', delivery })).rejects.toMatchObject({ code: -32027, data: { reason: 'connection_refused' } });
    await client.close();
  });

  it('fails with challenge_failed when the endpoint does not echo the challenge, and stores nothing', async () => {
    const liar = http.createServer((_req, res) => res.writeHead(200).end('{"challenge":"wrong"}'));
    await new Promise<void>((r) => liar.listen(0, r));
    const url = `http://localhost:${(liar.address() as { port: number }).port}/hook`;
    const client = await rawClient('tok-bob');
    const before = outpost.subscriptions.size;
    await expect(
      client.request({ method: 'events/subscribe', params: { name: 'order.created', delivery: { mode: 'webhook', url, secret: generateWebhookSecret() } } } as never, anyResult),
    ).rejects.toMatchObject({ code: -32027, data: { reason: 'challenge_failed' } });
    expect(outpost.subscriptions.size).toBe(before);
    await client.close();
    liar.close();
  });

  it('is idempotent: same key -> same id, and unsubscribe of an unknown key succeeds', async () => {
    const subscriber = new Subscriber({ serverUrl, token: 'tok-bob', eventName: 'order.created', log: () => {} });
    const first = await subscriber.start();
    const again = await subscriber.subscribe();
    expect(again.id).toBe(first.id);
    expect([...outpost.subscriptions.values()].filter((s) => s.url === subscriber.callbackUrl)).toHaveLength(1);

    // A different principal is a different tenant, so it can't remove bob's subscription.
    const client = await rawClient('tok-alice');
    const result = await client.request(
      { method: 'events/unsubscribe', params: { name: 'order.created', arguments: {}, delivery: { url: subscriber.callbackUrl } } } as never,
      anyResult,
    );
    expect(result).not.toHaveProperty('error'); // resolved, not a NotFound error
    expect(outpost.subscriptions.has(first.id)).toBe(true);
    await client.close();
    await subscriber.stop();
    expect(outpost.subscriptions.has(first.id)).toBe(false);
  });

  it('applies the server lifetime policy to ttlMs before forwarding it', async () => {
    const lifetime = async (ttlMs: number | null | undefined) => {
      const subscriber = new Subscriber({ serverUrl, token: 'tok-bob', eventName: 'order.created', log: () => {} });
      // Subscriber omits ttlMs when undefined; send null and numbers through a raw request.
      await subscriber.start();
      const client = await rawClient('tok-bob');
      const result = (await client.request(
        {
          method: 'events/subscribe',
          params: {
            name: 'order.created',
            delivery: { mode: 'webhook', url: subscriber.callbackUrl, secret: subscriber.currentSecret },
            ...(ttlMs !== undefined && { ttlMs }),
          },
        } as never,
        anyResult,
      )) as { refreshBefore: string };
      await client.close();
      await subscriber.stop();
      return Date.parse(result.refreshBefore) - Date.now();
    };
    const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(5000);
    near(await lifetime(undefined), HOUR_MS); // default
    near(await lifetime(1000), 60 * 1000); // raised to the minimum
    near(await lifetime(10 * HOUR_MS), 2 * HOUR_MS); // capped at the maximum
    near(await lifetime(null), 2 * HOUR_MS); // no expiry isn't granted
  });
});
