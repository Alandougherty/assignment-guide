import { parseRecoveryJson } from "./json";
import { type RecordEvent, type RecordReceipt, type RecoveryContext, sameContext, validateEvent, validateReceipt, validateArchivePolicy, type ArchivePolicy } from "./protocol";

export interface RecoveryQueueLike {
  readonly context: RecoveryContext;
  pending(): Promise<RecordEvent[]>;
  /** Efficient bounded reads for large durable queues. */
  batch?(afterId?: string): Promise<RecordEvent[]>;
  pendingCount?(): Promise<number>;
  receipt(eventId: string): Promise<RecordReceipt | undefined>;
  acknowledge(receipt: RecordReceipt): Promise<void>;
  cleanup(): Promise<unknown>;
}
export type RecoveryCredential = RecoveryContext & { token: string; protocolVersion?: 1 | 2; archivePolicy?: ArchivePolicy };
export type WorkerStatus = {
  phase: "idle" | "running" | "waiting" | "paused-auth" | "paused-conflict";
  pendingEvents: number;
  nextRunAt?: number;
  reason?: string;
};
export type RecoveryWorkerOptions = {
  /** Explicit opt-in; v1 is the default and never silently becomes archive mode. */
  protocolVersion?: 1 | 2;
  /** Must retrieve a freshly server-verified identity, not a token's asserted owner. */
  credentials: (signal?: AbortSignal) => Promise<RecoveryCredential>;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  onStatus?: (status: WorkerStatus) => void;
  requestTimeoutMs?: number;
  /** Synthetic local service tests only. */
  allowLoopback?: boolean;
};
const MAX_EVENTS = 100;
const MAX_BYTES = 1024 * 1024;
const MIN_DELAY = 5_000;
const MAX_DELAY = 300_000;
const owners = new Map<string, RecoveryWorker>();
// Explicit v1 catalogue: an unknown code is a contract change, not permission
// to retry indefinitely. Keep successful per-event acknowledgements independent.
const AUTH_ERRORS = new Set(["archive_forbidden"]);
const CONFLICT_ERRORS = new Set(["event_conflict", "sequence_conflict", "central_conflict",
  "hash_mismatch", "metadata_mismatch", "invalid_event", "invalid_data", "invalid_utf8",
  "duplicate_json_key", "invalid_json"]);
const RETRY_ERRORS = new Set(["storage_unavailable", "queue_full", "queue_busy"]);
/** Credential providers use this only for rejected authentication or required reconfirmation. */
export class RecoveryAuthenticationError extends Error {}
class TransportFailure extends Error {
  constructor(readonly reason: string, readonly pause?: "paused-auth" | "paused-conflict", readonly retryAfter = 0) { super(reason); }
}
type BatchResult = { receipts: RecordReceipt[]; missing: { event_id: string; payload_sha256: string }[]; errors: { event_id: string; code: string }[] };

/** Record-only transport. No inference endpoint or model retry callback is accepted. */
export class RecoveryWorker {
  private readonly context: RecoveryContext;
  private readonly key: string;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly fetcher: typeof fetch;
  private state: WorkerStatus = { phase: "idle", pendingEvents: 0 };
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<WorkerStatus>;
  private started = false;
  private abort?: AbortController;
  private failures = 0;
  private epoch = 0;
  private cycleEpoch = 0;
  private lastEvent?: string;
  constructor(private readonly queue: RecoveryQueueLike, private readonly options: RecoveryWorkerOptions) {
    this.context = { ...queue.context };
    if (options.protocolVersion !== undefined && options.protocolVersion !== 1 && options.protocolVersion !== 2) throw new Error("Unsupported record protocol");
    const url = new URL(this.context.origin);
    const local = options.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1";
    if ((!local && url.protocol !== "https:") || url.origin !== this.context.origin || url.username || url.password) throw new Error("Invalid approved record origin");
    this.key = JSON.stringify([this.context.origin, this.context.subject, this.context.courseId]);
    this.clock = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.fetcher = options.fetch ?? fetch;
    if (options.requestTimeoutMs !== undefined && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) throw new Error("Invalid record transport timeout");
  }
  get status(): WorkerStatus { return { ...this.state }; }
  /** Explicitly enable background polling. Constructing a worker sends nothing. */
  start(): void {
    if (this.started) return;
    this.claim(); this.started = true; this.schedule();
  }
  stop(): void {
    this.started = false;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    if (!this.running && owners.get(this.key) === this) owners.delete(this.key);
  }
  /** Abort transport, fence late credentials and wait before its queue is closed. */
  async close(): Promise<void> { this.stop(); await this.running; }
  /** Call after identity reconfirmation or operator resolution of an event conflict. */
  resume(): void {
    this.failures = 0;
    this.publish({ phase: "idle", pendingEvents: this.state.pendingEvents });
    if (this.started) this.schedule();
  }
  runOnce(): Promise<WorkerStatus> {
    if (this.running) return this.running;
    if (this.state.phase.startsWith("paused") || (this.state.nextRunAt ?? 0) > this.clock()) return Promise.resolve(this.status);
    this.claim();
    this.running = this.cycle().finally(() => {
      this.running = undefined;
      if (!this.started && owners.get(this.key) === this) owners.delete(this.key);
      if (this.started) this.schedule();
    });
    return this.running;
  }
  private claim(): void {
    if (owners.has(this.key) && owners.get(this.key) !== this) throw new Error("Record worker already active for this identity");
    owners.set(this.key, this);
  }
  private publish(status: WorkerStatus): void {
    this.state = status;
    // Presentation must not interrupt durable acknowledgement or transport.
    try { this.options.onStatus?.(this.status); } catch { /* Presentation only. */ }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.started || this.running || this.state.phase.startsWith("paused")) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if ((this.state.nextRunAt ?? 0) > this.clock()) this.schedule();
      else void this.runOnce();
    }, Math.min(2_147_483_647, Math.max(0, (this.state.nextRunAt ?? this.clock()) - this.clock())));
    this.timer.unref?.();
  }
  private delay(): number {
    const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** Math.min(this.failures, 6));
    return Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(base * (0.8 + 0.4 * this.random()))));
  }
  private async cycle(): Promise<WorkerStatus> {
    this.cycleEpoch = this.epoch;
    this.publish({ phase: "running", pendingEvents: this.state.pendingEvents });
    try {
      if (!sameContext(this.queue.context, this.context)) throw new TransportFailure("identity-changed", "paused-auth");
      await this.queue.cleanup();
      const pendingEvents = await this.pendingCount();
      this.publish({ phase: "running", pendingEvents });
      if (pendingEvents) {
        const batch = this.queue.batch ? await this.queue.batch(this.lastEvent) : this.batch(await this.queue.pending());
        this.validateBatch(batch);
        this.lastEvent = batch.at(-1)!.event_id;
        const result = await this.request("receipts", batch);
        await this.accept(result);
        const missing = new Set(result.missing.map(item => item.event_id));
        if (missing.size) await this.accept(await this.request("events", batch.filter(event => missing.has(event.event_id))));
        await this.queue.cleanup();
      }
      this.failures = 0;
      this.publish({ phase: "waiting", pendingEvents: await this.pendingCount(), nextRunAt: this.clock() + this.delay() });
    } catch (error) {
      const failure = error instanceof TransportFailure ? error : new TransportFailure("record-transport-unavailable");
      if (failure.pause) this.publish({ phase: failure.pause, pendingEvents: this.state.pendingEvents, reason: failure.reason });
      else {
        const delay = Math.max(this.delay(), failure.retryAfter);
        this.failures++;
        this.publish({ phase: "waiting", pendingEvents: this.state.pendingEvents, nextRunAt: this.clock() + delay, reason: failure.reason });
      }
    }
    return this.status;
  }
  private pendingCount(): Promise<number> {
    return this.queue.pendingCount ? this.queue.pendingCount() : this.queue.pending().then(events => events.length);
  }
  private validateBatch(events: RecordEvent[]): void {
    if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS || new Set(events.map(event => event.event_id)).size !== events.length ||
        Buffer.byteLength(JSON.stringify({ schema_version: 1, events }), "utf8") > MAX_BYTES) throw new TransportFailure("invalid-local-batch", "paused-conflict");
    try { for (const event of events) validateEvent(event); } catch { throw new TransportFailure("invalid-local-event", "paused-conflict"); }
  }
  private batch(events: RecordEvent[]): RecordEvent[] {
    const index = events.findIndex(event => event.event_id === this.lastEvent);
    const start = index < 0 ? 0 : (index + 1) % events.length;
    const selected: RecordEvent[] = [];
    for (let offset = 0; offset < events.length && selected.length < MAX_EVENTS; offset++) {
      const event = events[(start + offset) % events.length]!;
      try { validateEvent(event); } catch { throw new TransportFailure("invalid-local-event", "paused-conflict"); }
      if (Buffer.byteLength(JSON.stringify({ schema_version: 1, events: [...selected, event] }), "utf8") > MAX_BYTES) {
        if (!selected.length) throw new TransportFailure("event-exceeds-batch-limit", "paused-conflict");
        break;
      }
      selected.push(event);
    }
    return selected;
  }
  private async credential(signal?: AbortSignal): Promise<RecoveryCredential> {
    let credential: RecoveryCredential;
    try { credential = await this.options.credentials(signal); }
    catch (error) {
      if (error instanceof RecoveryAuthenticationError) throw new TransportFailure("authentication-required", "paused-auth");
      throw new TransportFailure("identity-unavailable");
    }
    if (!credential || !sameContext(credential, this.context) || typeof credential.token !== "string" || !credential.token || /\s/.test(credential.token)) throw new TransportFailure("identity-changed", "paused-auth");
    if (this.options.protocolVersion === 2) {
      if (credential.protocolVersion !== 2) throw new TransportFailure("archive-policy-required", "paused-auth");
      try { validateArchivePolicy(credential.archivePolicy); } catch { throw new TransportFailure("archive-policy-required", "paused-auth"); }
    } else if (credential.protocolVersion === 2 || credential.archivePolicy !== undefined) throw new TransportFailure("record-protocol-changed", "paused-auth");
    return structuredClone(credential);
  }
  private async request(route: "events" | "receipts", events: RecordEvent[]): Promise<BatchResult> {
    if (this.cycleEpoch !== this.epoch) throw new TransportFailure("record-transport-stopped");
    const body = JSON.stringify({ schema_version: this.options.protocolVersion ?? 1, events: route === "events" ? events : events.map(({ event_id, payload_sha256 }) => ({ event_id, payload_sha256 })) });
    if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new TransportFailure("batch-exceeds-limit", "paused-conflict");
    const controller = new AbortController(); this.abort = controller;
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 15_000);
    timeout.unref?.();
    try {
      const credential = await this.untilAbort(this.credential(controller.signal), controller.signal);
      if (this.cycleEpoch !== this.epoch) throw new TransportFailure("record-transport-stopped");
      const response = await this.untilAbort(this.fetcher(`${this.context.origin}/records/v${this.options.protocolVersion ?? 1}/${route}`, {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` }, body, signal: controller.signal,
      }), controller.signal);
      if (!response.ok) {
        const retryAfter = this.retryAfter(response.headers.get("retry-after"));
        if (response.body) await this.untilAbort(response.body.cancel(), controller.signal);
        if (response.status === 401 || response.status === 403) throw new TransportFailure("authentication-required", "paused-auth");
        if (response.status === 409) throw new TransportFailure("event-conflict", "paused-conflict");
        if ([400, 404, 405, 413, 415, 422].includes(response.status)) throw new TransportFailure("record-contract-rejected", "paused-conflict");
        throw new TransportFailure("record-service-unavailable", undefined, retryAfter);
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        if (response.body) await this.untilAbort(response.body.cancel(), controller.signal);
        throw new TransportFailure("invalid-record-response");
      }
      const text = await this.readBounded(response, controller.signal);
      let raw: unknown;
      try { raw = parseRecoveryJson(text); } catch { throw new TransportFailure("invalid-record-response"); }
      if (this.cycleEpoch !== this.epoch || controller.signal.aborted) throw new TransportFailure("record-transport-stopped");
      return this.validateResult(raw, route, events, credential);
    } finally { clearTimeout(timeout); if (this.abort === controller) this.abort = undefined; }
  }
  private untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(new TransportFailure("record-transport-interrupted")); };
      // Always attach handlers to absorb a credential/fetch result arriving after cancellation.
      operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  }
  private retryAfter(value: string | null): number {
    if (!value) return 0;
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - this.clock();
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  }
  private async readBounded(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) throw new TransportFailure("invalid-record-response");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await this.untilAbort(reader.read(), signal); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new TransportFailure("record-response-exceeds-limit");
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  }
  private validateResult(raw: unknown, route: "events" | "receipts", events: RecordEvent[], credential: RecoveryCredential): BatchResult {
    const invalid = () => new TransportFailure("invalid-record-response");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const data = raw as Record<string, unknown>;
    if (data.schema_version !== (this.options.protocolVersion ?? 1) || !Array.isArray(data.receipts) || !Array.isArray(data.errors) || (route === "receipts" && !Array.isArray(data.missing))) throw invalid();
    if (Object.keys(data).some(key => !["schema_version", "receipts", "errors", ...(route === "receipts" ? ["missing"] : [])].includes(key))) throw invalid();
    const wanted = new Map(events.map(event => [event.event_id, event])); const seen = new Set<string>();
    const mark = (id: unknown): RecordEvent => {
      if (typeof id !== "string" || seen.has(id) || !wanted.has(id)) throw invalid();
      seen.add(id); return wanted.get(id)!;
    };
    const receipts = data.receipts.map(value => {
      let receipt: RecordReceipt;
      try { receipt = validateReceipt(value); } catch { throw invalid(); }
      if (receipt.schema_version !== (this.options.protocolVersion ?? 1)) throw invalid();
      if (receipt.state === "archived" && (receipt.archive?.store_id !== credential.archivePolicy?.store_id || receipt.archive?.policy_id !== credential.archivePolicy?.policy_id)) throw invalid();
      const event = mark(receipt.event_id);
      if (receipt.payload_sha256 !== event.payload_sha256 || receipt.subject !== this.context.subject || receipt.course_id !== this.context.courseId) throw invalid();
      return receipt;
    });
    const missing = ((data.missing ?? []) as unknown[]).map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
      const item = value as Record<string, unknown>; const event = mark(item.event_id);
      if (Object.keys(item).length !== 2 || item.payload_sha256 !== event.payload_sha256) throw invalid();
      return { event_id: event.event_id, payload_sha256: event.payload_sha256 };
    });
    const errors = data.errors.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
      const item = value as Record<string, unknown>; const event = mark(item.event_id);
      if (Object.keys(item).length !== 2 || typeof item.code !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(item.code)) throw invalid();
      return { event_id: event.event_id, code: item.code };
    });
    return { receipts, missing, errors };
  }
  private async accept(result: BatchResult): Promise<void> {
    // A validated partial batch can acknowledge successful events independently.
    for (const receipt of result.receipts) {
      if (this.cycleEpoch !== this.epoch) throw new TransportFailure("record-transport-stopped");
      const previous = await this.queue.receipt(receipt.event_id);
      const rank = { queued: 0, received: 1, replicated: 2, archived: 2 };
      // Poll timestamps do not justify another fsync when durability is unchanged.
      if (previous && previous.payload_sha256 === receipt.payload_sha256 && rank[previous.state] >= rank[receipt.state]) continue;
      if (this.cycleEpoch !== this.epoch) throw new TransportFailure("record-transport-stopped");
      await this.queue.acknowledge(receipt);
    }
    if (result.errors.some(error => AUTH_ERRORS.has(error.code))) throw new TransportFailure("authentication-required", "paused-auth");
    if (result.errors.some(error => CONFLICT_ERRORS.has(error.code))) throw new TransportFailure("event-conflict", "paused-conflict");
    if (result.errors.some(error => !RETRY_ERRORS.has(error.code))) throw new TransportFailure("record-contract-rejected", "paused-conflict");
    if (result.errors.length) throw new TransportFailure("record-event-unavailable");
  }
}
