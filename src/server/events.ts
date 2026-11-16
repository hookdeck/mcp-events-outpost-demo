/**
 * The demo store's one event: `order.created`.
 *
 * The event definition agents see in `events/list` lives in Outpost, not
 * here: `mcp-events.json` at the repo root, set as Outpost's
 * `EXPERIMENTAL_MCP_EVENTS_SCHEMA` (see `npm run outpost:check`). Outpost
 * filters on its arguments: an argument matches the top-level payload field of
 * the same name, by equality. That's why the payload carries `highValue`, so a
 * subscriber can ask for orders of 100 or more.
 */

export const ORDER_CREATED = 'order.created';

/** Orders with a total at or above this are `highValue`. */
export const HIGH_VALUE_THRESHOLD = 100;

export interface Order {
  orderId: string;
  total: number;
  currency: string;
  highValue: boolean;
  itemCount: number;
  customerName: string;
  createdAt: string;
}
