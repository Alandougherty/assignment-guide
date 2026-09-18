import { parseRecoveryJson } from "./recovery/json";
export type SessionConnectionState =
  | { phase: "connecting"; attempt: 1|2|3|4; maxAttempts: 4 }
  | { phase: "waiting"; attempt: 1|2|3; maxAttempts: 4; delayMs: number }
  | { phase: "connected" } | { phase: "cancelled" }
  | { phase: "failed"; reason: "busy"|"authentication"|"forbidden"|"unavailable"|"invalid-response" };
export class SessionConnectionCancelled extends Error { constructor() { super("Connection cancelled."); } }
export class SessionConnectionFailure extends Error {
  constructor(readonly reason: Extract<SessionConnectionState, {phase:"failed"}>["reason"], readonly status?: number) {
    super(reason === "busy" ? "Course service is busy. Please try connecting again shortly." : status !== undefined
      ? `Course service request failed (${status}). Check your course key and reconnect.` : "Could not connect to your course. Please try again shortly.");
  }
}
export function reportSession(callback: ((state: SessionConnectionState) => void) | undefined, state: SessionConnectionState): void {
  try { void Promise.resolve(callback?.(state)).catch(() => undefined); } catch { /* Feedback cannot fail authentication. */ }
}
export function checkSessionSignal(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof SessionConnectionFailure ? signal.reason : new SessionConnectionCancelled(); }
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof SessionConnectionFailure ? signal.reason : new SessionConnectionCancelled());
    if (signal.aborted) { void promise.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, {once:true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function body(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal); if (next.done) break;
      bytes += next.value.length; if (bytes > limit) throw new Error("Oversized body"); chunks.push(next.value);
    }
    return parseRecoveryJson(new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks)));
  } finally { void reader.cancel().catch(() => undefined); }
}
function retryable(value: any): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === "code,message,requestId,retryable,schema" && value.schema === 1 &&
    value.code === "identity-unavailable" && value.retryable === true &&
    typeof value.message === "string" && !!value.message.trim() && value.message.length <= 500 && !/[\x00-\x1f\x7f]/.test(value.message) &&
    typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId);
}
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
/** Only this read operation retries. No consent or coursework request enters here. */
export async function sessionGet(options: { endpoint:string; token:string; signal:AbortSignal; timeoutMs?:number; archive?:boolean;
  forbiddenMessage?: (response:Response)=>Promise<string>; report?: (state:SessionConnectionState)=>void }): Promise<any> {
  const deadline = performance.now() + 10_000;
  let busy = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    checkSessionSignal(options.signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new SessionConnectionFailure(busy ? "busy" : "unavailable");
    reportSession(options.report, {phase:"connecting",attempt:attempt as 1|2|3|4,maxAttempts:4});
    const controller = new AbortController(); const cancel = () => controller.abort();
    options.signal.addEventListener("abort", cancel, {once:true});
    const timer = setTimeout(cancel, Math.min(options.timeoutMs ?? 10_000, remaining));
    try {
      checkSessionSignal(options.signal);
      const response = await abortable(fetch(options.endpoint + "/v1/session", {method:"GET",redirect:"error",signal:controller.signal,
        headers:{Authorization:`Bearer ${options.token}`, "User-Agent":"AssignmentTutorV2/0.3 (course-client)", ...(options.archive ? {"X-Record-Protocol":"2"} : {})}}), controller.signal);
      const json = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
      if (!response.ok && response.status !== 503) {
        if (response.status === 403 && options.forbiddenMessage) {
          const denied = new SessionConnectionFailure("forbidden",403);
          denied.message = await abortable(options.forbiddenMessage(response),controller.signal); throw denied;
        }
        void response.body?.cancel().catch(() => undefined);
        throw new SessionConnectionFailure(response.status === 401 ? "authentication" : response.status === 403 ? "forbidden" : "unavailable",response.status);
      }
      if (!json) { void response.body?.cancel().catch(() => undefined); throw new SessionConnectionFailure("invalid-response"); }
      const value = await body(response, response.ok ? 1_048_576 : 4096, controller.signal);
      checkSessionSignal(options.signal);
      if (response.ok) return value;
      if (!retryable(value)) throw new SessionConnectionFailure("invalid-response",503);
      busy = true;
    } catch (error) {
      checkSessionSignal(options.signal);
      if (error instanceof SessionConnectionFailure) throw error;
      throw new SessionConnectionFailure(controller.signal.aborted ? "unavailable" : "invalid-response");
    } finally { clearTimeout(timer); options.signal.removeEventListener("abort",cancel); }
    if (attempt === 4) break;
    const base = 250 * 2 ** (attempt - 1), delayMs = base + Math.floor(Math.random() * (base + 1));
    if (delayMs >= deadline - performance.now()) break;
    reportSession(options.report,{phase:"waiting",attempt:attempt as 1|2|3,maxAttempts:4,delayMs});
    await sleep(delayMs,options.signal);
  }
  throw new SessionConnectionFailure("busy",503);
}
