import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateWebhookSecret } from '../../shared/secret.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

/*
 * Prepares Hermes Agent as an MCP Events subscriber:
 *  1. creates an Event Gateway MCP_EVENTS source (and a CLI destination) with a new signing secret,
 *  2. writes Hermes's config.yaml and .env under HERMES_HOME, with the source URL as the public
 *     callback base and the MCP server registered with `events: true`.
 *
 * Why an Event Gateway source: Outpost delivers from the internet, so Hermes's webhook listener
 * needs a public https URL. An MCP_EVENTS source answers Outpost's verification challenge and
 * `hookdeck listen` forwards the deliveries to the listener on localhost.
 *
 *   npm run hermes:setup            create the source, write the Hermes config
 *   npm run hermes:setup -- --delete   remove the source and connection
 */
const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: process.env.HERMES_EXAMPLE_DIR ?? '.hermes-example' },
    name: { type: 'string', default: 'mcp-events-hermes' },
    port: { type: 'string', default: '4840' }, // Hermes's webhook listener
    'mcp-url': { type: 'string', default: process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp' },
    token: { type: 'string', default: process.env.MCP_TOKEN ?? 'dev-token-alice' },
    delete: { type: 'boolean', default: false },
  },
});

const apiKey = process.env.HOOKDECK_API_KEY;
if (!apiKey) throw new Error('Set HOOKDECK_API_KEY (an Event Gateway project API key) in .env or the environment');
const API = 'https://api.hookdeck.com/2026-09-01';
const home = path.resolve(values.dir!, 'home');
const stateFile = path.resolve(values.dir!, 'state.json');

async function api(method: string, route: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

if (values.delete) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await api('DELETE', `/connections/${state.connectionId}`);
  console.log(`[setup] deleted connection ${state.connectionId}`);
  process.exit(0);
}

const secret = generateWebhookSecret();
const connection = await api('POST', '/connections', {
  name: `${values.name}-conn`,
  source: { name: `${values.name}-src`, type: 'MCP_EVENTS', config: { auth: { webhook_secret_key: secret } } },
  destination: { name: `${values.name}-dest`, type: 'CLI', config: { path: '/' } },
});
const sourceUrl: string = connection.source.url;

fs.mkdirSync(home, { recursive: true });
// A Hermes MCP server entry. `events: true` registers list_event_types, subscribe_event and
// unsubscribe_event for it. platforms.webhook.extra.public_url is the callback base: Hermes appends
// /webhooks/<route> to it, so the Event Gateway source URL (which has a path) works as the base.
fs.writeFileSync(
  path.join(home, 'config.yaml'),
  [
    'mcp_servers:',
    '  demo:',
    `    url: "${values['mcp-url']}"`,
    '    headers:',
    '      Authorization: "Bearer ${MCP_TOKEN}"',
    '    events: true',
    'platforms:',
    '  webhook:',
    '    enabled: true',
    '    extra:',
    `      port: ${values.port}`,
    '      host: "127.0.0.1"',
    `      public_url: "${sourceUrl}"`,
    '',
  ].join('\n'),
);
const envFile = path.join(home, '.env');
const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => !l.startsWith('MCP_TOKEN=')) : [];
fs.writeFileSync(envFile, [...existing.filter(Boolean), `MCP_TOKEN=${values.token}`, ''].join('\n'), { mode: 0o600 });
// The secret is kept for subscribe.py, which gives it to the subscription (see there).
fs.writeFileSync(stateFile, JSON.stringify({ connectionId: connection.id, sourceName: `${values.name}-src`, sourceUrl, secret }, null, 2), { mode: 0o600 });

console.log(`[setup] Event Gateway source: ${sourceUrl}`);
console.log(`[setup] Hermes config: ${path.join(home, 'config.yaml')}`);
console.log(`[setup] next: hookdeck listen ${values.port} ${values.name}-src`);
