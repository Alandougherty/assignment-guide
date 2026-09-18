import { validateEdit, type EditProposal } from "../edits";
import { validateAssignmentRef } from "../assignment";
import { createHash } from "node:crypto";
import { validateSnapshot, type Snapshot, MAX_PROMPT_BYTES } from "../domain";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function reject(message = "Invalid request."): never { throw new HttpError(422, "validation", message); }
export function fields(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return reject();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) reject();
  return o;
}
export function uuid(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) reject();
  return v as string;
}
export function timestamp(v: unknown): string {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) reject();
  return v as string;
}
export function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || Buffer.byteLength(v, "utf8") > max) reject();
  return v as string;
}
export function version(o: Record<string, unknown>): void { if (o.schema !== 1) reject("Unsupported schema."); }
export type Submission = { schema: 1; submissionId: string; sessionId: string; capturedAt: string;
  assignment: { id: string; version: string }; prompt: string; snapshot: Snapshot };
export function submission(v: unknown): Submission {
  const o = fields(v, ["schema", "submissionId", "sessionId", "capturedAt", "assignment", "prompt", "snapshot"]);
  version(o); uuid(o.submissionId); uuid(o.sessionId); timestamp(o.capturedAt); text(o.prompt, MAX_PROMPT_BYTES);
  const a = fields(o.assignment, ["id", "version"]);
  try { validateAssignmentRef(a); } catch { reject("Invalid assignment reference."); }
  const hasPreferences = !!o.snapshot && typeof o.snapshot === "object" && Object.hasOwn(o.snapshot, "preferences");
  const hasWorkspace = !!o.snapshot && typeof o.snapshot === "object" && Object.hasOwn(o.snapshot, "workspace");
  const hasEditRequest = !!o.snapshot && typeof o.snapshot === "object" && Object.hasOwn(o.snapshot, "requestEdit");
  const s = fields(o.snapshot, ["path", "language", "text", "documentVersion", "selection", ...(hasPreferences ? ["preferences"] : []), ...(hasWorkspace ? ["workspace"] : []), ...(hasEditRequest ? ["requestEdit"] : [])]);
  if (s.selection !== null) fields(s.selection, ["start", "end"]);
  try { validateSnapshot(s); } catch { reject("Invalid assignment snapshot."); }
  return o as Submission;
}
export function consent(v: unknown): { schema: 1; noticeVersion: string; confirmedSubject: string } {
  const o = fields(v, ["schema", "noticeVersion", "confirmedSubject"]); version(o);
  text(o.noticeVersion, 100); text(o.confirmedSubject, 100); return o as ReturnType<typeof consent>;
}
export function empty(v: unknown): void { const o = fields(v, ["schema"]); version(o); }
export type Observation = { schema: 1; eventId: string; submissionId: string; attemptId: string;
  observedAt: string; kind: "timeout" | "cancelled" | "dispatch-failed" };
export function observation(v: unknown): Observation {
  const o = fields(v, ["schema", "eventId", "submissionId", "attemptId", "observedAt", "kind"]);
  version(o); uuid(o.eventId); uuid(o.submissionId); uuid(o.attemptId); timestamp(o.observedAt);
  if (!["timeout", "cancelled", "dispatch-failed"].includes(String(o.kind))) reject();
  return o as Observation;
}
/** JSON-only canonicalisation: lexicographic UTF-16 key order, JSON string encoding. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  throw new Error("Non-JSON value.");
}
export function digest(v: unknown): string { return createHash("sha256").update(canonical(v), "utf8").digest("hex"); }
export type ModelReply = { edit?: EditProposal; providerRequestId?: string; prose: string; model: string; usage: { inputTokens: number | null; outputTokens: number | null } | null };
export function reply(v: unknown): ModelReply {
  const hasId = !!v && typeof v === "object" && Object.hasOwn(v, "providerRequestId");
  const hasEdit = !!v && typeof v === "object" && Object.hasOwn(v, "edit");
  const o = fields(v, ["prose", "model", "usage", ...(hasId ? ["providerRequestId"] : []), ...(hasEdit ? ["edit"] : [])]);
  if (hasEdit) { try { validateEdit(o.edit); } catch { reject("Invalid tutor edit proposal."); } }
  text(o.prose, 16_000); text(o.model, 100);
  if (hasId) text(o.providerRequestId, 200);
  if (o.usage !== null) {
    const u = fields(o.usage, ["inputTokens", "outputTokens"]);
    for (const n of Object.values(u)) if (n !== null && (!Number.isSafeInteger(n) || Number(n) < 0)) reject();
  }
  return o as ModelReply;
}


export type EditEvent = { schema: 1; eventId: string; submissionId: string; attemptId: string; observedAt: string;
  kind: "accepted" | "rejected" | "applied" | "conflict" | "failed" | "unknown"; text: string | null };
export function editEvent(value: unknown): EditEvent {
  const o = fields(value, ["schema", "eventId", "submissionId", "attemptId", "observedAt", "kind", "text"]);
  version(o); uuid(o.eventId); uuid(o.submissionId); uuid(o.attemptId); timestamp(o.observedAt);
  if (!["accepted", "rejected", "applied", "conflict", "failed", "unknown"].includes(String(o.kind)) ||
      (o.text !== null && (typeof o.text !== "string" || Buffer.byteLength(o.text, "utf8") > 8000)) ||
      (["accepted", "rejected"].includes(String(o.kind)) && o.text !== null) ||
      (o.kind === "applied" && typeof o.text !== "string")) reject("Invalid edit decision or outcome.");
  return o as EditEvent;
}
