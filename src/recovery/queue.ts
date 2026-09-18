import { parseRecoveryJson } from "./json";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Lease } from "../lease";
import { RecoveryContext, RecordEvent, RecordReceipt, isTerminalReceipt, sameContext, validateContext, validateEvent, validateReceipt, MAX_BATCH_BYTES } from "./protocol";

type Options = { directory: string; context: RecoveryContext; maxBytes?: number; fault?: (point: string) => void | Promise<void> };
type Tombstone = { event_id: string; event_hash: string; payload_sha256: string };
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const encode = (value: unknown): string => JSON.stringify({ value, sha256: hash(canonical(value)) });
function decode(bytes: Uint8Array): unknown {
  const data = parseRecoveryJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!data || Object.keys(data).sort().join() !== "sha256,value" || data.sha256 !== hash(canonical(data.value))) throw new Error("Corrupt recovery record.");
  return data.value;
}
async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

/** Local POSIX filesystem only. Fsync/rename publishes each file, then fsyncs its directory.
 * Terminal storage receipts and hash tombstones survive payload cleanup. Lease excludes other hosts.
 * The cap counts all logical file bytes (not filesystem allocation units); receipt headroom is reserved.
 */
export class RecoveryQueue {
  private events = new Map<string, RecordEvent>();
  private receipts = new Map<string, RecordReceipt>();
  private tombstones = new Map<string, Tombstone>();
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  private batchCursor?: { event_id: string; client_sequence: number };
  private readonly binding: RecoveryContext;
  private readonly limit: number;
  private constructor(private options: Options, private lease: Lease) {
    this.binding = structuredClone(options.context);
    this.limit = options.maxBytes ?? 256 * 1024 * 1024;
  }
  get context(): RecoveryContext { return structuredClone(this.binding); }
  static async open(options: Options): Promise<RecoveryQueue> {
    if (process.platform === "win32") throw new Error("Recovery queue requires a tested local POSIX filesystem; Windows is not supported yet.");
    if (!Number.isSafeInteger(options.maxBytes ?? 256 * 1024 * 1024) || (options.maxBytes ?? 4096) < 4096) throw new Error("Recovery queue limit must be at least 4096 bytes.");
    options = { ...options, directory: resolve(options.directory), context: validateContext(options.context) };
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(options.directory)).isDirectory() || (await lstat(options.directory)).isSymbolicLink()) throw new Error("Recovery directory must be a regular local directory.");
    // Flush descendants before parents, through the filesystem root. Previously
    // existing ancestors may come from an earlier interrupted mkdir/fsync attempt.
    for (let current = options.directory; ; current = dirname(current)) {
      await syncDirectory(current);
      if (current === dirname(current)) break;
    }
    const lease = await Lease.acquire(options.directory, () => undefined);
    const queue = new RecoveryQueue(options, lease);
    try {
      const names = await readdir(options.directory);
      for (const name of names) {
        const stat = await lstat(join(options.directory, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error("Unsafe or oversized recovery record.");
        if (/^[a-f0-9-]+\.tmp$/.test(name)) continue;
        if (name !== "context.json" && !/^[a-f0-9]{64}\.[ert]\.json$/.test(name)) throw new Error("Unexpected recovery file.");
      }
      if (names.includes("context.json")) {
        const bound = decode(await readFile(join(options.directory, "context.json"))) as RecoveryContext;
        if (!sameContext(bound, queue.binding) || canonical(bound) !== canonical(queue.binding)) throw new Error("Recovery queue belongs to a different course, identity or origin.");
      } else {
        if (names.some(n => !n.endsWith(".tmp"))) throw new Error("Recovery context binding is missing.");
      }
      for (const name of names.filter(n => n.endsWith(".tmp"))) await unlink(join(options.directory, name));
      await syncDirectory(options.directory);
      if (!names.includes("context.json")) await queue.publish("context.json", queue.binding);
      for (const name of names.filter(n => /^[a-f0-9]{64}\.[ert]\.json$/.test(n))) {
        const value = decode(await readFile(join(options.directory, name)));
        if (name.endsWith(".e.json")) { const e = validateEvent(value); queue.events.set(e.event_id, e); if (name !== queue.name(e.event_id, "e")) throw new Error("Recovery event name mismatch."); }
        if (name.endsWith(".r.json")) { const r = validateReceipt(value); queue.receipts.set(r.event_id, r); if (name !== queue.name(r.event_id, "r")) throw new Error("Recovery receipt name mismatch."); }
        if (name.endsWith(".t.json")) {
          const t = value as Tombstone;
          if (!t || Object.keys(t).sort().join() !== "event_hash,event_id,payload_sha256" || typeof t.event_id !== "string" || !/^[a-f0-9]{64}$/.test(t.event_hash) || !/^[a-f0-9]{64}$/.test(t.payload_sha256) || name !== queue.name(t.event_id, "t")) throw new Error("Corrupt recovery tombstone.");
          queue.tombstones.set(t.event_id, t);
        }
      }
      for (const receipt of queue.receipts.values()) queue.checkReceipt(receipt);
      for (const [id, tomb] of queue.tombstones) {
        if (!isTerminalReceipt(queue.receipts.get(id)) || (queue.events.has(id) && hash(canonical(queue.events.get(id))) !== tomb.event_hash)) throw new Error("Recovery cleanup record has no matching terminal receipt.");
      }
      return queue;
    } catch (e) { await lease.release(); throw e; }
  }
  private name(id: string, kind: string): string { return `${hash(id)}.${kind}.json`; }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { this.lease.check(); if (this.failed) throw new Error("Recovery storage unavailable; reopen the tutor."); return operation(); });
    this.tail = result.catch(() => undefined); return result;
  }
  private async bytes(): Promise<number> {
    let total = 0;
    for (const name of await readdir(this.options.directory)) total += (await lstat(join(this.options.directory, name))).size;
    return total;
  }
  private async publish(name: string, value: unknown): Promise<void> {
    const bytes = encode(value);
    if (await this.bytes() + Buffer.byteLength(bytes) > this.limit) throw new Error("Recovery storage is full. Retain these records and free disk space or finish durable storage before sending again.");
    const temporary = join(this.options.directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes, "utf8"); await file.sync(); } finally { await file.close(); }
      await this.options.fault?.("after-file-sync");
      this.lease.check();
      await rename(temporary, join(this.options.directory, name));
      await this.options.fault?.("after-publish");
      await syncDirectory(this.options.directory);
    } catch (e) { this.failed = true; throw e; }
  }
  enqueue(raw: RecordEvent): Promise<void> {
    const event = structuredClone(validateEvent(raw));
    return this.run(async () => {
      const old = this.events.get(event.event_id); const tomb = this.tombstones.get(event.event_id);
      if (old || tomb) {
        if ((old ? hash(canonical(old)) : tomb!.event_hash) !== hash(canonical(event))) throw new Error("Recovery event ID conflicts with its original immutable content.");
        return;
      }
      const reserve = Math.min(1024 * 1024, Math.floor(this.limit / 8));
      if (await this.bytes() + Buffer.byteLength(encode(event)) > this.limit - reserve) throw new Error("Recovery queue is full. No new request can be sent until records have terminal storage receipts or storage is increased.");
      await this.publish(this.name(event.event_id, "e"), event);
      this.events.set(event.event_id, event);
    });
  }
  pending(): Promise<RecordEvent[]> { return this.run(async () => structuredClone([...this.events.values()].filter(e => !isTerminalReceipt(this.receipts.get(e.event_id))).sort((a, b) => a.client_sequence - b.client_sequence || a.event_id.localeCompare(b.event_id)))); }
  /** Cursor is the last event returned, not a sequence watermark. Wrap so retained
   * received events remain recoverable without starving newer records. Only the
   * bounded selected batch is cloned; the queue itself still retains payloads in RAM. */
  batch(afterId?: string): Promise<RecordEvent[]> {
    return this.run(async () => {
      const pending = [...this.events.values()].filter(e => !isTerminalReceipt(this.receipts.get(e.event_id)))
        .sort((a, b) => a.client_sequence - b.client_sequence || a.event_id.localeCompare(b.event_id));
      let cursor = afterId ? pending.findIndex(e => e.event_id === afterId) : -1;
      if (cursor < 0 && afterId && this.batchCursor?.event_id === afterId) {
        // Cleanup may have removed the last batch event. Keep a single lightweight
        // cursor so an unreplicated prefix cannot repeatedly starve later events.
        const previous = this.batchCursor;
        const next = pending.findIndex(e => e.client_sequence > previous.client_sequence ||
          e.client_sequence === previous.client_sequence && e.event_id.localeCompare(previous.event_id) > 0);
        cursor = next < 0 ? pending.length - 1 : next - 1;
      }
      const selected: RecordEvent[] = [];
      let bytes = Buffer.byteLength('{"schema_version":1,"events":[]}');
      for (let offset = 1; offset <= pending.length && selected.length < 100; offset++) {
        const event = pending[(cursor + offset) % pending.length]!;
        const size = Buffer.byteLength(JSON.stringify(event)) + (selected.length ? 1 : 0);
        if (bytes + size > MAX_BATCH_BYTES) break;
        selected.push(event); bytes += size;
      }
      const last = selected.at(-1);
      if (last) this.batchCursor = { event_id: last.event_id, client_sequence: last.client_sequence };
      return structuredClone(selected);
    });
  }
  pendingCount(): Promise<number> {
    return this.run(async () => {
      let count = 0;
      for (const event of this.events.values()) if (!isTerminalReceipt(this.receipts.get(event.event_id))) count++;
      return count;
    });
  }
  receipt(eventId: string): Promise<RecordReceipt | undefined> { return this.run(async () => structuredClone(this.receipts.get(eventId))); }
  private checkReceipt(receipt: RecordReceipt): void {
    const event = this.events.get(receipt.event_id) ?? this.tombstones.get(receipt.event_id);
    if (!event || receipt.payload_sha256 !== event.payload_sha256 || receipt.subject !== this.binding.subject || receipt.course_id !== this.binding.courseId) throw new Error("Recovery receipt does not match the recorded event and account.");
  }
  acknowledge(raw: RecordReceipt): Promise<void> {
    const receipt = structuredClone(validateReceipt(raw));
    return this.run(async () => {
      this.checkReceipt(receipt);
      const old = this.receipts.get(receipt.event_id);
      const rank = { queued: 0, received: 1, replicated: 2, archived: 2 };
      if (old && (canonical(old) === canonical(receipt) || rank[old.state] > rank[receipt.state] || isTerminalReceipt(old))) return;
      await this.publish(this.name(receipt.event_id, "r"), receipt);
      this.receipts.set(receipt.event_id, receipt);
      try { await this.options.fault?.("after-receipt"); } catch (e) { this.failed = true; throw e; }
    });
  }
  cleanup(): Promise<void> {
    return this.run(async () => {
      try {
        for (const [id, event] of this.events) {
          if (!isTerminalReceipt(this.receipts.get(id))) continue;
          if (!this.tombstones.has(id)) {
            const tomb = { event_id: id, event_hash: hash(canonical(event)), payload_sha256: event.payload_sha256 };
            await this.publish(this.name(id, "t"), tomb); this.tombstones.set(id, tomb);
          }
          await this.options.fault?.("after-tombstone");
          this.lease.check();
          await unlink(join(this.options.directory, this.name(id, "e")));
          await syncDirectory(this.options.directory);
          this.events.delete(id);
          await this.options.fault?.("after-cleanup");
        }
      } catch (e) { this.failed = true; throw e; }
    });
  }
  summary(): Promise<{ awaitingReceipt: number; awaitingReplication: number; total: number }> {
    return this.run(async () => {
      let awaitingReceipt = 0; let awaitingReplication = 0;
      for (const eventId of this.events.keys()) {
        const receipt = this.receipts.get(eventId);
        if (!receipt) awaitingReceipt++;
        else if (!isTerminalReceipt(receipt)) awaitingReplication++;
      }
      return { awaitingReceipt, awaitingReplication, total: awaitingReceipt + awaitingReplication };
    });
  }
  stats(): Promise<{ events: number; bytes: number; limit: number; warning: boolean }> {
    return this.run(async () => { const bytes = await this.bytes(); return { events: this.events.size, bytes, limit: this.limit, warning: bytes >= this.limit * 0.8 }; });
  }
  async close(): Promise<void> { await this.tail; await this.lease.release(); }
}
