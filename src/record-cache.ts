import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";

export function recordSignature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Bounded optimisation only: files remain authoritative and are checked on every read.
 * Values are internal immutable validated objects; callers must clone before mutation.
 */
export class RecordCache<T> {
  private entries = new Map<string, { signature: string; value: T; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly maxEntries = 512) {}
  async read(path: string, validate: (text: string) => T): Promise<T> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new Error("Record is not a regular file.");
      const signature = recordSignature(before);
      const cached = this.entries.get(path);
      if (cached?.signature === signature) return cached.value;
      if (cached) { this.entries.delete(path); this.bytes -= cached.bytes; }
      const text = await file.readFile("utf8");
      const after = await file.stat({ bigint: true });
      if (recordSignature(after) !== signature) throw new Error("Record changed while reading.");
      const value = validate(text);
      const bytes = Buffer.byteLength(text);
      // Stable admission avoids rescanning a large journal evicting every hot entry.
      if (this.bytes + bytes <= this.maxBytes && this.entries.size < this.maxEntries) {
        this.entries.set(path, { signature, value, bytes }); this.bytes += bytes;
      }
      return value;
    } finally { await file.close(); }
  }
}
