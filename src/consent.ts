import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./service/protocol";
import type { Session } from "./remote";
import type { AssignmentRef } from "./domain";

/** No credentials or notice text are persisted in the remembered approval. */
export function consentFingerprint(endpoint: string, session: Session, assignment: AssignmentRef): string {
  return digest({ schema: 1, endpoint, subject: session.subject, displayIdentity: session.displayIdentity,
    noticeVersion: session.noticeVersion, notice: session.notice, course: session.course ?? null,
    assignment, ...(session.subclass ? { subclass: session.subclass } : {}), archivePolicy: session.recovery?.archive_policy ?? null });
}
export function consentMatches(saved: unknown, fingerprint: string): boolean {
  return typeof saved === "object" && saved !== null &&
    (saved as Record<string, unknown>).schema === 1 &&
    (saved as Record<string, unknown>).fingerprint === fingerprint;
}

function approvalPath(directory: string, connection: string): string {
  if (!/^[a-f0-9]{64}$/.test(connection)) throw new Error("Invalid consent connection binding.");
  return join(directory, connection + ".json");
}
export async function readConsent(directory: string, connection: string): Promise<unknown> {
  try { return JSON.parse(await readFile(approvalPath(directory, connection), "utf8")); }
  catch { return undefined; } // Missing or unreadable approval always asks again.
}
export async function saveConsent(directory: string, connection: string, fingerprint?: string): Promise<void> {
  const target = approvalPath(directory, connection);
  if (fingerprint === undefined) {
    try { await unlink(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid consent fingerprint.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, randomUUID() + ".tmp");
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ schema: 1, fingerprint })); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, target);
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}
