import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { signStandardWebhook } from '../shared/standard-webhooks.js';
import type { CallbackFailureReason } from './errors.js';

/*
 * Callback URL safety (SSRF) and endpoint verification.
 *
 * Outpost performs event deliveries; this server only makes one kind of
 * outbound request itself: the verification challenge sent before a
 * subscription is activated. That request follows the MCP Events rules:
 * https only, non-public addresses blocked, the address checked at connect
 * time (so DNS rebinding can't swap it), and redirects never followed.
 * `allowLocal` (ALLOW_LOCAL_CALLBACKS=true) relaxes the first two for local dev.
 */

// IANA special-purpose ranges that are not globally reachable.
const blockedV4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(network, prefix, 'ipv4');

const globalUnicastV6 = new net.BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

const blockedV6 = new net.BlockList();
for (const [network, prefix] of [
  ['2001::', 23], // IETF protocol assignments (includes Teredo)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 can embed private IPv4 addresses
] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

/** True when the address is globally routable (not loopback, private, link-local, documentation, and so on). */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return globalUnicastV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  }
  return false;
}

/** A callback URL that is statically invalid or points at a blocked address. Maps to InvalidParams. */
export class CallbackUrlError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

export function parseCallbackUrl(raw: unknown, { allowLocal }: { allowLocal: boolean }): URL {
  if (typeof raw !== 'string') throw new CallbackUrlError('delivery.url must be a string', 'invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlError('delivery.url is not a valid URL', 'invalid_url');
  }
  const httpAllowed = allowLocal && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpAllowed) {
    throw new CallbackUrlError('delivery.url must use https', 'https_required');
  }
  if (url.username || url.password) {
    throw new CallbackUrlError('delivery.url must not contain credentials', 'invalid_url');
  }
  return url;
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

/** Subscribe-time check: every address the host resolves to must be public (unless allowLocal). */
export async function assertPublicHost(url: URL, { allowLocal }: { allowLocal: boolean }): Promise<void> {
  if (allowLocal) return;
  const host = hostOf(url);
  const addresses = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new CallbackUrlError('delivery.url resolves to a non-public address', 'callback_address_not_allowed');
  }
}

class BlockedAddressError extends Error {
  code = 'EADDRBLOCKED';
}

/**
 * A dns.lookup replacement used for the outbound connection itself: the socket
 * connects to the address validated here, while TLS still uses the original
 * hostname for SNI and certificate checks.
 */
function safeLookup(allowLocal: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as dns.LookupAddress[];
      if (!allowLocal && (list.length === 0 || list.some((a) => !isPublicAddress(a.address)))) {
        return callback(new BlockedAddressError(`Blocked non-public address for ${hostname}`), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface PostResult {
  status: number;
  body: string;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

/** POSTs a body with the SSRF rules applied. Never follows redirects (node:http doesn't). */
export function postToCallback(
  url: URL,
  body: string,
  headers: Record<string, string>,
  { allowLocal, timeoutMs }: { allowLocal: boolean; timeoutMs: number },
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const host = hostOf(url);
    if (!allowLocal && net.isIP(host) && !isPublicAddress(host)) {
      return reject(new BlockedAddressError(`Blocked non-public address ${host}`));
    }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      lookup: safeLookup(allowLocal),
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

/** Maps a network error to one of the categories MCP Events allows. Never leaks endpoint details. */
export function classifyNetworkError(error: unknown): CallbackFailureReason {
  const code = String((error as { code?: string })?.code ?? '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return 'tls_error';
  }
  return 'connection_refused';
}

export type VerificationResult = { ok: true } | { ok: false; reason: CallbackFailureReason };

export interface VerifyEndpointOptions {
  url: URL;
  secret: string;
  subscriptionId: string;
  allowLocal: boolean;
  timeoutMs: number;
}

/**
 * Endpoint verification (anti-flooding): POST a signed `verification` control
 * envelope with a single-use challenge. The endpoint proves it wants the
 * deliveries by answering 2xx with `{"challenge": "<same value>"}`.
 */
export async function verifyEndpoint(options: VerifyEndpointOptions): Promise<VerificationResult> {
  const challenge = randomBytes(24).toString('base64url');
  const msgId = `msg_verification_${randomBytes(12).toString('hex')}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  const headers = {
    ...signStandardWebhook([options.secret], msgId, body),
    'X-MCP-Subscription-Id': options.subscriptionId,
  };

  let result: PostResult;
  try {
    result = await postToCallback(options.url, body, headers, options);
  } catch (error) {
    return { ok: false, reason: classifyNetworkError(error) };
  }

  if (result.status >= 500) return { ok: false, reason: 'http_5xx' };
  if (result.status >= 400) return { ok: false, reason: 'http_4xx' };
  if (result.status < 200 || result.status >= 300) return { ok: false, reason: 'challenge_failed' };

  let echoed: unknown;
  try {
    echoed = (JSON.parse(result.body) as { challenge?: unknown })?.challenge;
  } catch {
    return { ok: false, reason: 'challenge_failed' };
  }
  if (typeof echoed !== 'string') return { ok: false, reason: 'challenge_failed' };
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(echoed);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'challenge_failed' };
  }
  return { ok: true };
}
