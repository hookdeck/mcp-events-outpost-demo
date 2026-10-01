import { parseArgs } from 'node:util';

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

/** Places an order in the demo store, which publishes order.created to Outpost. */
const { values } = parseArgs({
  options: {
    total: { type: 'string' },
    currency: { type: 'string' },
    items: { type: 'string' },
    customer: { type: 'string' },
  },
});

const base = (process.env.DEMO_STORE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const response = await fetch(`${base}/demo/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    total: values.total !== undefined ? Number(values.total) : undefined,
    currency: values.currency,
    itemCount: values.items !== undefined ? Number(values.items) : undefined,
    customerName: values.customer,
  }),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exit(1);
if (Array.isArray(result.published) && result.published.length === 0) {
  console.log('No live order.created subscriptions, so nothing was published.');
}
