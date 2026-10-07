import { createHash, randomBytes } from 'node:crypto';
import { ORDER_CREATED, type Order } from './events.js';
import type { Outpost } from '@hookdeck/outpost-sdk';
import type { PublishResponse } from '@hookdeck/outpost-sdk/models/components';
import type { SubscriptionService } from './subscriptions.js';

const MAX_BODY_BYTES = 256 * 1024;

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
 * Tenancy: Outpost's publish API takes one `tenantId`, and each subscriber
 * principal is its own tenant, so an order is published once per tenant that
 * has a live `order.created` subscription. Within a tenant, Outpost fans the
 * event out to every destination (subscription) whose topic and filter match.
 * Outpost's idempotency key is the event id across the whole project, so each
 * tenant's copy gets its own event id.
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

  recentOrders(limit = 10): Order[] {
    return [...this.orders.values()].slice(-limit).reverse();
  }

  async placeOrder(input: PlaceOrderInput): Promise<{ order: Order; published: PublishedCopy[] }> {
    const order: Order = {
      orderId: `ord_${randomBytes(6).toString('hex')}`,
      total: input.total ?? Math.round(Math.random() * 20000) / 100,
      currency: input.currency ?? 'USD',
      itemCount: input.itemCount ?? 1,
      customerName: input.customerName ?? 'Demo Customer',
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.orderId, order);

    const published: PublishedCopy[] = [];
    for (const tenantId of this.subscriptions.liveTenants(ORDER_CREATED)) {
      const eventId = `evt_${order.orderId}_${createHash('sha256').update(tenantId).digest('hex').slice(0, 8)}`;
      // This exact object becomes the HTTP body Outpost delivers (Outpost sends the published `data` as-is).
      const envelope = { eventId, name: ORDER_CREATED, timestamp: order.createdAt, data: order, cursor: null };
      if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_BODY_BYTES) throw new Error('Event body exceeds 256 KiB');
      const response = await this.outpost.publish({
        id: eventId,
        tenantId,
        topic: ORDER_CREATED,
        eligibleForRetry: true,
        time: new Date(order.createdAt),
        data: envelope,
      });
      published.push({ tenantId, ...response });
      this.log(`published ${eventId} to ${tenantId}: ${response.destinationIds.length} matching destination(s)`);
    }
    return { order, published };
  }
}
