import { createHash } from 'node:crypto';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * One Outpost tenant per authenticated principal, so one user's subscriptions
 * stay separate from another's. Readable when the principal is a simple slug.
 * The agent never sends the tenant: the server derives it from its own
 * authentication of the request.
 */
export function tenantIdFor(prefix: string, principal: string): string {
  return /^[A-Za-z0-9_-]{1,48}$/.test(principal) ? `${prefix}${principal}` : `${prefix}${sha256(principal).slice(0, 24)}`;
}
