import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { DemoStore } from './demo-store.js';
import type { SubscriptionService } from './subscriptions.js';

/**
 * Builds the MCP server for one request (the 2026-07-28 revision is stateless,
 * so the SDK asks for a fresh instance per request). The SDK has no MCP Events
 * support, so the `events` capability and the three `events/*` methods are
 * registered by hand. Each method is a call to Outpost.
 */
export function buildMcpServer(deps: { subscriptions: SubscriptionService; store: DemoStore; principal?: string }): McpServer {
  const { subscriptions, store, principal } = deps;
  // `events` is the capability ChatGPT and OpenAI's guide use; SEP-3415 declares the
  // extension under `extensions`. Neither is in the SDK's ServerCapabilities type yet,
  // hence the cast.
  const capabilities = { events: {}, extensions: { 'io.modelcontextprotocol/events': {} } } as ServerCapabilities;
  const mcpServer = new McpServer({ name: 'mcp-events-outpost-demo', version: '0.2.0' }, { capabilities });

  mcpServer.registerTool(
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

  // McpServer has no API for custom methods, so register them on the low-level Server it wraps.
  const { server } = mcpServer;
  const anyParams = z.record(z.string(), z.unknown());

  server.setRequestHandler('events/list', { params: anyParams.optional() }, (params) => subscriptions.list(params));
  server.setRequestHandler('events/subscribe', { params: anyParams }, (params) => subscriptions.subscribe(principal, params));
  server.setRequestHandler('events/unsubscribe', { params: anyParams }, (params) => subscriptions.unsubscribe(principal, params));

  return mcpServer;
}
