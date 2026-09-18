import { CLIENT_USER_AGENT } from "./client-version";
import { abortable, checkSessionSignal, connectionSleep, isIdentityRejection, readConnectionJson } from "./session-connection";

export class IdentityRequestUnavailable extends Error {
  constructor() { super("Course service is busy. Your original request is saved; reconnect to recover it."); }
}
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const submission = new RegExp(`^/v1/submissions/${uuid}$`);
const attempt = new RegExp(`^/v1/submissions/${uuid}/attempts/${uuid}$`);
export function identityRetryPath(path: string, method: string): boolean {
  return method === "PUT" && submission.test(path) || ["GET", "PUT"].includes(method) && attempt.test(path);
}
/** Opt-in trial only. Retry an explicit pre-handler rejection, never a transport ambiguity.
 * Success parsing remains inside the total operation budget. Original bytes/IDs are fixed.
 */
export async function identityRequest<T>(options: {
  url: string; method: string; token: string; body?: string; signal: AbortSignal;
  timeoutMs?: number; deadline?: number; handle: (response: Response, signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const deadline = Math.min(performance.now() + 10_000, options.deadline ?? Infinity);
  for (let attempt = 1; attempt <= 4; attempt++) {
    checkSessionSignal(options.signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new IdentityRequestUnavailable();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, Math.min(options.timeoutMs ?? 10_000, remaining));
    try {
      checkSessionSignal(options.signal);
      const response = await abortable(fetch(options.url, { method: options.method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${options.token}`, "User-Agent": CLIENT_USER_AGENT,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: options.body }) }), controller.signal);
      checkSessionSignal(options.signal);
      if (response.status !== 503) return await abortable(options.handle(response, controller.signal), controller.signal);
      const json = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
      if (!json) { void response.body?.cancel().catch(() => undefined); throw new IdentityRequestUnavailable(); }
      const rejection = await readConnectionJson(response, 4096, controller.signal);
      checkSessionSignal(options.signal);
      if (!isIdentityRejection(rejection)) throw new IdentityRequestUnavailable();
    } catch (error) {
      checkSessionSignal(options.signal);
      if (controller.signal.aborted) throw new Error("Request deadline expired; preserve the original request ID.");
      throw error;
    } finally {
      clearTimeout(timer); options.signal.removeEventListener("abort", cancel);
    }
    if (attempt === 4) break;
    const base = 250 * 2 ** (attempt - 1), delay = base + Math.floor(Math.random() * (base + 1));
    if (delay >= deadline - performance.now()) break;
    await connectionSleep(delay, options.signal);
  }
  throw new IdentityRequestUnavailable();
}
