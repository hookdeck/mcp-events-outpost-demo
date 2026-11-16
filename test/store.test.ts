import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TenantRegistry } from '../src/server/store.js';

const tempFile = (content: string) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tenants-')), 'tenants.json');
  fs.writeFileSync(file, content);
  return file;
};

describe('TenantRegistry', () => {
  it('loads a saved list and persists new tenants', () => {
    const file = tempFile('["mcp_alice"]');
    const registry = new TenantRegistry(file);
    registry.add('mcp_bob');
    expect(new TenantRegistry(file).all()).toEqual(['mcp_alice', 'mcp_bob']);
  });

  it('explains a corrupt or wrongly shaped file instead of failing with a parser error', () => {
    expect(() => new TenantRegistry(tempFile('["mcp_alice"'))).toThrow(/isn't valid JSON.*Fix or delete it/);
    expect(() => new TenantRegistry(tempFile('{}'))).toThrow(/must be a JSON array of tenant IDs/);
    expect(() => new TenantRegistry(tempFile('[1, 2]'))).toThrow(/must be a JSON array of tenant IDs/);
  });
});
