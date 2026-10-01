import * as z from 'zod';

/**
 * The event catalog. One event type: `order.created` from a fake demo store.
 *
 * Subscription arguments are validated with zod and turned into an Outpost
 * destination filter, so Outpost (not this server) decides which subscriptions
 * an order is delivered to.
 */

export const ORDER_CREATED = 'order.created';

export const orderCreatedArguments = z
  .object({
    minTotal: z.number().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code such as USD').optional(),
  })
  .strict();

export type OrderCreatedArguments = z.infer<typeof orderCreatedArguments>;

export interface Order {
  orderId: string;
  total: number;
  currency: string;
  itemCount: number;
  customerName: string;
  createdAt: string;
}

export interface EventDefinition {
  name: string;
  description: string;
  delivery: Array<'webhook' | 'poll' | 'push'>;
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

export const orderCreatedDefinition: EventDefinition = {
  name: ORDER_CREATED,
  description:
    'Fires when a new order is placed in the demo store. Optionally filter by minimum order total and currency.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      minTotal: {
        type: 'number',
        minimum: 0,
        description: 'Only deliver orders whose total is greater than or equal to this amount.',
      },
      currency: {
        type: 'string',
        pattern: '^[A-Z]{3}$',
        description: 'Only deliver orders in this ISO 4217 currency, for example USD.',
      },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      total: { type: 'number', description: 'Order total in major units, for example 129.99' },
      currency: { type: 'string' },
      itemCount: { type: 'integer' },
      customerName: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['orderId', 'total', 'currency', 'itemCount', 'customerName', 'createdAt'],
    additionalProperties: false,
  },
};

export const eventCatalog: EventDefinition[] = [orderCreatedDefinition];

export function findEvent(name: string): EventDefinition | undefined {
  return eventCatalog.find((event) => event.name === name);
}

/**
 * Maps `order.created` arguments to an Outpost destination filter.
 *
 * Outpost evaluates filters against `{ id, topic, time, metadata, data }`
 * where `data` is the published payload. We publish the whole MCP event
 * envelope `{ eventId, name, timestamp, data, cursor }` as Outpost's `data`
 * (so the delivered body is exactly what MCP Events expects), which is why the
 * order fields sit under `data.data`.
 *
 * Returns null when there is nothing to filter on (deliver every order).
 */
export function argumentsToOutpostFilter(args: OrderCreatedArguments): Record<string, unknown> | null {
  const order: Record<string, unknown> = {};
  if (args.minTotal !== undefined) order.total = { $gte: args.minTotal };
  if (args.currency !== undefined) order.currency = args.currency;
  return Object.keys(order).length > 0 ? { data: { data: order } } : null;
}
