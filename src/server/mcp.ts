import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { DemoStore } from './demo-store.js';
import { eventCatalog } from './events.js';
import type { SubscriptionService } from './subscriptions.js';

/**
 * Builds the MCP server for one request (the 2026-07-28 revision is stateless,
 * so the SDK asks for a fresh instance per request). The SDK has no MCP Events
 * support, so the `events` capability and the three `events/*` methods are
 * registered by hand.
 */
export function buildMcpServer(deps: { subscriptions: SubscriptionService; store: DemoStore; principal?: string }): McpServer {
  const { subscriptions, store, principal } = deps;
  // `events` is not in the SDK's ServerCapabilities type yet, hence the cast.
  const capabilities = { events: {} } as ServerCapabilities;
  const server = new McpServer({ name: 'mcp-events-outpost-demo', version: '0.1.0' }, { capabilities });

  server.registerTool(
    'get_order',
    {
      description: 'Look up an order in the demo store by id, for example one referenced by an order.created event.',
      inputSchema: z.object({ orderId: z.string() }),
    },
    async ({ orderId }) => {
      const order = store.getOrder(orderId);
      return order
        ? { content: [{ type: 'text', text: JSON.stringify(order) }], structuredContent: { ...order } }
        : { content: [{ type: 'text', text: `No order ${orderId}` }], isError: true };
    },
  );

  const anyParams = z.record(z.string(), z.unknown());

  server.server.setRequestHandler('events/list', { params: anyParams.optional() }, async () => ({ events: eventCatalog }));

  server.server.setRequestHandler('events/subscribe', { params: anyParams }, async (params) => ({
    ...(await subscriptions.subscribe(principal, params)),
  }));

  server.server.setRequestHandler('events/unsubscribe', { params: anyParams }, async (params) =>
    subscriptions.unsubscribe(principal, params),
  );

  return server;
}
