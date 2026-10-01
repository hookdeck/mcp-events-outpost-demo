import { parseArgs } from 'node:util';
import { DEFAULT_OUTPOST_API_BASE_URL } from '../src/server/config.js';
import { OutpostClient } from '../src/server/outpost.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

/*
 * Checks (and with --apply, sets) the two managed Outpost settings this demo needs:
 *   DESTINATIONS_WEBHOOK_MODE=standard  and  `order.created` in TOPICS.
 * Also recommends a RETRY_SCHEDULE within MCP Events' guidance (3 to 5 attempts
 * over no more than 10 to 15 minutes); --apply sets it only if none is set.
 * Uses the managed-only Config API (GET/PATCH /config).
 */
const RECOMMENDED_RETRY_SCHEDULE = '30,120,600'; // 3 retries: 4 attempts within about 12.5 minutes
const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });

const apiKey = process.env.OUTPOST_API_KEY;
if (!apiKey) throw new Error('OUTPOST_API_KEY is not set');
const outpost = new OutpostClient((process.env.OUTPOST_API_BASE_URL || DEFAULT_OUTPOST_API_BASE_URL).replace(/\/$/, ''), apiKey);

const config = await outpost.getConfig();
const topics = (config.TOPICS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const standardMode = config.DESTINATIONS_WEBHOOK_MODE === 'standard';
const hasTopic = topics.includes('order.created') || topics.includes('*');

console.log(`DESTINATIONS_WEBHOOK_MODE = ${config.DESTINATIONS_WEBHOOK_MODE ?? '(default)'} ${standardMode ? 'OK' : '-> needs "standard"'}`);
console.log(`TOPICS = ${config.TOPICS ?? '(none)'} ${hasTopic ? 'OK' : '-> needs order.created'}`);
const retrySchedule = config.RETRY_SCHEDULE;
console.log(
  `RETRY_SCHEDULE = ${retrySchedule ?? '(none)'} ${retrySchedule ? 'OK' : `-> recommended ${RECOMMENDED_RETRY_SCHEDULE} (the default allows up to ${config.MAX_RETRY_LIMIT ?? 10} retries)`}`,
);
const prefix = config.DESTINATIONS_WEBHOOK_HEADER_PREFIX;
if (prefix && prefix !== 'webhook-') console.log(`DESTINATIONS_WEBHOOK_HEADER_PREFIX = ${prefix} -> must be unset or "webhook-"`);

// The retry schedule is a recommendation, so it doesn't fail the check on its own.
if (standardMode && hasTopic && (retrySchedule || !values.apply)) process.exit(0);
if (!values.apply) {
  console.log('\nRun `npm run outpost:check -- --apply` to set these, or change them in the Hookdeck dashboard.');
  process.exit(1);
}

const update: Record<string, string> = {};
if (!standardMode) update.DESTINATIONS_WEBHOOK_MODE = 'standard';
if (!hasTopic) update.TOPICS = [...topics, 'order.created'].join(',');
if (!retrySchedule) update.RETRY_SCHEDULE = RECOMMENDED_RETRY_SCHEDULE;
const updated = await outpost.updateConfig(update);
console.log(
  '\nUpdated:',
  JSON.stringify(update),
  '\nNow:',
  JSON.stringify({ TOPICS: updated.TOPICS, DESTINATIONS_WEBHOOK_MODE: updated.DESTINATIONS_WEBHOOK_MODE, RETRY_SCHEDULE: updated.RETRY_SCHEDULE }),
);
