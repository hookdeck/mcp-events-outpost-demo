import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/shared/canonical-json.js';
import { deriveSubscriptionId, tenantIdFor } from '../src/server/identity.js';

const url = 'https://receiver.example.com/hooks/1';

describe('subscription identity', () => {
  it('is deterministic and has the sub_ + 32 hex format', () => {
    const a = deriveSubscriptionId('alice', url, 'order.created', { minTotal: 100 });
    expect(a).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(deriveSubscriptionId('alice', url, 'order.created', { minTotal: 100 })).toBe(a);
  });

  it('ignores argument key order (canonical JSON)', () => {
    expect(deriveSubscriptionId('alice', url, 'order.created', { minTotal: 1, currency: 'USD' })).toBe(
      deriveSubscriptionId('alice', url, 'order.created', { currency: 'USD', minTotal: 1 }),
    );
  });

  it('changes when any key component changes', () => {
    const base = deriveSubscriptionId('alice', url, 'order.created', {});
    expect(deriveSubscriptionId('bob', url, 'order.created', {})).not.toBe(base);
    expect(deriveSubscriptionId('alice', `${url}x`, 'order.created', {})).not.toBe(base);
    expect(deriveSubscriptionId('alice', url, 'order.updated', {})).not.toBe(base);
    expect(deriveSubscriptionId('alice', url, 'order.created', { minTotal: 0 })).not.toBe(base);
  });

  it('canonical JSON sorts nested keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('derives readable tenant ids for simple principals and hashed ones otherwise', () => {
    expect(tenantIdFor('mcp_', 'alice')).toBe('mcp_alice');
    expect(tenantIdFor('mcp_', 'auth0|user@example.com')).toMatch(/^mcp_[0-9a-f]{24}$/);
  });
});
