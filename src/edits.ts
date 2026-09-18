import { createHash } from "node:crypto";
import type { Snapshot } from "./domain";
import { eligibleWorkspacePath } from "./workspace";

export type EditProposal = { path: string; before: string; after: string; baseDigest: string };
type EditSnapshot = Snapshot & { requestEdit?: boolean };
export class EditValidationError extends Error {
  constructor(readonly reason: string) { super("Invalid tutor edit proposal. No file has been changed."); }
}
const invalid = (reason = "invalid-proposal") => new EditValidationError(reason);
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && Buffer.from(value, "utf8").toString("utf8") === value;
}
function digest(value: string): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
/** Pure wire validation. Applying an edit additionally requires its original submission and current editor checks. */
export function validateEdit(value: unknown): asserts value is EditProposal {
  if (!fields(value, ["path", "before", "after", "baseDigest"]) || !eligibleWorkspacePath(value.path) ||
      !text(value.before, 8_000) || !text(value.after, 8_000) || value.before === value.after ||
      typeof value.baseDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.baseDigest) || value.baseDigest !== digest(value.before)) throw invalid();
}
function capturedText(snapshot: EditSnapshot, path: string): string {
  if (snapshot.workspace) {
    const matches = snapshot.workspace.files.filter(file => file.path === path);
    if (matches.length !== 1) throw invalid("target-not-captured");
    return matches[0]!.text;
  }
  if (snapshot.path !== path) throw invalid("target-not-captured");
  return snapshot.text;
}
export function validateEditForSubmission(value: unknown, snapshot: EditSnapshot, allowedPaths: readonly string[]): asserts value is EditProposal {
  validateEdit(value);
  if (snapshot.requestEdit !== true) throw invalid("edit-not-requested");
  if (!allowedPaths.includes(value.path)) throw invalid("target-not-allowed");
  if (capturedText(snapshot, value.path) !== value.before) throw invalid("before-mismatch");
}

/** Parse one exact replacement. Never extract JSON from surrounding prose or Markdown fences. */
export function parseEditResponse(prose: string, snapshot: EditSnapshot, allowedPaths: readonly string[]): { prose: string; edit?: EditProposal } {
  if (typeof prose !== "string" || Buffer.byteLength(prose, "utf8") > 64_000) throw invalid("response-too-large");
  let value: unknown;
  try { value = JSON.parse(prose); } catch { throw invalid("invalid-json"); }
  if (!fields(value, ["prose", "edit"])) throw invalid("response-fields");
  if (!text(value.prose, 16_000) || !value.prose.trim()) throw invalid("invalid-prose");
  if (value.edit === null) return { prose: value.prose };
  if (!fields(value.edit, ["path", "oldText", "newText"])) throw invalid("edit-fields");
  if (!eligibleWorkspacePath(value.edit.path)) throw invalid("unsafe-target");
  if (!allowedPaths.includes(value.edit.path)) throw invalid("target-not-allowed");
  if (!text(value.edit.oldText, 4_000) || value.edit.oldText.length === 0) throw invalid("invalid-old-text");
  if (!text(value.edit.newText, 4_000)) throw invalid("invalid-new-text");
  const before = capturedText(snapshot, value.edit.path);
  const at = before.indexOf(value.edit.oldText);
  if (at < 0) throw invalid("old-text-not-found");
  if (before.indexOf(value.edit.oldText, at + 1) !== -1) throw invalid("old-text-not-unique");
  const after = before.slice(0, at) + value.edit.newText + before.slice(at + value.edit.oldText.length);
  if (after === before) throw invalid("no-change");
  if (!text(after, 8_000)) throw invalid("invalid-result-text");
  const edit: EditProposal = { path: value.edit.path, before, after, baseDigest: digest(before) };
  validateEditForSubmission(edit, snapshot, allowedPaths);
  return { prose: value.prose, edit };
}
