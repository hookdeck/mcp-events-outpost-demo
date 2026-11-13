import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_OUTPOST_API_BASE_URL } from '../src/server/config.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

/*
 * Checks that Outpost serves this demo's MCP Events: MCP Events is on, and
 * `events/list` offers `order.created` from mcp-events.json.
 *
 * With --apply, sets them through managed Outpost's Config API:
 *   EXPERIMENTAL_MCP_ENABLED=true, EXPERIMENTAL_MCP_EVENTS_SCHEMA=<mcp-events.json>,
 *   and `order.created` in TOPICS.
 * Self-hosted Outpost has no Config API: set the same names as environment
 * variables (EXPERIMENTAL_MCP_EVENTS_SCHEMA can be the path of the file).
 */
const EVENTS_FILE = new URL('../mcp-events.json', import.meta.url);
const EVENT = 'order.created';
const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });

const apiKey = process.env.OUTPOST_API_KEY;
if (!apiKey) throw new Error('OUTPOST_API_KEY is not set');
const baseUrl = (process.env.OUTPOST_API_BASE_URL || DEFAULT_OUTPOST_API_BASE_URL).replace(/\/$/, '');
const headers = { Authorization: `Bearer ${apiKey}` };

async function check(): Promise<boolean> {
  const response = await fetch(`${baseUrl}/mcp/events/list`, { headers });
  if (response.status === 404) {
    console.log('MCP Events: off (GET /mcp/events/list answered 404). Outpost v1.9.0 or later with EXPERIMENTAL_MCP_ENABLED=true is required.');
    return false;
  }
  if (response.status === 503) {
    console.log('MCP Events: on, but the event definitions are invalid (503). Check the Outpost logs.');
    return false;
  }
  if (!response.ok) throw new Error(`GET /mcp/events/list failed with HTTP ${response.status}: ${await response.text()}`);
  const { events } = (await response.json()) as { events: Array<{ name: string }> };
  const names = events.map((event) => event.name);
  const ok = names.includes(EVENT);
  console.log(`MCP Events: on. events/list offers ${names.join(', ') || '(none)'} ${ok ? 'OK' : `-> needs ${EVENT}`}`);
  return ok;
}

if (await check()) process.exit(0);
if (!values.apply) {
  console.log('\nRun `npm run outpost:check -- --apply` to set them on managed Outpost.');
  console.log('On self-hosted Outpost, set EXPERIMENTAL_MCP_ENABLED=true, EXPERIMENTAL_MCP_EVENTS_SCHEMA=<path to mcp-events.json>');
  console.log(`and add ${EVENT} to TOPICS, then restart Outpost.`);
  process.exit(1);
}

// Managed Outpost only: the Config API.
const config = await fetch(`${baseUrl}/config`, { headers });
if (!config.ok) {
  throw new Error(`GET /config answered HTTP ${config.status}. The Config API is managed Outpost only; on self-hosted Outpost, set the environment variables above.`);
}
const current = (await config.json()) as Record<string, string | null>;
const topics = (current.TOPICS ?? '').split(',').map((topic) => topic.trim()).filter(Boolean);
const update: Record<string, string> = {
  EXPERIMENTAL_MCP_ENABLED: 'true',
  // Inline JSON: managed Outpost takes the value, not a file path.
  EXPERIMENTAL_MCP_EVENTS_SCHEMA: JSON.stringify(JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'))),
};
if (!topics.includes(EVENT)) update.TOPICS = [...topics, EVENT].join(',');

const patched = await fetch(`${baseUrl}/config`, {
  method: 'PATCH',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify(update),
});
if (!patched.ok) throw new Error(`PATCH /config failed with HTTP ${patched.status}: ${await patched.text()}`);
console.log(`\nUpdated ${Object.keys(update).join(', ')}. The deployment restarts with the new settings; run this check again in a minute.`);
