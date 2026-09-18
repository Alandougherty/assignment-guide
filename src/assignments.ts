import type { AssignmentRef } from "./domain";
export type AssignmentFile = { path: string; language: string };
export type AssignmentDefinition = { id: string; version: string; title: string; brief: string; objectives: string; constraints: string; examples: string; teaching: string; starter: string; files?: AssignmentFile[] };

export function validateAssignmentRef(value: unknown): asserts value is AssignmentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid assignment reference.");
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v.id) || typeof v.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v.version)) throw new Error("Invalid assignment reference.");
}
export function safeAssignmentPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 && value.split("/").every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part));
}
// Legacy v1 wire compatibility: omitted files historically meant assignment.py.
// New course definitions should always provide files. Removing this fallback
// requires a versioned server contract; see docs/release-readiness.md.
export function assignmentFiles(value: AssignmentDefinition): readonly AssignmentFile[] {
  return value.files ?? [{ path: "assignment.py", language: "python" }];
}
export function validateDefinition(value: unknown): asserts value is AssignmentDefinition {
  validateAssignmentRef(value);
  const v = value as unknown as Record<string, unknown>;
  const fields = ["id", "version", "title", "brief", "objectives", "constraints", "examples", "teaching", "starter"];
  if (Object.keys(v).some(k => ![...fields, "files"].includes(k)) || fields.some(k => typeof v[k] !== "string" || !(v[k] as string).trim() || Buffer.byteLength(v[k] as string) > 32_000) || Buffer.byteLength(JSON.stringify(v)) > 64_000) throw new Error("Invalid assignment definition.");
  if (v.files !== undefined) {
    if (!Array.isArray(v.files) || v.files.length < 1 || v.files.length > 20) throw new Error("Invalid assignment files.");
    const seen = new Set<string>();
    for (const f of v.files) {
      if (!f || typeof f !== "object" || Object.keys(f).length !== 2 || !safeAssignmentPath(f.path) || typeof f.language !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(f.language) || seen.has(f.path)) throw new Error("Invalid assignment files.");
      seen.add(f.path);
    }
  }
}
