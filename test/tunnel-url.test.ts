import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTunnelUrl, removeTunnelUrl, resolvePublicCallbackUrl, writeTunnelUrl } from '../src/shared/tunnel-url.js';

describe('tunnel URL file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-url-')), '.tunnel-url');
  afterEach(() => removeTunnelUrl(file));

  it('round-trips the URL written by npm run tunnel', () => {
    writeTunnelUrl('https://example.trycloudflare.com', file);
    expect(readTunnelUrl(file)).toBe('https://example.trycloudflare.com');
  });

  it('returns undefined when there is no tunnel or the file is not an https URL', () => {
    expect(readTunnelUrl(file)).toBeUndefined();
    fs.writeFileSync(file, 'http://localhost:4000\n');
    expect(readTunnelUrl(file)).toBeUndefined();
  });

  it('prefers an explicit PUBLIC_CALLBACK_URL over the tunnel file', () => {
    writeTunnelUrl('https://example.trycloudflare.com', file);
    expect(resolvePublicCallbackUrl('https://explicit.example.com', file)).toBe('https://explicit.example.com');
    expect(resolvePublicCallbackUrl('', file)).toBe('https://example.trycloudflare.com');
    removeTunnelUrl(file);
    expect(resolvePublicCallbackUrl(undefined, file)).toBeUndefined();
  });
});
