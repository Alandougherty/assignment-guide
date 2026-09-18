import { lstat } from "node:fs/promises";
import { recordSignature } from "./record-cache";

/** Rebuildable, bounded metadata index. Never substitutes for checking files.
 * The caller supplies a small summary, not the captured file contents.
 */
export class RecordIndex<T, S> {
  private entries = new Map<string, { signature: string; summary: S }>();
  constructor(private readonly load: (path: string) => Promise<T>, private readonly summarise: (record: T) => S,
    private readonly maxEntries = 16_384) {}
  retain(paths: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) if (!paths.has(path)) this.entries.delete(path);
  }
  async inspect(path: string): Promise<S> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) throw new Error("Record must be a regular file.");
    const signature = recordSignature(before);
    const cached = this.entries.get(path);
    if (cached?.signature === signature) return cached.summary;
    this.entries.delete(path);
    const record = await this.load(path);
    const after = await lstat(path, { bigint: true });
    if (!after.isFile() || recordSignature(after) !== signature) throw new Error("Record changed while indexing.");
    const summary = this.summarise(record);
    if (this.entries.size < this.maxEntries) this.entries.set(path, { signature, summary });
    return summary;
  }
}
