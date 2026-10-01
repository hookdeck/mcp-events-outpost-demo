import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Tunnel, bin, install } from 'cloudflared';
import { TUNNEL_URL_FILE, removeTunnelUrl, writeTunnelUrl } from '../src/shared/tunnel-url.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

/*
 * Dev only: a Cloudflare quick tunnel (random https://*.trycloudflare.com URL,
 * no account) to a local port.
 *
 * - Default: the test subscriber's receiver (RECEIVER_PORT), so managed Outpost
 *   can deliver to your laptop. The URL is written to .tunnel-url, which
 *   `npm run client` picks up when PUBLIC_CALLBACK_URL is empty.
 * - `--port <n>`: any other local port, for example the MCP server (PORT) so
 *   ChatGPT can connect to it. Nothing is written to .tunnel-url.
 */
const receiverPort = Number(process.env.RECEIVER_PORT ?? 4000);
const serverPort = Number(process.env.PORT ?? 3000);
const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = values.port ? Number(values.port) : receiverPort;
const isReceiver = port === receiverPort;

if (!fs.existsSync(bin)) {
  console.log(`[tunnel] downloading the cloudflared binary to ${bin}`);
  await install(bin);
}

const tunnel = Tunnel.quick(`http://localhost:${port}`);
const url = await new Promise<string>((resolve) => tunnel.once('url', resolve));
if (isReceiver) {
  writeTunnelUrl(url);
  console.log(`[tunnel] ${url} -> http://localhost:${port} (written to ${TUNNEL_URL_FILE})`);
} else {
  console.log(`[tunnel] ${url} -> http://localhost:${port}`);
  if (port === serverPort) console.log(`[tunnel] MCP endpoint: ${url}/mcp`);
}
tunnel.once('connected', () => {
  const hint = isReceiver ? ' Run `npm run client` in another terminal.' : '';
  console.log(`[tunnel] connected.${hint} Ctrl+C to stop.`);
});

const cleanUp = () => {
  if (isReceiver) removeTunnelUrl();
};
const stop = () => {
  cleanUp();
  tunnel.stop();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', (code) => {
  cleanUp();
  process.exit(code ?? 0);
});
