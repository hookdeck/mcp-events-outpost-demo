/**
 * The Vercel AI SDK (`@ai-sdk/mcp`) as an MCP Events subscriber for this demo server.
 *
 * `experimental_createMCPClient` subscribes with `events/subscribe` (webhook delivery).
 * `experimental_createMCPEventWebhook` is the receiver: it verifies the Standard Webhooks
 * signature, answers the verification challenge and routes by the `mcp_event_subscription` query
 * parameter that the client adds to the callback URL. The SDK does not refresh leases or
 * deduplicate, so this file does both. Needs @ai-sdk/mcp 2.0.105 or later (see README.md).
 *
 * Outpost delivers from the internet, so the callback must be a public HTTPS URL that reaches this
 * process. Use an Event Gateway MCP_EVENTS source and `hookdeck listen` (see README.md).
 *
 *   npm start -- --callback-url https://hkdk.events/<source-id> --secret whsec_...
 *
 * Env: MCP_SERVER_URL (default http://localhost:3000/mcp), MCP_TOKEN (a token from the server's
 * MCP_TOKENS), RECEIVER_PORT (default 4000).
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import {
  experimental_createMCPClient as createMCPClient,
  experimental_createMCPEventWebhook as createMCPEventWebhook,
  type Experimental_MCPEventStore as MCPEventStore,
  type Experimental_MCPEventSubscription as MCPEventSubscription,
} from '@ai-sdk/mcp';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no repo-root .env; rely on the environment
}

const { values } = parseArgs({
  options: {
    'callback-url': { type: 'string' },
    secret: { type: 'string' },
    currency: { type: 'string' },
    'high-value': { type: 'boolean' },
    'ttl-ms': { type: 'string' },
  },
});

const callbackUrl = values['callback-url'];
const secret = values.secret ?? (process.env.SUBSCRIBER_SECRET || undefined);
const token = process.env.MCP_TOKEN;
const port = Number(process.env.RECEIVER_PORT ?? 4000);
if (!callbackUrl || !secret) throw new Error('--callback-url and --secret (the MCP_EVENTS source URL and its whsec_ secret) are required');
if (!token) throw new Error('MCP_TOKEN is not set (a token from the demo server MCP_TOKENS)');

// Holds each subscription's secret and routing key. In-memory is for development; keep a durable
// store on the server in production.
const records = new Map<string, MCPEventSubscription>();
const store: MCPEventStore = {
  async get(key) { return records.get(key); },
  async getById(id) { return [...records.values()].find((record) => record.id === id); },
  async set(subscription) { records.set(subscription.key, structuredClone(subscription)); },
  async update(key, patch) {
    const current = records.get(key);
    if (current) records.set(key, { ...current, ...patch });
  },
  async delete(key) { records.delete(key); },
};

// Outpost and Event Gateway retries re-send the same event, and the SDK calls onEvent again each
// time, so skip a (subscription, eventId) pair that has already been handled.
const handled = new Set<string>();

const webhook = createMCPEventWebhook({
  store,
  onEvent: async ({ subscription, event }) => {
    const id = `${subscription.id}:${event.eventId}`;
    if (handled.has(id)) return;
    handled.add(id);
    const order = event.data as { orderId?: string; currency?: string; total?: number };
    console.log(`[vercel-ai-sdk] ${event.name} ${event.eventId}: order ${order.orderId} ${order.total} ${order.currency}`);
  },
  onGap: async ({ subscription }) => console.warn(`[vercel-ai-sdk] gap on ${subscription.id}: events were missed`),
  onTerminated: async ({ subscription, termination }) => console.warn(`[vercel-ai-sdk] ${subscription.id} terminated: ${termination.error.message}`),
  onError: (error) => console.error(`[vercel-ai-sdk] webhook: ${(error as Error).message}`),
});

// The route that `callbackUrl` forwards to. Deliveries are authenticated by their signature.
const receiver = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = await webhook(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
await new Promise<void>((resolve) => receiver.listen(port, resolve));
console.log(`[vercel-ai-sdk] receiver listening on :${port}`);

const mcp = await createMCPClient({
  transport: { type: 'http', url: process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp', headers: { Authorization: `Bearer ${token}` } },
  experimental_events: { store },
});

const args: Record<string, unknown> = {};
if (values.currency !== undefined) args.currency = values.currency;
if (values['high-value'] !== undefined) args.highValue = values['high-value'];

// One secret for every subscription. Without `secret`, the SDK generates one per subscription.
const result = await mcp.experimental_events.subscribe({
  name: 'order.created',
  arguments: args as never,
  delivery: { mode: 'webhook', url: callbackUrl, secret },
  ...(values['ttl-ms'] && { ttlMs: Number(values['ttl-ms']) }),
});
// The result does not carry the store key; the SDK stores the subscription under it.
const key = (await store.getById(result.id))!.key;
console.log(`[vercel-ai-sdk] subscribed (${result.id}). Place an order with \`npm run order\` in the repo root. Ctrl+C to exit.`);

// The SDK does not renew leases, and the receiver answers 410 once `refreshBefore` has passed.
// Refresh before the lease ends: 60 s early, or 20% of the lease when that is shorter.
let refreshTimer: NodeJS.Timeout;
const scheduleRefresh = (refreshBefore: string | null | undefined) => {
  const lease = refreshBefore ? Date.parse(refreshBefore) - Date.now() : 30 * 60_000;
  refreshTimer = setTimeout(async () => {
    try {
      const renewed = await mcp.experimental_events.refresh({ key });
      scheduleRefresh(renewed.refreshBefore);
    } catch (error) {
      console.error(`[vercel-ai-sdk] refresh failed: ${(error as Error).message}`);
    }
  }, Math.max(lease - Math.min(60_000, lease * 0.2), 1_000));
};
scheduleRefresh(result.refreshBefore);

const shutdown = async () => {
  clearTimeout(refreshTimer);
  await mcp.experimental_events.unsubscribe({ key }).catch((error) => console.error(`[vercel-ai-sdk] unsubscribe failed: ${error.message}`));
  await mcp.close();
  receiver.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
