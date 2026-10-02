import { parseArgs } from 'node:util';
import { Subscriber } from './subscriber.js';
import { resolvePublicCallbackUrl } from '../shared/tunnel-url.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const { values } = parseArgs({
  options: {
    'min-total': { type: 'string' },
    currency: { type: 'string' },
    'ttl-ms': { type: 'string' },
    'rotate-secret': { type: 'boolean', default: false },
    'skip-timestamp-check': { type: 'boolean', default: false },
    'keep-subscription': { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false },
    'callback-url': { type: 'string' },
    secret: { type: 'string' },
  },
});

const args: Record<string, unknown> = {};
if (values['min-total'] !== undefined) args.minTotal = Number(values['min-total']);
if (values.currency !== undefined) args.currency = values.currency;

const token = process.env.MCP_TOKEN;
if (!token) throw new Error('MCP_TOKEN is not set (see .env.example)');

const subscriber = new Subscriber({
  serverUrl: process.env.MCP_SERVER_URL ?? 'http://localhost:3000/mcp',
  token,
  eventName: 'order.created',
  arguments: args,
  ttlMs: values['ttl-ms'] ? Number(values['ttl-ms']) : undefined,
  receiverPort: Number(process.env.RECEIVER_PORT ?? 4000),
  publicCallbackUrl: resolvePublicCallbackUrl(process.env.PUBLIC_CALLBACK_URL),
  callbackUrl: values['callback-url'],
  secret: values.secret ?? (process.env.SUBSCRIBER_SECRET || undefined),
  checkTimestamps: !values['skip-timestamp-check'],
  rotateSecretOnRefresh: values['rotate-secret'],
  debug: values.debug,
});

try {
  await subscriber.start();
} catch (error) {
  const { code, data, message } = error as { code?: number; data?: unknown; message: string };
  console.error(`[client] subscribe failed: ${message}${code ? ` (code ${code}, data ${JSON.stringify(data)})` : ''}`);
  await subscriber.stop({ unsubscribe: false }).catch(() => {});
  process.exit(1);
}
console.log('[client] waiting for events. Place an order with `npm run order`. Ctrl+C to unsubscribe and exit.');

const shutdown = async () => {
  await subscriber.stop({ unsubscribe: !values['keep-subscription'] }).catch((error) => console.error(error));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
