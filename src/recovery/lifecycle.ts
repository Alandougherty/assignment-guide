import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validateAssignmentRef } from "../assignment";
import type { AssignmentRef } from "../domain";
import { RecoveryQueue } from "./queue";
import { validateContext, type RecoveryContext } from "./protocol";
import { RecoveryWorker, type RecoveryWorkerOptions, type WorkerStatus } from "./worker";

export type RecoveryLifecycleStatus = {
  phase: "idle" | "upload-pending" | "replication-pending" | "archive-pending" | "paused-auth" | "paused-conflict" | "unavailable" | "closed";
  pendingEvents: number;
  awaitingUpload: number;
  awaitingReplication: number;
  reason?: string;
};
export type RecoveryLifecycleOptions = Omit<RecoveryWorkerOptions, "onStatus"> & {
  /** Extension-owned global storage, outside the assignment and synced workspace. */
  directory: string;
  context: RecoveryContext;
  assignment: AssignmentRef;
  onStatus?: (status: RecoveryLifecycleStatus) => void;
};

/** Owns one account's queue and explicit-start record transport. No model lock or inference API. */
export class RecoveryLifecycle {
  private readonly worker: RecoveryWorker;
  private current: RecoveryLifecycleStatus = { phase: "idle", pendingEvents: 0, awaitingUpload: 0, awaitingReplication: 0 };
  private workerState: WorkerStatus = { phase: "idle", pendingEvents: 0 };
  private refreshing: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private paused = false;
  private constructor(readonly queue: RecoveryQueue, private readonly options: RecoveryLifecycleOptions) {
    this.worker = new RecoveryWorker(queue, { ...options, onStatus: status => {
      this.workerState = status;
      if (!this.closing) void this.refresh();
    } });
  }
  static async open(options: RecoveryLifecycleOptions): Promise<RecoveryLifecycle> {
    const context = validateContext(options.context);
    validateAssignmentRef(options.assignment);
    // Check transport policy before creating even a temporary queue or claiming a lease.
    const url = new URL(context.origin);
    if (url.protocol !== "https:" && !(options.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("Invalid approved recovery origin.");
    if (options.requestTimeoutMs !== undefined && (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)) throw new Error("Invalid record transport timeout");
    const bound = { ...options, context, assignment: structuredClone(options.assignment) };
    const digest = createHash("sha256").update(JSON.stringify([context.origin, context.subject, context.courseId])).digest("hex");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const queue = await RecoveryQueue.open({ directory: join(options.directory, digest), context });
    try {
      const lifecycle = new RecoveryLifecycle(queue, bound);
      await lifecycle.refresh();
      return lifecycle;
    } catch (error) { await queue.close(); throw error; }
  }
  get status(): RecoveryLifecycleStatus { return { ...this.current }; }
  get assignment(): AssignmentRef { return structuredClone(this.options.assignment); }
  /** The host calls this only after consent and account confirmation. Opening sends nothing. */
  start(): void { this.assertOpen(); this.paused = false; this.worker.resume(); this.worker.start(); }
  resume(): void { this.assertOpen(); this.worker.resume(); }
  /** Pause sending during reconfirmation while local admission can finish persisting. */
  async pause(): Promise<void> {
    this.assertOpen(); this.paused = true; await this.worker.close(); await this.refresh();
  }
  /** Refresh presentation after a newly persisted submission, reply or outcome. */
  async refresh(): Promise<RecoveryLifecycleStatus> {
    if (this.closing) return this.status;
    const operation = this.refreshing.then(async () => {
      if (this.closing) return;
      try {
        const summary = await this.queue.summary();
        if (this.closing) return;
        const phase = this.paused ? "paused-auth" : this.workerState.phase === "paused-auth" || this.workerState.phase === "paused-conflict" ? this.workerState.phase :
          summary.awaitingReceipt ? "upload-pending" : summary.awaitingReplication ? (this.options.protocolVersion === 2 ? "archive-pending" : "replication-pending") : "idle";
        this.publish({ phase, pendingEvents: summary.total, awaitingUpload: summary.awaitingReceipt, awaitingReplication: summary.awaitingReplication,
          ...(this.workerState.reason ? { reason: this.workerState.reason } : {}) });
      } catch {
        if (!this.closing) this.publish({ ...this.current, phase: "unavailable", reason: "local-recovery-unavailable" });
      }
    });
    this.refreshing = operation.catch(() => undefined);
    await operation;
    return this.status;
  }
  /** Abort and await transport before releasing the lease; closed owners cannot restart. */
  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      await this.worker.close();
      await this.refreshing;
      await this.queue.close();
      this.publish({ ...this.current, phase: "closed" });
    })();
    return this.closing;
  }
  private assertOpen(): void { if (this.closing) throw new Error("Recovery lifecycle is closed."); }
  private publish(status: RecoveryLifecycleStatus): void {
    this.current = status;
    try { this.options.onStatus?.(this.status); } catch { /* Presentation cannot interrupt storage. */ }
  }
}
