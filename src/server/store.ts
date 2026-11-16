import fs from 'node:fs';
import path from 'node:path';

/**
 * The Outpost tenants that have subscribed to something, so the demo store
 * knows where to publish (Outpost's publish API takes one tenant). Outpost
 * holds the subscriptions themselves: this is only a list of tenant IDs.
 *
 * A tenant stays listed after its subscriptions end. Publishing to it then
 * matches nothing, which is harmless. On self-hosted Outpost with RediSearch,
 * or on managed Outpost, `GET /tenants` (each tenant's `topics` includes the
 * events it has subscriptions to) could replace this file.
 */
export class TenantRegistry {
  private readonly tenants = new Set<string>();

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      let ids: unknown;
      try {
        ids = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`${file} isn't valid JSON (${(error as Error).message}). Fix or delete it; it only lists tenants to publish to.`);
      }
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        throw new Error(`${file} must be a JSON array of tenant IDs. Fix or delete it.`);
      }
      for (const id of ids) this.tenants.add(id);
    }
  }

  add(tenantId: string): void {
    if (this.tenants.has(tenantId)) return;
    this.tenants.add(tenantId);
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.tenants], null, 2));
    fs.renameSync(tmp, this.file);
  }

  all(): string[] {
    return [...this.tenants];
  }
}
