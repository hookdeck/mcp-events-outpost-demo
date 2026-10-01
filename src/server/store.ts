import fs from 'node:fs';
import path from 'node:path';

/**
 * What the server remembers about a webhook subscription. The signing secret
 * itself lives only in Outpost (as the destination's credentials); we keep a
 * hash so a refresh can tell whether the subscriber rotated it.
 */
export interface SubscriptionRecord {
  id: string;
  principal: string;
  tenantId: string;
  destinationId: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secretHash: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A Map with write-through persistence to a JSON file (or memory only when `file` is null). */
export class SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>();

  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as SubscriptionRecord[];
      for (const record of saved) this.records.set(record.id, record);
    }
  }

  get(id: string) {
    return this.records.get(id);
  }

  all() {
    return [...this.records.values()];
  }

  put(record: SubscriptionRecord) {
    this.records.set(record.id, record);
    this.save();
  }

  delete(id: string) {
    if (this.records.delete(id)) this.save();
  }

  private save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.all(), null, 2));
    fs.renameSync(temp, this.file);
  }
}
