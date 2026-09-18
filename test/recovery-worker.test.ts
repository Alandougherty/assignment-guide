import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeEvent, type RecordEvent, type RecordReceipt, type RecoveryContext } from "../src/recovery/protocol";
import { RecoveryAuthenticationError, RecoveryWorker, type RecoveryCredential, type RecoveryQueueLike } from "../src/recovery/worker";

const context: RecoveryContext = { origin: "https://course.invalid", subject: "synthetic-student", courseId: "synthetic-course" };
function event(sequence: number, eventKind: RecordEvent["event_kind"] = "submission", text = "Synthetic prompt"): RecordEvent {
  return makeEvent({ event_id: randomUUID(), turn_id: randomUUID(), session_id: randomUUID(), assignment: { id: "synthetic-assignment", version: "1.0.0" }, client_sequence: sequence,
    event_kind: eventKind, client_timestamp: "2026-09-14T00:00:00.000Z", data: { text } });
}
function receipt(event: RecordEvent, state: Extract<RecordReceipt, { schema_version: 1 }>["state"] = "received"): RecordReceipt {
  return { schema_version: 1, event_id: event.event_id, payload_sha256: event.payload_sha256, state, server_timestamp: "2026-09-14T00:00:01.000Z", subject: context.subject, course_id: context.courseId,
    ...(state === "replicated" ? { replication: { receipt_id: randomUUID(), generation: "generation-1", replica_id: "replica-1" } } : {}) };
}
class FakeQueue implements RecoveryQueueLike {
  context = { ...context };
  events: RecordEvent[];
  receipts = new Map<string, RecordReceipt>();
  acknowledgements = 0;
  constructor(events: RecordEvent[]) { this.events = structuredClone(events); }
  async pending() { return structuredClone(this.events); }
  async receipt(id: string) { return this.receipts.get(id); }
  async acknowledge(receipt: RecordReceipt) { this.acknowledgements++; this.receipts.set(receipt.event_id, structuredClone(receipt)); }
  async cleanup() { this.events = this.events.filter(event => this.receipts.get(event.event_id)?.state !== "replicated"); }
}
function response(receipts: RecordReceipt[] = [], missing?: RecordEvent[], errors: { event_id: string; code: string }[] = []) {
  return Response.json({ schema_version: 1, receipts, errors, ...(missing ? { missing: missing.map(({ event_id, payload_sha256 }) => ({ event_id, payload_sha256 })) } : {}) });
}
type Request = { path: string; events: RecordEvent[]; token: string; bytes: number };
function fixture(events: RecordEvent[], handler: (request: Request) => Response | Promise<Response>) {
  const queue = new FakeQueue(events); let now = 0; const calls: Request[] = [];
  let credential: RecoveryCredential = { ...context, token: "synthetic-token-1" };
  const worker = new RecoveryWorker(queue, { now: () => now, random: () => 0.5, credentials: async () => ({ ...credential }), fetch: (async (url, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.method, "POST");
    const path = new URL(String(url)).pathname;
    // No inference endpoint exists in this fake service.
    assert.ok(["/records/v1/receipts", "/records/v1/events"].includes(path));
    const body = String(init?.body); const request = { path, events: JSON.parse(body).events as RecordEvent[], token: (init?.headers as Record<string, string>).Authorization!, bytes: Buffer.byteLength(body) };
    calls.push(request); return handler(request);
  }) as typeof fetch });
  return { queue, worker, calls, setCredential(value: RecoveryCredential) { credential = value; }, advance(ms = 300_000) { now += ms; } };
}

test("record worker retries acknowledgement loss with identical immutable events and no inference", async () => {
  const original = event(1); const stored = new Map<string, RecordEvent>(); let loseAcknowledgement = true;
  const f = fixture([original], request => {
    if (request.path.endsWith("receipts")) return response(request.events.filter(e => stored.has(e.event_id)).map(e => receipt(stored.get(e.event_id)!, "replicated")), request.events.filter(e => !stored.has(e.event_id)));
    for (const e of request.events) stored.set(e.event_id, e);
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("Simulated lost acknowledgement"); }
    return response(request.events.map(e => receipt(e, "replicated")));
  });
  assert.equal(f.calls.length, 0); // Construction must not begin recovery.
  assert.equal((await f.worker.runOnce()).phase, "waiting");
  assert.deepEqual(f.queue.events, [original]); assert.equal(stored.size, 1);
  f.advance(); await f.worker.runOnce();
  assert.equal(stored.size, 1); assert.equal(f.queue.events.length, 0);
  assert.deepEqual(f.calls.find(c => c.path.endsWith("events"))!.events, [original]);
});

test("received then missing after failover resends original bytes and retains each unreplicated event", async () => {
  const prompt = event(1); const reply = event(2, "reply_final"); const outcome = event(3, "outcome"); let phase = 0;
  const f = fixture([prompt, reply, outcome], request => {
    if (request.path.endsWith("receipts")) return phase === 0 ? response([receipt(prompt), receipt(reply), receipt(outcome)], []) : response([], request.events);
    assert.deepEqual(request.events, [prompt, reply, outcome]);
    return response([receipt(prompt, "replicated"), receipt(reply, "queued"), receipt(outcome, "received")]);
  });
  await f.worker.runOnce(); assert.equal(f.queue.events.length, 3);
  phase++; f.advance(); await f.worker.runOnce();
  assert.deepEqual(f.queue.events, [reply, outcome]);
});

test("duplicate uploads are permitted when a receipt lookup is missing but central storage deduplicates", async () => {
  const original = event(1); const stored = new Map<string, string>(); let first = true;
  const f = fixture([original], request => {
    if (request.path.endsWith("receipts")) return response([], request.events);
    for (const item of request.events) { const before = stored.get(item.event_id); if (before) assert.equal(before, item.payload_utf8); stored.set(item.event_id, item.payload_utf8); }
    if (first) { first = false; throw new Error("Synthetic response lost"); }
    return response(request.events.map(e => receipt(e, "replicated")));
  });
  await f.worker.runOnce(); f.advance(); await f.worker.runOnce();
  assert.equal(stored.size, 1); assert.equal(f.calls.filter(c => c.path.endsWith("events")).length, 2); assert.equal(f.queue.events.length, 0);
});

test("identity and origin changes pause before record traffic; same identity token rotation resumes", async () => {
  for (const changed of [{ ...context, subject: "other-student" }, { ...context, courseId: "other-course" }, { ...context, origin: "https://other.invalid" }]) {
    const original = event(1);
    const f = fixture([original], request => request.path.endsWith("receipts") ? response([], request.events) : response(request.events.map(e => receipt(e))));
    f.setCredential({ ...changed, token: "changed-token" });
    assert.equal((await f.worker.runOnce()).phase, "paused-auth"); assert.equal(f.calls.length, 0); assert.equal(f.queue.events.length, 1);
    f.advance(); await f.worker.runOnce(); assert.equal(f.calls.length, 0);
    f.setCredential({ ...context, token: "synthetic-rotated-token" }); f.worker.resume(); await f.worker.runOnce();
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => c.token === "Bearer synthetic-rotated-token"));
  }
});

test("credentials are rechecked between receipt lookup and upload", async () => {
  const original = event(1);
  const f = fixture([original], request => { f.setCredential({ ...context, subject: "different-student", token: "different-key" }); return response([], request.events); });
  assert.equal((await f.worker.runOnce()).phase, "paused-auth"); assert.equal(f.calls.length, 1); assert.deepEqual(f.queue.events, [original]);
});

test("partial batches acknowledge only explicit successes; unmentioned and rejected records remain", async () => {
  const events = [event(1), event(2), event(3)];
  const f = fixture(events, () => response([receipt(events[0]!, "replicated")], [], [{ event_id: events[1]!.event_id, code: "storage_unavailable" }]));
  await f.worker.runOnce(); assert.equal(f.queue.acknowledgements, 1);
  // Cleanup can happen after a failed cycle or safely on its next invocation.
  await f.queue.cleanup(); assert.deepEqual(f.queue.events, events.slice(1));
});

test("foreign, duplicate, wrong-hash and malformed receipts acknowledge nothing", async () => {
  const original = event(1); const good = receipt(original, "replicated");
  const responses = [
    { receipts: [good, good], missing: [] },
    { receipts: [good, receipt(event(2))], missing: [] },
    { receipts: [{ ...good, subject: "other" }], missing: [] },
    { receipts: [{ ...good, course_id: "other" }], missing: [] },
    { receipts: [{ ...good, payload_sha256: "a".repeat(64) }], missing: [] },
    { receipts: [{ ...good, replication: undefined }], missing: [] },
    { receipts: [], missing: [{ event_id: original.event_id, payload_sha256: "b".repeat(64) }] },
    { receipts: [good], missing: [{ event_id: original.event_id, payload_sha256: original.payload_sha256 }] },
  ];
  for (const value of responses) {
    const f = fixture([original], () => Response.json({ schema_version: 1, errors: [], ...value }));
    assert.equal((await f.worker.runOnce()).reason, "invalid-record-response");
    assert.equal(f.queue.acknowledgements, 0); assert.deepEqual(f.queue.events, [original]);
  }
});

test("HTTP authentication and conflicts pause; Retry-After and exponential backoff bound retries", async () => {
  for (const status of [401, 403, 409]) {
    const f = fixture([event(1)], () => new Response(null, { status }));
    assert.equal((await f.worker.runOnce()).phase, status === 409 ? "paused-conflict" : "paused-auth");
    f.advance(); await f.worker.runOnce(); assert.equal(f.calls.length, 1);
  }
  const f = fixture([event(1)], () => new Response(null, { status: 429, headers: { "Retry-After": "600" } }));
  assert.equal((await f.worker.runOnce()).nextRunAt, 600_000);
  f.advance(599_999); await f.worker.runOnce(); assert.equal(f.calls.length, 1);
  f.advance(1); await f.worker.runOnce(); assert.equal(f.calls.length, 2);
  const g = fixture([event(1)], () => new Response(null, { status: 503 }));
  assert.equal((await g.worker.runOnce()).nextRunAt, 5_000);
  g.advance(5_000); assert.equal((await g.worker.runOnce()).nextRunAt, 15_000);
  g.advance(10_000); assert.equal((await g.worker.runOnce()).nextRunAt, 35_000);
});

test("record batches enforce event and encoded byte limits and rotate past unreplicated records", async () => {
  const small = Array.from({ length: 205 }, (_, index) => event(index + 1));
  const f = fixture(small, request => response(request.events.map(item => receipt(small.find(e => e.event_id === item.event_id)!)), []));
  await f.worker.runOnce(); f.advance(); await f.worker.runOnce(); f.advance(); await f.worker.runOnce();
  assert.ok(f.calls.every(c => c.events.length <= 100 && c.bytes <= 1024 * 1024));
  assert.equal(new Set(f.calls.flatMap(c => c.events.map(e => e.event_id))).size, 205);
  const large = Array.from({ length: 15 }, (_, index) => event(index + 1, "submission", '"'.repeat(40_000)));
  const g = fixture(large, request => request.path.endsWith("receipts") ? response([], request.events) : response(request.events.map(e => receipt(e))));
  await g.worker.runOnce(); g.advance(); await g.worker.runOnce(); g.advance(); await g.worker.runOnce();
  assert.ok(g.calls.every(c => c.bytes <= 1024 * 1024));
  assert.equal(new Set(g.calls.flatMap(c => c.events.map(e => e.event_id))).size, 15);
});

test("network waits do not lock the queue and concurrent runOnce joins one record operation", async () => {
  const original = event(1); const later = event(2, "reply_final");
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture([original], async () => { entered(); await waiting; return response([receipt(original)], []); });
  const first = f.worker.runOnce(); await started; const second = f.worker.runOnce();
  assert.equal(first, second); f.queue.events.push(later); assert.equal((await f.queue.pending()).length, 2);
  release(); await first; assert.equal(f.calls.length, 1); assert.deepEqual(f.queue.events, [original, later]);
});

test("redirects, oversized responses and stopped identity lookup retain records without leaking credentials", async () => {
  const f = fixture([event(1)], () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.invalid" } }));
  await f.worker.runOnce(); assert.equal(f.calls.length, 1); assert.equal(f.queue.acknowledgements, 0);
  const g = fixture([event(1)], () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }));
  assert.equal((await g.worker.runOnce()).reason, "record-response-exceeds-limit"); assert.equal(g.queue.events.length, 1);
  const queue = new FakeQueue([event(1)]); let complete!: (value: RecoveryCredential) => void; let calls = 0;
  const worker = new RecoveryWorker(queue, { credentials: () => new Promise(resolve => { complete = resolve; }), fetch: (async () => { calls++; return response(); }) as typeof fetch });
  const pending = worker.runOnce();
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  worker.stop(); complete({ ...context, token: "synthetic-secret" }); await pending;
  assert.equal(calls, 0); assert.equal(queue.events.length, 1); assert.ok(!JSON.stringify(worker.status).includes("synthetic-secret"));
});

test("record workers refuse unapproved origins and multiple active workers for one identity", async () => {
  for (const origin of ["http://course.invalid", "https://user:secret@course.invalid", "https://course.invalid/path", "https://course.invalid?token=x"]) {
    const queue = new FakeQueue([]); queue.context.origin = origin;
    assert.throws(() => new RecoveryWorker(queue, { credentials: async () => ({ ...context, token: "key" }) }), /origin/);
  }
  const first = fixture([], () => response([], [])); const second = fixture([], () => response([], []));
  first.worker.start();
  try { assert.throws(() => second.worker.start(), /already active/); }
  finally { first.worker.stop(); second.worker.stop(); }
});

test("corrupt or oversized local events pause visibly rather than retrying indefinitely", async () => {
  const original = event(1); const f = fixture([original], () => response([], []));
  f.queue.events[0]!.payload_utf8 = "x".repeat(1024 * 1024 + 1);
  assert.equal((await f.worker.runOnce()).phase, "paused-conflict"); assert.equal(f.calls.length, 0);
  f.advance(); await f.worker.runOnce(); assert.equal(f.calls.length, 0); assert.equal(f.queue.events.length, 1);
});

test("real HTTP transport and durable queue recover after restart without replaying inference", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { RecoveryQueue } = await import("../src/recovery/queue");
  const original = event(1); const stored = new Map<string, RecordEvent>(); let now = 0; let requests = 0;
  let replicated = false;
  const server = createServer(async (request, result) => {
    requests++;
    assert.equal(request.headers.authorization, "Bearer synthetic-key");
    assert.ok(["/records/v1/receipts", "/records/v1/events"].includes(request.url!));
    let raw = ""; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw).events as RecordEvent[];
    const data = request.url!.endsWith("receipts") ? {
      schema_version: 1, errors: [], receipts: input.filter(e => stored.has(e.event_id)).map(e => receipt(stored.get(e.event_id)!, replicated ? "replicated" : "received")),
      missing: input.filter(e => !stored.has(e.event_id)).map(({ event_id, payload_sha256 }) => ({ event_id, payload_sha256 })),
    } : { schema_version: 1, errors: [], receipts: input.map(e => { stored.set(e.event_id, e); return receipt(e); }) };
    result.setHeader("Content-Type", "application/json"); result.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(join(tmpdir(), "tutor-record-worker-")); const binding = { ...context, origin };
  let queue = await RecoveryQueue.open({ directory, context: binding });
  const options = { allowLoopback: true, now: () => now, random: () => 0.5, credentials: async () => ({ ...binding, token: "synthetic-key" }) };
  try {
    await queue.enqueue(original); const worker = new RecoveryWorker(queue, options);
    await worker.runOnce(); assert.equal(stored.size, 1); assert.deepEqual(await queue.pending(), [original]); worker.stop();
    await queue.close(); queue = await RecoveryQueue.open({ directory, context: binding });
    replicated = true; now += 5000; const restarted = new RecoveryWorker(queue, options);
    await restarted.runOnce(); restarted.stop();
    assert.equal((await queue.pending()).length, 0); assert.equal((await queue.receipt(original.event_id))!.state, "replicated");
    assert.equal(stored.size, 1); assert.equal(requests, 3);
  } finally { await queue.close(); await rm(directory, { recursive: true, force: true }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("temporary identity lookup failure retries automatically but explicit authentication failure pauses", async () => {
  const original = event(1); const queue = new FakeQueue([original]); let now = 0; let available = false; let calls = 0;
  const worker = new RecoveryWorker(queue, { now: () => now, random: () => 0.5,
    credentials: async () => { if (!available) throw new Error("Synthetic connection unavailable"); return { ...context, token: "synthetic-key" }; },
    fetch: (async () => { calls++; return response([receipt(original)], []); }) as typeof fetch });
  assert.equal((await worker.runOnce()).reason, "identity-unavailable"); assert.equal(worker.status.phase, "waiting"); assert.equal(calls, 0);
  available = true; now = 5000; await worker.runOnce(); assert.equal(calls, 1);
  const paused = new RecoveryWorker(queue, { credentials: async () => { throw new RecoveryAuthenticationError("Reconfirm identity"); } });
  assert.equal((await paused.runOnce()).phase, "paused-auth");
});

test("polling unchanged receipt state does not repeatedly write durable acknowledgement files", async () => {
  const original = event(1); const f = fixture([original], () => response([receipt(original)], []));
  await f.worker.runOnce(); f.advance(); await f.worker.runOnce();
  assert.equal(f.queue.acknowledgements, 1); assert.equal(f.queue.events.length, 1);
});

test("native HTTP fetch refuses redirects and times out without discarding records", async () => {
  const { createServer } = await import("node:http");
  let requests = 0; let redirect = true;
  const server = createServer((request, result) => {
    requests++;
    assert.equal(request.url, "/records/v1/receipts");
    if (redirect) { result.writeHead(302, { Location: "/unexpected-target" }); result.end(); }
    // The second request deliberately never receives a response.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const queue = new FakeQueue([event(1)]); queue.context.origin = origin; let now = 0;
  const worker = new RecoveryWorker(queue, { allowLoopback: true, requestTimeoutMs: 50, now: () => now, random: () => 0.5,
    credentials: async () => ({ ...context, origin, token: "synthetic-key" }) });
  try {
    await worker.runOnce(); assert.equal(requests, 1); assert.equal(queue.acknowledgements, 0);
    redirect = false; now += 5000; await worker.runOnce();
    assert.equal(requests, 2); assert.equal(queue.events.length, 1); assert.equal(worker.status.phase, "waiting");
  } finally { worker.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("invalid token whitespace and non-JSON successful replies never acknowledge events", async () => {
  const original = event(1);
  const f = fixture([original], () => response([receipt(original)], []));
  f.setCredential({ ...context, token: "has space" });
  assert.equal((await f.worker.runOnce()).phase, "paused-auth"); assert.equal(f.calls.length, 0);
  const g = fixture([original], () => new Response(JSON.stringify({ schema_version: 1, receipts: [receipt(original)], missing: [], errors: [] }), { headers: { "Content-Type": "text/html" } }));
  assert.equal((await g.worker.runOnce()).reason, "invalid-record-response"); assert.equal(g.queue.acknowledgements, 0);
});

test("bounded queue API avoids cloning the whole queue and retains the fair rotation cursor", async () => {
  const events = [event(1), event(2)]; const cursors: (string | undefined)[] = [];
  const f = fixture(events, request => response(request.events.map(e => receipt(events.find(original => original.event_id === e.event_id)!)), []));
  const queue = f.queue as FakeQueue & { batch(afterId?: string): Promise<RecordEvent[]>; pendingCount(): Promise<number> };
  queue.pending = async () => { throw new Error("Worker must not clone the complete queue"); };
  queue.pendingCount = async () => queue.events.length;
  queue.batch = async afterId => { cursors.push(afterId); return [events[afterId === events[0]!.event_id ? 1 : 0]!]; };
  await f.worker.runOnce(); f.advance(); await f.worker.runOnce();
  assert.deepEqual(cursors, [undefined, events[0]!.event_id]);
  assert.equal(f.calls.length, 2); assert.equal(f.worker.status.pendingEvents, 2);
});

test("bounded queue batches are checked again before any HTTP request", async () => {
  for (const batch of [Array.from({ length: 101 }, (_, index) => event(index + 1)), [event(1, "submission", "x")]]) {
    const f = fixture([event(1)], () => response([], []));
    const queue = f.queue as FakeQueue & { batch(): Promise<RecordEvent[]>; pendingCount(): Promise<number> };
    queue.pending = async () => { throw new Error("No full pending read"); }; queue.pendingCount = async () => 1;
    if (batch.length === 1) batch[0]!.payload_utf8 = "x".repeat(1024 * 1024 + 1);
    queue.batch = async () => batch;
    assert.equal((await f.worker.runOnce()).phase, "paused-conflict"); assert.equal(f.calls.length, 0);
  }
});


test("server v1 per-event error catalogue preserves partial successes and classifies every code", async () => {
  const cases: [string, string][] = [
    ["archive_forbidden", "paused-auth"],
    ...["event_conflict", "sequence_conflict", "central_conflict", "hash_mismatch", "metadata_mismatch", "invalid_event", "invalid_data", "invalid_utf8", "duplicate_json_key", "invalid_json"].map(code => [code, "paused-conflict"] as [string, string]),
    ...["storage_unavailable", "queue_full", "queue_busy"].map(code => [code, "waiting"] as [string, string]),
    ["future_unknown_error", "paused-conflict"],
  ];
  for (const [code, expected] of cases) {
    const events = [event(1), event(2)];
    const f = fixture(events, () => response([receipt(events[0]!, "queued")], [], [{ event_id: events[1]!.event_id, code }]));
    assert.equal((await f.worker.runOnce()).phase, expected, code);
    assert.equal(f.queue.acknowledgements, 1, code);
    assert.deepEqual(f.queue.events, events, code);
    assert.equal(await f.queue.receipt(events[1]!.event_id), undefined, code);
    await f.worker.runOnce(); assert.equal(f.calls.length, 1, code);
    f.advance(); await f.worker.runOnce();
    assert.equal(f.calls.length, expected === "waiting" ? 2 : 1, code);
  }
});

test("HTTP contract rejections including unsupported media type pause until resolution", async () => {
  for (const status of [400, 404, 405, 413, 415, 422]) {
    const original = event(1); const f = fixture([original], () => new Response(null, { status }));
    assert.equal((await f.worker.runOnce()).phase, "paused-conflict", String(status));
    assert.equal(f.worker.status.reason, "record-contract-rejected");
    f.advance(); await f.worker.runOnce(); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.queue.events, [original]);
  }
});

test("received rollback to queued is tolerated as a retained high-water receipt, never cleanup", async () => {
  const original = event(1); let state: Extract<RecordReceipt, { schema_version: 1 }>["state"] = "received";
  const f = fixture([original], () => response([receipt(original, state)], []));
  await f.worker.runOnce(); state = "queued"; f.advance();
  assert.equal((await f.worker.runOnce()).phase, "waiting");
  assert.equal(f.worker.status.reason, undefined);
  assert.equal((await f.queue.receipt(original.event_id))!.state, "received");
  assert.equal(f.queue.acknowledgements, 1);
  assert.deepEqual(f.queue.events, [original]);
});

test("ambiguous or malformed receipt JSON never acknowledges or deletes retained events", async () => {
  const original = event(1);
  const valid = JSON.stringify({ schema_version: 1, receipts: [receipt(original, "replicated")], errors: [], missing: [] });
  for (const body of [valid.replace('"receipts":', '"receipts":[],"receipts":'),
    valid.replace('"replica-1"', '"\\ud800"'), Buffer.from([0xff])]) {
    const f = fixture([original], () => new Response(body, { headers: { "content-type": "application/json" } }));
    assert.equal((await f.worker.runOnce()).phase, "waiting");
    assert.equal(f.queue.acknowledgements, 0); assert.deepEqual(f.queue.events, [original]);
    assert.equal(f.calls.length, 1); await f.worker.close();
  }
});
