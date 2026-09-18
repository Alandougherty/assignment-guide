import { randomUUID } from "node:crypto";
import type { Submission, ModelReply, EditEvent, Observation } from "../service/protocol";
import { makeEvent, payloadHash, type EventKind, type RecordEvent } from "./protocol";

export type RecoveryStamp = { event_id: string; client_sequence: number; client_timestamp: string };
export type RecoverableTurn = { submission: Submission;
  attempts: { attemptId: string; state: string; result: ModelReply | null; error: string | null }[];
  observations?: { payload: Observation }[]; editEvents?: { payload: EditEvent }[];
  recovery?: Record<string, RecoveryStamp> };
/** Metadata is persisted with the legacy local record before queue admission. */
export function recoveryEvents(turn: RecoverableTurn, nextSequence?: () => number): RecordEvent[] {
  const values: { kind: EventKind; data: unknown }[] = [{ kind: "submission", data: turn.submission }];
  for (const attempt of turn.attempts) {
    if (attempt.state === "completed" && attempt.result) values.push({ kind: "reply_final", data: { attempt_id: attempt.attemptId, complete: true, reply: attempt.result } });
    if (["completed","failed","cancelled","unknown"].includes(attempt.state)) values.push({ kind: "outcome", data: { attempt_id: attempt.attemptId, status: attempt.state,
      error_code: attempt.error && /^[a-z][a-z0-9-]{0,79}$/.test(attempt.error) ? attempt.error : attempt.error ? "client-error" : null } });
  }
  for (const observation of turn.observations ?? []) values.push({ kind: "outcome", data: { attempt_id: observation.payload.attemptId, observation: observation.payload } });
  for (const edit of turn.editEvents ?? []) values.push({ kind: "edit_event", data: edit.payload });
  return values.map(({ kind, data }) => {
    const key = payloadHash(JSON.stringify({ kind, data }));
    let stamp = turn.recovery?.[key];
    if (!stamp) {
      if (!nextSequence) throw new Error("Recovery event metadata must be durably prepared before upload.");
      stamp = { event_id: randomUUID(), client_sequence: nextSequence(), client_timestamp: kind === "submission" ? turn.submission.capturedAt : new Date().toISOString() };
      (turn.recovery ??= {})[key] = stamp;
    }
    return makeEvent({ ...stamp, turn_id: turn.submission.submissionId, session_id: turn.submission.sessionId,
      assignment: turn.submission.assignment, event_kind: kind, data });
  });
}

/** Optional future streaming adapter. Current tutor transport returns complete JSON. */
export class ReplyCheckpoints {
  private text = "";
  private savedOffset = 0;
  private lastSaved: number;
  private pending: RecordEvent | undefined;
  private finished = false;
  private terminal: RecordEvent | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private persistenceFailed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: { turnId: string; sessionId: string; attemptId: string; assignment: Submission["assignment"];
    nextSequence: () => number; persist: (event: RecordEvent) => Promise<void>; now?: () => number; intervalMs?: number; maxBytes?: number; onPersistenceError?: () => void }) {
    if (!Number.isFinite(options.intervalMs ?? 2000) || (options.intervalMs ?? 2000) <= 0 || !Number.isSafeInteger(options.maxBytes ?? 8192) || (options.maxBytes ?? 8192) < 1 || (options.maxBytes ?? 8192) > 64000) throw new Error("Invalid reply checkpoint limits.");
    this.lastSaved = this.now();
  }
  get hasPersistenceFailure(): boolean { return this.persistenceFailed; }
  /** Stop scheduling after a disconnected stream; this does not invent completion. */
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(): void {
    if (this.timer || this.finished || this.terminal || this.savedOffset === this.text.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkpoint().catch(() => { this.persistenceFailed = true; try { this.options.onPersistenceError?.(); } catch { /* Presentation only. */ } });
    }, this.options.intervalMs ?? 2000);
    this.timer.unref?.();
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private exclusive(f: () => Promise<void>): Promise<void> { const result = this.tail.then(f); this.tail = result.catch(() => undefined); return result; }
  async append(chunk: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.finished || this.terminal) throw new Error("Reply already has a terminal observation.");
      // Bound the whole reconstructed response as well as checkpoint frequency.
      if (Buffer.byteLength(this.text + chunk) > 64_000) throw new Error("Reply checkpoint buffer exceeded 64,000 bytes.");
      this.text += chunk;
      if (this.now() - this.lastSaved >= (this.options.intervalMs ?? 2000) || Buffer.byteLength(this.text.slice(this.savedOffset)) >= (this.options.maxBytes ?? 8192)) await this.flush(false);
      this.schedule();
    });
  }
  async checkpoint(): Promise<void> { return this.exclusive(() => this.flush(false)); }
  async finish(complete: boolean): Promise<void> {
    return this.exclusive(async () => {
      this.stop();
      if (this.finished) return;
      if (this.terminal && (this.terminal.event_kind === "reply_final") !== complete) throw new Error("Retry the original terminal observation.");
      await this.flush(false);
      const event = this.terminal ?? makeEvent({ event_id: randomUUID(), turn_id: this.options.turnId, session_id: this.options.sessionId, assignment: this.options.assignment,
        client_sequence: this.options.nextSequence(), client_timestamp: new Date(this.now()).toISOString(), event_kind: complete ? "reply_final" : "outcome",
        data: complete ? { attempt_id: this.options.attemptId, complete: true, text: this.text } : { attempt_id: this.options.attemptId, status: "interrupted", persisted_characters: this.savedOffset } });
      this.terminal = event;
      await this.options.persist(event); this.terminal = undefined; this.finished = true;
    });
  }
  private async flush(_complete: boolean): Promise<void> {
    this.stop();
    if (this.pending) { await this.options.persist(this.pending); this.savedOffset += (JSON.parse(this.pending.payload_utf8).data.text as string | undefined)?.length ?? 0; this.pending = undefined; this.lastSaved = this.now(); this.persistenceFailed = false; }
    if (this.savedOffset === this.text.length) return;
    const data = { attempt_id: this.options.attemptId, offset: this.savedOffset, text: this.text.slice(this.savedOffset), complete: false };
    this.pending = makeEvent({ event_id: randomUUID(), turn_id: this.options.turnId, session_id: this.options.sessionId, assignment: this.options.assignment,
      client_sequence: this.options.nextSequence(), client_timestamp: new Date(this.now()).toISOString(), event_kind: "reply_checkpoint", data });
    await this.options.persist(this.pending); this.savedOffset = this.text.length; this.pending = undefined; this.lastSaved = this.now(); this.persistenceFailed = false;
  }
}
