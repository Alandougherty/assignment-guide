import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { parseRecoveryJson } from "./json";
import { validateContext, validateArchivePolicy, type ArchivePolicy, type RecoveryContext } from "./protocol";

export type ArchiveApproval = { schema_version: 1; origin: string; subject: string; course_id: string;
  store_id: string; policy_id: string; notice_version: string; approved_at: string };
export function validateArchiveApproval(value: unknown): ArchiveApproval {
  const a = value as ArchiveApproval;
  if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).sort().join() !==
      "approved_at,course_id,notice_version,origin,policy_id,schema_version,store_id,subject" || a.schema_version !== 1) throw new Error("Invalid archive approval.");
  validateContext({ origin: a.origin, subject: a.subject, courseId: a.course_id });
  validateArchivePolicy({ store_id: a.store_id, policy_id: a.policy_id });
  if (typeof a.notice_version !== "string" || !a.notice_version.trim() || Buffer.byteLength(a.notice_version) > 1000 || /[\x00-\x1f\x7f]/.test(a.notice_version) ||
      typeof a.approved_at !== "string" || !Number.isFinite(Date.parse(a.approved_at)) || new Date(a.approved_at).toISOString() !== a.approved_at) throw new Error("Invalid archive approval.");
  return structuredClone(a);
}
export function approvalMatches(a: ArchiveApproval | undefined, context: RecoveryContext, policy: ArchivePolicy, notice: string): boolean {
  return !!a && a.origin === context.origin && a.subject === context.subject && a.course_id === context.courseId &&
    a.store_id === policy.store_id && a.policy_id === policy.policy_id && a.notice_version === notice;
}
export function archiveApprovalPath(directory: string, context: RecoveryContext): string {
  validateContext(context);
  return join(directory, createHash("sha256").update(JSON.stringify([context.origin, context.subject, context.courseId])).digest("hex") + ".json");
}
export async function readArchiveApproval(directory: string, context: RecoveryContext): Promise<ArchiveApproval | undefined> {
  let file;
  try {
    file = await open(archiveApprovalPath(directory, context), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid archive approval file.");
    const a = validateArchiveApproval(parseRecoveryJson(new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile())));
    if (a.origin !== context.origin || a.subject !== context.subject || a.course_id !== context.courseId) throw new Error("Archive approval identity mismatch.");
    return a;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await file?.close(); }
}
export async function writeArchiveApproval(directory: string, value: ArchiveApproval): Promise<void> {
  const a = validateArchiveApproval(value);
  if (process.platform === "win32") throw new Error("Durable archive approval is not supported on this platform.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = archiveApprovalPath(directory, { origin: a.origin, subject: a.subject, courseId: a.course_id });
  const temporary = join(directory, randomUUID() + ".tmp");
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(a)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    // A prior interrupted attempt may have created any ancestor without flushing
    // its parent. Re-establish the full chain on every attempt, including retries.
    for (let current = resolve(directory); ; current = dirname(current)) {
      const dir = await open(current, "r"); try { await dir.sync(); } finally { await dir.close(); }
      if (current === dirname(current)) break;
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}
