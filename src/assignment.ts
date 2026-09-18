import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { AssignmentRef } from "./domain";

import { safeAssignmentPath, validateAssignmentRef, type AssignmentFile } from "./assignments";
export * from "./assignments";

export async function recognise(folder: string): Promise<{ root: string; assignment: AssignmentRef }> {
  const root = await realpath(folder);
  const git = await lstat(resolve(root, ".git"));
  if (git.isSymbolicLink() || (!git.isFile() && !git.isDirectory())) throw new Error("Open a Git assignment repository.");
  const markerPath = resolve(root, "assignment.json");
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 16_000) throw new Error("Invalid assignment marker.");
  const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
  if (typeof marker !== "object" || marker === null) throw new Error("Invalid assignment marker.");
  const m = marker as Record<string, unknown>;
  if (m.schema_version !== 1 || typeof m.assignment_id !== "string" || typeof m.assignment_version !== "string") throw new Error("Invalid assignment marker.");
  const assignment = { id: m.assignment_id, version: m.assignment_version };
  validateAssignmentRef(assignment);
  return { root, assignment };
}

export async function assignmentFile(root: string, filename: string, files: readonly AssignmentFile[]): Promise<string> {
  const canonicalRoot = await realpath(root);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Attach a regular assignment file, not a symbolic link.");
  const requested = relative(canonicalRoot, resolve(await realpath(dirname(filename)), basename(filename))).split(sep).join("/");
  if (!safeAssignmentPath(requested) || !files.some(f => f.path === requested)) throw new Error("Only registered assignment files can be attached.");
  const canonical = await realpath(filename);
  const local = relative(canonicalRoot, canonical).split(sep).join("/");
  if (local !== requested || !safeAssignmentPath(local)) throw new Error("Assignment files must remain inside their repository without symbolic-link redirects.");
  return local;
}
