import { parseRecoveryJson } from "./json";
import { validateAssignmentRef } from "../assignment";
import type { AssignmentRef } from "../domain";
import { sameContext, validateContext, validateArchivePolicy, type ArchivePolicy, type RecoveryContext } from "./protocol";
import { RecoveryAuthenticationError, type RecoveryCredential } from "./worker";

/** Archival session extension. Normal recovery remains disabled; isolated integration only. */
export async function recoveryCredential(options: {
  protocolVersion?: 1 | 2; archivePolicy?: ArchivePolicy;
  context: RecoveryContext; assignment: AssignmentRef; noticeVersion: string; token: string;
  signal?: AbortSignal; requireAccepted?: boolean; allowLoopback?: boolean; fetch?: typeof fetch;
}): Promise<RecoveryCredential> {
  const context = validateContext(options.context);
  const version = options.protocolVersion ?? 1;
  if (version !== 1 && version !== 2) throw new RecoveryAuthenticationError("Unsupported record protocol.");
  if (version === 2 && options.requireAccepted !== false && !options.archivePolicy) throw new RecoveryAuthenticationError("Confirm the archive policy first.");
  validateAssignmentRef(options.assignment);
  const url = new URL(context.origin);
  if (url.protocol !== "https:" && !(options.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new RecoveryAuthenticationError("Unapproved recovery origin.");
  if (!options.token || /\s/.test(options.token)) throw new RecoveryAuthenticationError("Reconfirm the course connection.");
  const response = await (options.fetch ?? fetch)(`${context.origin}/v1/session`, {
    method: "GET", redirect: "error", signal: options.signal,
    headers: { Authorization: `Bearer ${options.token}`, ...(version === 2 ? { "X-Record-Protocol": "2" } : {}) },
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new RecoveryAuthenticationError("Reconfirm the course identity.");
    throw new Error("Recovery identity lookup unavailable.");
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
    await response.body?.cancel(); throw new RecoveryAuthenticationError("Invalid recovery identity response.");
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new RecoveryAuthenticationError("Oversized recovery identity response.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  try {
    const s = parseRecoveryJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!s || s.schema !== 1 || (options.requireAccepted !== false && s.accepted !== true) || s.noticeVersion !== options.noticeVersion ||
        !sameContext({ origin: context.origin, subject: s.subject, courseId: s.course?.id }, context)) throw new Error();
    const grant = s.recovery;
    if (!grant || typeof grant !== "object" || Array.isArray(grant) ||
        Object.keys(grant).sort().join() !== ["schema_version", "course_id", "query_missing", "assignments", ...(version === 2 ? ["archive_policy"] : [])].sort().join() ||
        grant.schema_version !== version || grant.course_id !== context.courseId || grant.query_missing !== true || !Array.isArray(grant.assignments) || grant.assignments.length > 1000) throw new Error();
    const seen = new Set<string>();
    for (const ref of grant.assignments) {
      validateAssignmentRef(ref);
      if (Object.keys(ref).sort().join() !== "id,version" || seen.has(JSON.stringify([ref.id, ref.version]))) throw new Error();
      seen.add(JSON.stringify([ref.id, ref.version]));
    }
    if (!seen.has(JSON.stringify([options.assignment.id, options.assignment.version]))) throw new Error();
    if (version === 2) {
      const archivePolicy = validateArchivePolicy(grant.archive_policy);
      if (options.archivePolicy) {
        const expected = validateArchivePolicy(options.archivePolicy);
        if (archivePolicy.store_id !== expected.store_id || archivePolicy.policy_id !== expected.policy_id) throw new Error();
      }
      return { ...context, token: options.token, protocolVersion: 2, archivePolicy };
    }
    return { ...context, token: options.token };
  } catch { throw new RecoveryAuthenticationError("Recovery permission or identity changed. Reconfirm before uploading."); }
}
