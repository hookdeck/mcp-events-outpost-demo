import { describe, expect, it } from 'vitest';
import { argumentsToOutpostFilter, orderCreatedArguments } from '../src/server/events.js';
import { matchesFilter } from './mock-outpost.js';

const outpostEvent = (total: number, currency: string) => ({
  id: 'evt_1',
  topic: 'order.created',
  metadata: {},
  data: { eventId: 'evt_1', name: 'order.created', timestamp: 'x', cursor: null, data: { orderId: 'ord_1', total, currency } },
});

describe('order.created arguments', () => {
  it('accepts empty, minTotal, and currency arguments', () => {
    expect(orderCreatedArguments.safeParse({}).success).toBe(true);
    expect(orderCreatedArguments.safeParse({ minTotal: 10, currency: 'USD' }).success).toBe(true);
  });

  it.each([[{ minTotal: -1 }], [{ minTotal: '10' }], [{ currency: 'usd' }], [{ currency: 'DOLLARS' }], [{ unknown: true }]])(
    'rejects %j',
    (args) => expect(orderCreatedArguments.safeParse(args).success).toBe(false),
  );
});

describe('arguments to Outpost filter', () => {
  it('returns null when there is nothing to filter on', () => {
    expect(argumentsToOutpostFilter({})).toBeNull();
  });

  it('maps minTotal to $gte and currency to equality under data.data', () => {
    expect(argumentsToOutpostFilter({ minTotal: 100, currency: 'USD' })).toEqual({
      data: { data: { total: { $gte: 100 }, currency: 'USD' } },
    });
  });

  it('matches the intended orders when evaluated Outpost-style', () => {
    const filter = argumentsToOutpostFilter({ minTotal: 100, currency: 'USD' });
    expect(matchesFilter(outpostEvent(150, 'USD'), filter)).toBe(true);
    expect(matchesFilter(outpostEvent(100, 'USD'), filter)).toBe(true);
    expect(matchesFilter(outpostEvent(99.99, 'USD'), filter)).toBe(false);
    expect(matchesFilter(outpostEvent(150, 'EUR'), filter)).toBe(false);
  });
});
