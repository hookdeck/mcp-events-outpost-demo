import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerConfig } from './config.js';
import { DemoStore, type PlaceOrderInput } from './demo-store.js';
import { buildMcpServer } from './mcp.js';
import { Outpost } from '@hookdeck/outpost-sdk';
import { SubscriptionStore } from './store.js';
import { SubscriptionService, type SubscriptionServiceDeps } from './subscriptions.js';

export interface App {
  server: http.Server;
  subscriptions: SubscriptionService;
  demoStore: DemoStore;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

/** The JSON-RPC method, from the MCP-Method header when the client sends one (2026-07-28), for request logging. */
function mcpMethod(req: http.IncomingMessage): string {
  return String(req.headers['mcp-method'] ?? '-');
}

export function createApp(
  config: ServerConfig,
  overrides: Partial<Pick<SubscriptionServiceDeps, 'verify' | 'now'>> & { log?: (message: string) => void } = {},
): App {
  const log = overrides.log ?? ((message: string) => console.log(`[server] ${message}`));
  const outpost = new Outpost({ apiKey: config.outpost.apiKey, serverURL: config.outpost.baseUrl });
  const store = new SubscriptionStore(config.storeFile);
  const subscriptions = new SubscriptionService({ config, store, outpost, log, ...overrides });
  const demoStore = new DemoStore(outpost, subscriptions, log);

  const mcp = toNodeHandler(
    createMcpHandler((ctx) => buildMcpServer({ subscriptions, store: demoStore, principal: ctx.authInfo?.clientId })),
  );

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (pathname === '/mcp') {
        // Demo-only bearer auth. Production servers (and ChatGPT) need OAuth.
        const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        // DEV ONLY: with ANONYMOUS_PRINCIPAL set, a request with no token at all acts as that principal.
        const principal = token ? config.tokens.get(token) : config.anonymousPrincipal;
        if (config.logMcpRequests) log(`${req.method} /mcp ${principal ?? '(unauthorized)'} ${mcpMethod(req)} ua=${req.headers['user-agent'] ?? '-'}`);
        if (!principal) {
          return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        }
        (req as http.IncomingMessage & { auth?: unknown }).auth = { token: token ?? '', clientId: principal, scopes: [] };
        return await mcp(req, res);
      }

      if (pathname === '/demo/orders' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const input = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as PlaceOrderInput;
        return json(res, 201, await demoStore.placeOrder(input));
      }

      if (pathname === '/healthz') return json(res, 200, { ok: true });
      json(res, 404, { error: 'not found' });
    } catch (error) {
      log(`request error on ${pathname}: ${(error as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: (error as Error).message });
    }
  });

  const sweeper = setInterval(() => void subscriptions.sweep(), config.sweepIntervalMs);
  sweeper.unref();

  return {
    server,
    subscriptions,
    demoStore,
    listen: (port = config.port) =>
      new Promise((resolve) => server.listen(port, () => resolve((server.address() as { port: number }).port))),
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
