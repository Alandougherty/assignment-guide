import { validateWorkspace, type WorkspaceContext } from "./workspace";
import { validatePreferences, type TutorPreferences } from "./preferences";
import { safeAssignmentPath } from "./assignments";

export const MAX_FILE_BYTES = 200_000;
export const MAX_PROMPT_BYTES = 16_000;

export type AssignmentRef = { id: string; version: string };
export type Snapshot = {
  path: string;
  language: string;
  text: string;
  documentVersion: number;
  selection: { start: number; end: number } | null;
  preferences?: TutorPreferences;
  workspace?: WorkspaceContext;
  requestEdit?: boolean;
};
type Base = { id: string; schema: 1; ts: string; submissionId: string };
export type Submission = Base & {
  type: "submission";
  studentId: string;
  sessionId: string;
  assignment: AssignmentRef;
  prompt: string;
  snapshot: Snapshot;
};
export type Attempt = Base & { type: "attempt"; attemptId: string };
export type Reply = { prose: string; model: string; usage: null; complete: true };
export type Outcome = Base & {
  type: "outcome";
  attemptId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  reply: Reply | null;
  error: string | null;
};
export type Event = Submission | Attempt | Outcome;
export type Mode = "normal" | "failure" | "timeout" | "malformed";
export type Turn = { submission: Submission; attempts: { start: Attempt; outcome?: Outcome }[] };

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function string(v: unknown): v is string { return typeof v === "string"; }
export function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (object(value) && Object.hasOwn(value, "requestEdit") && typeof value.requestEdit !== "boolean") throw new Error("Invalid edit request flag.");
  if (object(value) && Object.hasOwn(value, "workspace")) {
    validateWorkspace(value.workspace);
    if (value.path !== "workspace" || value.language !== "plaintext" || value.text !== "" || value.documentVersion !== 1 || value.selection !== null ||
        Object.keys(value).some(key => !["path", "language", "text", "documentVersion", "selection", "workspace", "preferences", "requestEdit"].includes(key))) {
      throw new Error("Invalid workspace snapshot header.");
    }
    if (Object.hasOwn(value, "preferences")) validatePreferences(value.preferences);
    return;
  }
  if (object(value) && value.path === "workspace") throw new Error("A workspace snapshot requires its captured file bundle.");
  if (!object(value) || !safeAssignmentPath(value.path) ||
      !string(value.language) || !/^[A-Za-z0-9_-]{1,50}$/.test(value.language) || !string(value.text) ||
      Buffer.byteLength(value.text, "utf8") > MAX_FILE_BYTES ||
      !Number.isInteger(value.documentVersion) || Number(value.documentVersion) < 1) {
    throw new Error("Open a registered assignment file (at most 200,000 bytes) in the recognised assignment folder.");
  }
  if (Object.hasOwn(value, "preferences")) validatePreferences(value.preferences);
  const s = value.selection;
  if (s !== null && (!object(s) || !Number.isInteger(s.start) || !Number.isInteger(s.end) ||
      Number(s.start) < 0 || Number(s.end) < Number(s.start) || Number(s.end) > value.text.length)) {
    throw new Error("Invalid editor selection.");
  }
}
