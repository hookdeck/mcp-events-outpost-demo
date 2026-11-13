import { createHash, randomBytes } from 'node:crypto';
import { HIGH_VALUE_THRESHOLD, ORDER_CREATED, type Order } from './events.js';
import type { Outpost } from '@hookdeck/outpost-sdk';
import type { PublishResponse } from '@hookdeck/outpost-sdk/models/components';
import type { SubscriptionService } from './subscriptions.js';

export interface PlaceOrderInput {
  total?: number;
  currency?: string;
  itemCount?: number;
  customerName?: string;
}

export interface PublishedCopy extends PublishResponse {
  tenantId: string;
}

/**
 * A fake store. Placing an order publishes `order.created` to Outpost.
 *
 * The published `data` is the order. Outpost wraps it in the MCP event
 * envelope (`eventId`, `name`, `timestamp`, `data`, `cursor`) for each
 * matching subscription, with the Outpost event ID as `eventId`.
 *
 * Tenancy: Outpost's publish API takes one `tenantId`, and each subscriber
 * principal is its own tenant, so an order is published once per tenant.
 * Within a tenant, Outpost delivers to every subscription whose event and
 * arguments match. Outpost's idempotency key is the event ID across the whole
 * project, so each tenant's copy gets its own event ID.
 */
export class DemoStore {
  private readonly orders = new Map<string, Order>();

  constructor(
    private readonly outpost: Outpost,
    private readonly subscriptions: SubscriptionService,
    private readonly log: (message: string) => void = () => {},
  ) {}

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: Order; published: PublishedCopy[] }> {
    const total = input.total ?? Math.round(Math.random() * 20000) / 100;
    const order: Order = {
      orderId: `ord_${randomBytes(6).toString('hex')}`,
      total,
      currency: input.currency ?? 'USD',
      highValue: total >= HIGH_VALUE_THRESHOLD,
      itemCount: input.itemCount ?? 1,
      customerName: input.customerName ?? 'Demo Customer',
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.orderId, order);

    const published: PublishedCopy[] = [];
    for (const tenantId of this.subscriptions.tenantIds()) {
      const eventId = `evt_${order.orderId}_${createHash('sha256').update(tenantId).digest('hex').slice(0, 8)}`;
      const response = await this.outpost.publish({
        id: eventId,
        tenantId,
        topic: ORDER_CREATED,
        eligibleForRetry: true,
        time: new Date(order.createdAt),
        data: { ...order },
      });
      published.push({ tenantId, ...response });
      this.log(`published ${eventId} to ${tenantId}: ${response.destinationIds.length} matching subscription(s)`);
    }
    return { order, published };
  }
}
