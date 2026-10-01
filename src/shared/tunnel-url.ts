import fs from 'node:fs';

/*
 * `npm run tunnel` writes its public URL here, and the test client uses it
 * when PUBLIC_CALLBACK_URL isn't set. Gitignored; removed when the tunnel exits.
 */
export const TUNNEL_URL_FILE = '.tunnel-url';

export function readTunnelUrl(file = TUNNEL_URL_FILE): string | undefined {
  try {
    const url = fs.readFileSync(file, 'utf8').trim();
    return url.startsWith('https://') ? url : undefined;
  } catch {
    return undefined;
  }
}

export function writeTunnelUrl(url: string, file = TUNNEL_URL_FILE): void {
  fs.writeFileSync(file, `${url}\n`);
}

export function removeTunnelUrl(file = TUNNEL_URL_FILE): void {
  fs.rmSync(file, { force: true });
}

/** An explicit PUBLIC_CALLBACK_URL wins; otherwise the running tunnel's URL, if any. */
export function resolvePublicCallbackUrl(envValue: string | undefined, file = TUNNEL_URL_FILE): string | undefined {
  return envValue || readTunnelUrl(file);
}
