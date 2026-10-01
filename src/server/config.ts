export interface ServerConfig {
  port: number;
  /** Bearer token -> principal. Demo-only; production MCP servers use OAuth. */
  tokens: Map<string, string>;
  /**
   * DEV ONLY: principal for /mcp requests with no Authorization header, so a
   * client without OAuth (ChatGPT developer mode, "No Authentication") can
   * subscribe. Unset or empty disables it.
   */
  anonymousPrincipal?: string;
  /** Log the JSON-RPC method and user agent of every /mcp request. */
  logMcpRequests?: boolean;
  outpost: { baseUrl: string; apiKey: string };
  /** DEV ONLY: allow http:// and private/loopback callback URLs. */
  allowLocalCallbacks: boolean;
  defaultTtlMs: number;
  maxTtlMs: number;
  minTtlMs: number;
  sweepIntervalMs: number;
  verificationCacheTtlMs: number;
  verificationTimeoutMs: number;
  secretRotationGraceMs: number;
  /** JSON file for subscription metadata, or null to keep it in memory only. */
  storeFile: string | null;
  tenantPrefix: string;
}

export const DEFAULT_OUTPOST_API_BASE_URL = 'https://api.outpost.hookdeck.com/2025-07-01';

export function parseTokens(value: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of (value ?? '').split(',')) {
    const [token, principal] = pair.split('=').map((part) => part?.trim());
    if (token && principal) tokens.set(token, principal);
  }
  return tokens;
}

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const apiKey = env.OUTPOST_API_KEY ?? '';
  if (!apiKey) throw new Error('OUTPOST_API_KEY is not set. Copy .env.example to .env and add your Outpost API key.');
  const tokens = parseTokens(env.MCP_TOKENS);
  if (tokens.size === 0) throw new Error('MCP_TOKENS is empty. Set at least one token=principal pair.');

  return {
    port: int(env.PORT, 3000),
    tokens,
    anonymousPrincipal: env.ANONYMOUS_PRINCIPAL || undefined,
    logMcpRequests: env.LOG_MCP_REQUESTS === 'true',
    outpost: { baseUrl: (env.OUTPOST_API_BASE_URL || DEFAULT_OUTPOST_API_BASE_URL).replace(/\/$/, ''), apiKey },
    allowLocalCallbacks: env.ALLOW_LOCAL_CALLBACKS === 'true',
    defaultTtlMs: int(env.SUBSCRIPTION_DEFAULT_TTL_MS, 60 * 60 * 1000),
    maxTtlMs: int(env.SUBSCRIPTION_MAX_TTL_MS, 60 * 60 * 1000),
    minTtlMs: int(env.SUBSCRIPTION_MIN_TTL_MS, 60 * 1000),
    sweepIntervalMs: int(env.SWEEP_INTERVAL_MS, 30 * 1000),
    verificationCacheTtlMs: int(env.VERIFICATION_CACHE_TTL_MS, 24 * 60 * 60 * 1000),
    verificationTimeoutMs: int(env.VERIFICATION_TIMEOUT_MS, 5000),
    secretRotationGraceMs: int(env.SECRET_ROTATION_GRACE_MS, 10 * 60 * 1000),
    storeFile: env.STORE_FILE === '' ? null : (env.STORE_FILE ?? 'data/subscriptions.json'),
    tenantPrefix: env.OUTPOST_TENANT_PREFIX ?? 'mcp_',
  };
}
