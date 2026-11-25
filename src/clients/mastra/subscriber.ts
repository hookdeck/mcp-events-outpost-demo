/**
 * Mastra (`@mastra/mcp`) as an MCP Events subscriber for this demo server.
 *
 * Mastra's MCPClient subscribes with `events/subscribe` (webhook delivery) and gives you an
 * async iterable of occurrences. Its receiver (`mcp.events.handleWebhook`) verifies the Standard
 * Webhooks signature, answers the verification challenge and routes by X-MCP-Subscription-Id.
 *
 * Outpost delivers from the internet, so the callback must be a public HTTPS URL that reaches
 * this process. Use an Event Gateway MCP_EVENTS source and `hookdeck listen` (see README.md).
 *
 *   npm start -- --callback-url https://hkdk.events/<source-id> --secret whsec_...
 *
 * Env: MCP_SERVER_URL (default http://localhost:3000/mcp), MCP_TOKEN (a token from the server's
 * MCP_TOKENS), RECEIVER_PORT (default 4000).
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { MCPClient } from '@mastra/mcp';

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

const mcp = new MCPClient({
  id: 'demo-orders',
  servers: {
    orders: {
      url: new URL(process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp'),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  },
  // One secret for every subscription. Without it, Mastra generates one per subscription.
  webhook: { url: callbackUrl, secret, ...(values['ttl-ms'] && { ttlMs: Number(values['ttl-ms']) }) },
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
  const response = await mcp.events.handleWebhook(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
await new Promise<void>((resolve) => receiver.listen(port, resolve));
console.log(`[mastra] receiver listening on :${port}`);

const args: Record<string, unknown> = {};
if (values.currency !== undefined) args.currency = values.currency;
if (values['high-value'] !== undefined) args.highValue = values['high-value'];

const subscription = await mcp.events.subscribe('orders', 'order.created', args, { delivery: 'webhook' });
subscription.onError((error) => console.error(`[mastra] ${error.id}: ${error.message}`));
console.log(`[mastra] subscribed (mode ${subscription.mode}). Place an order with \`npm run order\` in the repo root. Ctrl+C to exit.`);

const shutdown = async () => {
  await subscription.cancel(); // sends events/unsubscribe
  await mcp.disconnect();
  receiver.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for await (const event of subscription) {
  const order = event.data as { orderId?: string; currency?: string; total?: number };
  console.log(`[mastra] ${event.name} ${event.eventId}: order ${order.orderId} ${order.total} ${order.currency}`);
}
