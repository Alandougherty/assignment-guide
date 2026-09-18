/** Optional service-owned display metadata. Never authorises another dispatch. */
export type ProviderProgress = { schema: 1; phase: "provider-wait" | "generating"; revision: number; retryAt: string | null };
export function providerProgress(value: unknown): ProviderProgress | undefined {
  const p = value as ProviderProgress;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join() !== "phase,retryAt,revision,schema" ||
      p.schema !== 1 || !["provider-wait", "generating"].includes(p.phase) || !Number.isSafeInteger(p.revision) || p.revision < 1 ||
      (p.phase === "generating" ? p.retryAt !== null : typeof p.retryAt !== "string" || p.retryAt.length !== 24 ||
        !Number.isFinite(Date.parse(p.retryAt)) || new Date(p.retryAt).toISOString() !== p.retryAt)) return undefined;
  return { schema: 1, phase: p.phase, revision: p.revision, retryAt: p.retryAt };
}
