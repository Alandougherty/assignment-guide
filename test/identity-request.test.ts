import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { identityRequest, identityRetryPath, IdentityRequestUnavailable } from "../src/identity-request";
const busy = () => ({ schema: 1, code: "identity-unavailable", retryable: true, message: "Busy", requestId: randomUUID() });
const response = (value: unknown, status = 503) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const options = () => ({ url: "https://synthetic.invalid/v1/test", method: "PUT", token: "synthetic", body: '{"schema":1}', signal: new AbortController().signal,
  handle: async (r: Response) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); } });

test("trial retries only exact submission and attempt paths, preserving bytes and credentials", async t => {
  const sid = randomUUID(), aid = randomUUID(), path = `/v1/submissions/${sid}`;
  for (const [method, route] of [["PUT", path], ["GET", `${path}/attempts/${aid}`], ["PUT", `${path}/attempts/${aid}`]]) assert.ok(identityRetryPath(route!, method!));
  for (const [method, route] of [["POST", "/v1/consents"], ["GET", path], ["PUT", "/v1/events/" + aid], ["POST", `${path}/attempts/${aid}/cancel`], ["PUT", path + "?x=1"], ["PUT", "/v1/records/x"]]) assert.equal(identityRetryPath(route!, method!), false);
  t.mock.method(Math, "random", () => 0);
  const sent: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => { sent.push(init!); return sent.length < 3 ? response(busy()) : response({ done: true }, 200); });
  assert.deepEqual(await identityRequest(options()), { done: true });
  assert.equal(sent.length, 3);
  for (const request of sent) { assert.equal(request.body, '{"schema":1}'); assert.deepEqual(request.headers, sent[0]!.headers); assert.equal(request.redirect, "error"); }
});

test("trial exhausts at four attempts, and respects an original polling deadline", async t => {
  t.mock.method(Math, "random", () => 0); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(busy()); });
  await assert.rejects(identityRequest(options()), IdentityRequestUnavailable); assert.equal(calls, 4);
  calls = 0; const start = performance.now();
  await assert.rejects(identityRequest({ ...options(), deadline: start + 80 }), IdentityRequestUnavailable);
  assert.equal(calls, 1); assert.ok(performance.now() - start < 200);
});

test("trial does not retry malformed rejections, other statuses or transport loss", async t => {
  let calls = 0, next: () => Response = () => response(busy());
  t.mock.method(globalThis, "fetch", async () => { calls++; return next(); });
  const invalid: (() => Response)[] = [
    () => response({ ...busy(), code: "unavailable" }), () => response({ ...busy(), extra: 1 }),
    () => response({ ...busy(), retryable: false }), () => response({ ...busy(), requestId: "bad" }),
    () => new Response('{"schema":1,"schema":1}', { status: 503, headers: { "content-type": "application/json" } }),
    () => new Response('{"message":"\\ud800"}', { status: 503, headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff]), { status: 503, headers: { "content-type": "application/json" } }),
    () => new Response(' '.repeat(4097), { status: 503, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify(busy()), { status: 503, headers: { "content-type": "text/plain" } }),
    ...[401, 403, 429, 500, 502, 504].map(status => () => response(busy(), status)),
    () => { throw new Error("Connection lost"); },
  ];
  for (next of invalid) { calls = 0; await assert.rejects(identityRequest(options())); assert.equal(calls, 1); }
});

test("cancel interrupts backoff, ignored-abort fetch, and stalled body without another dispatch", async t => {
  let calls = 0, mode = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (mode === 1) return new Promise<Response>(() => {});
    if (mode === 2) return new Response(new ReadableStream({ start() {} }), { status: 503, headers: { "content-type": "application/json" } });
    return response(busy());
  });
  for (mode of [0, 1, 2]) {
    calls = 0; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30);
    try { await assert.rejects(identityRequest({ ...options(), signal: controller.signal }), /cancelled/); }
    finally { clearTimeout(timer); }
    assert.equal(calls, 1);
  }
});

test("original deadline bounds a fetch which ignores AbortSignal", async t => {
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => {}));
  const start = performance.now();
  await assert.rejects(identityRequest({ ...options(), deadline: start + 80 }));
  assert.ok(performance.now() - start < 300);
});

test("default total budget stays ten seconds even if the per-request timeout is larger", async t => {
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => {}));
  const start = performance.now();
  await assert.rejects(identityRequest({ ...options(), timeoutMs: 60_000 }));
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 9900 && elapsed < 11_000, `Observed ${elapsed}ms`);
});
