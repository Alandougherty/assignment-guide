import { assertUnicodeScalars, parseRecoveryJson } from "./json";
import { createHash } from "node:crypto";
import { validateAssignmentRef } from "../assignment";
import type { AssignmentRef } from "../domain";

export type RecoveryContext = { origin: string; subject: string; courseId: string };
export type EventKind = "submission" | "reply_checkpoint" | "reply_final" | "outcome" | "edit_event";
export type EventInput = { event_id: string; turn_id: string; session_id: string; assignment: AssignmentRef;
  client_sequence: number; event_kind: EventKind; client_timestamp: string; data: unknown };
export type RecordEvent = Omit<EventInput, "data"> & { schema_version: 1; source: "client_observed"; payload_utf8: string; payload_sha256: string };
export type ArchivePolicy = { store_id: string; policy_id: string };
type ReceiptFields = { event_id: string; payload_sha256: string; server_timestamp: string; subject: string; course_id: string };
export type RecordReceipt = ReceiptFields & (
  { schema_version: 1; state: "queued" | "received" | "replicated";
    replication?: { receipt_id: string; generation: string; replica_id: string } } |
  { schema_version: 2; state: "queued" | "received" | "archived";
    archive?: ArchivePolicy & { receipt_id: string } }
);
/** Both promises are final; neither terminal state supersedes the other. */
export function isTerminalReceipt(receipt: RecordReceipt | undefined): boolean {
  return receipt?.state === "replicated" || receipt?.state === "archived";
}
export const MAX_BATCH_BYTES = 1_048_576;
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const label = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error("Invalid recovery protocol fields.");
  return value as Record<string, any>;
}
function date(value: unknown): boolean { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
export function payloadHash(bytes: string): string { assertUnicodeScalars(bytes); return createHash("sha256").update(bytes, "utf8").digest("hex"); }
export function validateContext(value: unknown): RecoveryContext {
  const c = object(value, ["origin", "subject", "courseId"]);
  if (typeof c.origin !== "string" || typeof c.subject !== "string" || typeof c.courseId !== "string" || !label.test(c.subject) || !label.test(c.courseId)) throw new Error("Invalid recovery account binding.");
  const url = new URL(c.origin);
  if (url.origin !== c.origin || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("Invalid recovery origin.");
  return structuredClone(c) as RecoveryContext;
}
export function sameContext(a: RecoveryContext, b: RecoveryContext): boolean { return a.origin === b.origin && a.subject === b.subject && a.courseId === b.courseId; }
export function makeEvent(input: EventInput): RecordEvent {
  const { data, ...metadata } = structuredClone(input);
  const body = { schema_version: 1 as const, ...metadata, source: "client_observed" as const, data };
  const payload_utf8 = JSON.stringify(body);
  return validateEvent({ schema_version: 1, ...metadata, source: "client_observed", payload_utf8, payload_sha256: payloadHash(payload_utf8) });
}
export function validateEvent(value: unknown): RecordEvent {
  const keys = ["schema_version", "event_id", "turn_id", "session_id", "assignment", "client_sequence", "event_kind", "client_timestamp", "source", "payload_utf8", "payload_sha256"];
  const e = object(value, keys);
  if (e.schema_version !== 1 || ![e.event_id,e.turn_id,e.session_id].every(x => typeof x === "string" && id.test(x)) ||
      !Number.isSafeInteger(e.client_sequence) || e.client_sequence < 1 || !date(e.client_timestamp) || e.source !== "client_observed" ||
      !["submission","reply_checkpoint","reply_final","outcome","edit_event"].includes(e.event_kind) ||
      typeof e.payload_utf8 !== "string" || typeof e.payload_sha256 !== "string" || !hash.test(e.payload_sha256) ||
      payloadHash(e.payload_utf8) !== e.payload_sha256 || Buffer.byteLength(JSON.stringify({ schema_version: 1, events: [e] })) > MAX_BATCH_BYTES) throw new Error("Invalid or oversized recovery event.");
  validateAssignmentRef(e.assignment); object(e.assignment, ["id", "version"]);
  const body = object(parseRecoveryJson(e.payload_utf8), [...keys.filter(k => !["payload_utf8","payload_sha256"].includes(k)), "data"]);
  for (const k of keys.filter(k => !["payload_utf8","payload_sha256"].includes(k))) {
    if (k === "assignment") { if (body.assignment?.id !== e.assignment.id || body.assignment?.version !== e.assignment.version) throw new Error("Recovery event metadata differs from its hashed bytes."); object(body.assignment,["id","version"]); }
    else if (body[k] !== e[k]) throw new Error("Recovery event metadata differs from its hashed bytes.");
  }
  return structuredClone(e) as RecordEvent;
}
export function validateArchivePolicy(value: unknown): ArchivePolicy {
  const policy = object(value, ["store_id", "policy_id"]);
  if (!Object.values(policy).every(x => typeof x === "string" && label.test(x))) throw new Error("Invalid archive policy.");
  return structuredClone(policy) as ArchivePolicy;
}
export function validateReceipt(value: unknown): RecordReceipt {
  const version = (value as { schema_version?: unknown } | null)?.schema_version;
  const terminalField = version === 2 ? "archive" : "replication";
  const hasConfirmation = !!value && typeof value === "object" && Object.hasOwn(value, terminalField);
  const r = object(value, ["schema_version","event_id","payload_sha256","state","server_timestamp","subject","course_id", ...(hasConfirmation ? [terminalField] : [])]);
  const terminalState = version === 2 ? "archived" : "replicated";
  if ((version !== 1 && version !== 2) || typeof r.event_id !== "string" || !id.test(r.event_id) || typeof r.payload_sha256 !== "string" || !hash.test(r.payload_sha256) ||
      !["queued","received",terminalState].includes(r.state) || !date(r.server_timestamp) ||
      typeof r.subject !== "string" || !label.test(r.subject) || typeof r.course_id !== "string" || !label.test(r.course_id) ||
      (r.state === terminalState) !== hasConfirmation) throw new Error("Invalid recovery receipt.");
  if (hasConfirmation) {
    const keys = version === 2 ? ["receipt_id","store_id","policy_id"] : ["receipt_id","generation","replica_id"];
    const confirmation = object(r[terminalField], keys);
    if (!Object.values(confirmation).every(x => typeof x === "string" && label.test(x))) throw new Error("Invalid recovery storage confirmation.");
  }
  return structuredClone(r) as RecordReceipt;
}
