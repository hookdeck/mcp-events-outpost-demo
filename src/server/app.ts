import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerConfig } from './config.js';
import { DemoStore, type PlaceOrderInput } from './demo-store.js';
import { buildMcpServer } from './mcp.js';
import { Outpost } from '@hookdeck/outpost-sdk';
import { OutpostMcp } from './outpost-mcp.js';
import { TenantRegistry } from './store.js';
import { SubscriptionService } from './subscriptions.js';

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

const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Reads a JSON request body, or returns undefined when it isn't valid JSON or is too large. */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_MCP_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * SEP-3415 routes events/subscribe and events/unsubscribe by the Mcp-Name
 * header, which must equal params.name. The MCP SDK doesn't check it for these
 * methods (and its client doesn't send it), so check it here: a header that
 * disagrees with the body is refused with HeaderMismatch. A missing header is
 * accepted, for clients that don't send it yet.
 */
function nameHeaderMismatch(req: http.IncomingMessage, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { id, method, params } = body as { id?: unknown; method?: unknown; params?: { name?: unknown } };
  if (method !== 'events/subscribe' && method !== 'events/unsubscribe') return undefined;
  const header = req.headers['mcp-name'];
  if (header === undefined || header === params?.name) return undefined;
  return rpcError(id, -32020, 'HeaderMismatch');
}

export function createApp(config: ServerConfig, options: { log?: (message: string) => void } = {}): App {
  const log = options.log ?? ((message: string) => console.log(`[server] ${message}`));
  const outpost = new Outpost({ apiKey: config.outpost.apiKey, serverURL: config.outpost.baseUrl });
  const outpostMcp = new OutpostMcp(config.outpost.baseUrl, config.outpost.apiKey, log);
  const tenants = new TenantRegistry(config.tenantsFile);
  const subscriptions = new SubscriptionService({ config, outpost: outpostMcp, tenants, log });
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
        if (req.method !== 'POST') return await mcp(req, res);
        const body = await readJson(req);
        if (body === undefined) return json(res, 400, rpcError(null, -32700, 'Parse error'));
        const mismatch = nameHeaderMismatch(req, body);
        if (mismatch) return json(res, 400, mismatch);
        return await mcp(req, res, body);
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

  return {
    server,
    subscriptions,
    demoStore,
    listen: (port = config.port) =>
      new Promise((resolve) => server.listen(port, () => resolve((server.address() as { port: number }).port))),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
