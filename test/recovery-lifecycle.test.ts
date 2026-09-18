import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecoveryLifecycle, type RecoveryLifecycleOptions } from "../src/recovery/lifecycle";
import { makeEvent, type RecordEvent, type RecordReceipt, type RecoveryContext } from "../src/recovery/protocol";
import { type RecoveryCredential } from "../src/recovery/worker";

const context: RecoveryContext = { origin: "https://synthetic-course.invalid", subject: "synthetic-student", courseId: "synthetic-course" };
const assignment = { id: "synthetic-assignment", version: "1.0.0" };
function event(): RecordEvent {
  return makeEvent({ event_id: randomUUID(), turn_id: randomUUID(), session_id: randomUUID(), assignment,
    client_sequence: 1, event_kind: "submission", client_timestamp: "2026-09-14T00:00:00.000Z", data: { prompt: "Synthetic lifecycle check" } });
}
function receipt(e: RecordEvent, state: Extract<RecordReceipt, { schema_version: 1 }>["state"] = "queued"): RecordReceipt {
  return { schema_version: 1, event_id: e.event_id, payload_sha256: e.payload_sha256, state, server_timestamp: "2026-09-14T00:00:01.000Z",
    subject: context.subject, course_id: context.courseId, ...(state === "replicated" ? { replication: { receipt_id: randomUUID(), generation: "fixture-generation", replica_id: "fixture-replica" } } : {}) };
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(extra: Partial<RecoveryLifecycleOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tutor-recovery-lifecycle-"));
  let requests = 0; let lookups = 0; let credential: RecoveryCredential = { ...context, token: "synthetic-secret-token" };
  const saved = new Map<string, RecordEvent>();
  const tokens: string[] = [];
  const options: RecoveryLifecycleOptions = { directory, context, assignment, random: () => 0.5,
    credentials: async () => { lookups++; return { ...credential }; },
    fetch: (async (input, init) => {
      requests++; tokens.push((init!.headers as Record<string, string>).Authorization!);
      assert.equal(init!.redirect, "error");
      const url = new URL(String(input)); assert.equal(url.origin, context.origin);
      const body = JSON.parse(String(init!.body));
      if (url.pathname === "/records/v1/receipts") return Response.json({ schema_version: 1, errors: [],
        receipts: body.events.filter((e: RecordEvent) => saved.has(e.event_id)).map((e: RecordEvent) => receipt(saved.get(e.event_id)!)),
        missing: body.events.filter((e: RecordEvent) => !saved.has(e.event_id)),
      });
      assert.equal(url.pathname, "/records/v1/events");
      for (const e of body.events) saved.set(e.event_id, e);
      return Response.json({ schema_version: 1, errors: [], receipts: body.events.map((e: RecordEvent) => receipt(e)) });
    }) as typeof fetch, ...extra };
  const lifecycle = await RecoveryLifecycle.open(options);
  return { lifecycle, options, directory, saved, tokens, requests: () => requests, lookups: () => lookups,
    credentials(value: RecoveryCredential) { credential = value; },
    async close() { await lifecycle.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("recovery lifecycle sends nothing until explicit start and distinguishes upload from replication", async () => {
  const f = await fixture();
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original); await f.lifecycle.refresh();
    assert.equal(f.lifecycle.status.phase, "upload-pending"); assert.equal(f.lifecycle.status.awaitingUpload, 1);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.requests(), 0); assert.equal(f.lookups(), 0);
    f.lifecycle.start(); await waitFor(() => f.lifecycle.status.phase === "replication-pending", "queued receipt presentation");
    assert.equal(f.requests(), 2); assert.equal(f.lifecycle.status.awaitingUpload, 0); assert.equal(f.lifecycle.status.awaitingReplication, 1);
    assert.deepEqual(await f.lifecycle.queue.pending(), [original]);
    assert.deepEqual(f.saved.get(original.event_id), original);
    const directories = (await readdir(f.directory)).filter(name => /^[a-f0-9]{64}$/.test(name)); assert.equal(directories.length, 1); assert.match(directories[0]!, /^[a-f0-9]{64}$/);
    const queueDirectory = join(f.directory, directories[0]!); assert.equal((await stat(queueDirectory)).mode & 0o777, 0o700);
    for (const name of await readdir(queueDirectory)) {
      const text = await readFile(join(queueDirectory, name), "utf8"); assert.ok(!text.includes("synthetic-secret-token"));
    }
  } finally { await f.close(); }
});

test("same identity key rotation resumes the same queue; changed identity pauses without traffic", async () => {
  const f = await fixture();
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original);
    f.credentials({ ...context, subject: "different-student", token: "different-token" }); f.lifecycle.start();
    await waitFor(() => f.lifecycle.status.phase === "paused-auth", "identity mismatch pause"); assert.equal(f.requests(), 0);
    assert.deepEqual(await f.lifecycle.queue.pending(), [original]);
    f.credentials({ ...context, token: "synthetic-rotated-token" }); f.lifecycle.resume();
    await waitFor(() => f.lifecycle.status.phase === "replication-pending", "verified token rotation");
    assert.ok(f.tokens.every(token => token === "Bearer synthetic-rotated-token")); assert.equal(f.saved.size, 1);
  } finally { await f.close(); }
});

test("close aborts an unresolved identity lookup, fences its late result, and permits queue reopening", async () => {
  let verified!: (value: RecoveryCredential) => void; let signal: AbortSignal | undefined; let requests = 0;
  const f = await fixture({ credentials: async value => { signal = value; return new Promise(resolve => { verified = resolve; }); },
    fetch: (async () => { requests++; throw new Error("No record request expected"); }) as typeof fetch });
  let reopened: RecoveryLifecycle | undefined;
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original); f.lifecycle.start();
    await waitFor(() => !!verified, "identity lookup start");
    await f.lifecycle.close(); assert.equal(signal!.aborted, true); assert.equal(f.lifecycle.status.phase, "closed");
    assert.throws(() => f.lifecycle.start(), /closed/);
    reopened = await RecoveryLifecycle.open({ ...f.options, credentials: async () => ({ ...context, token: "synthetic-new-token" }) });
    verified({ ...context, token: "late-credential" }); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests, 0); assert.deepEqual(await reopened.queue.pending(), [original]);
    assert.equal(reopened.status.phase, "upload-pending");
  } finally { await reopened?.close(); await f.close(); }
});

test("close aborts in-flight record transport before releasing its persistent queue", async () => {
  let finish!: (value: Response) => void; let signal: AbortSignal | undefined; let requests = 0;
  const f = await fixture({ fetch: (async (_input, init) => { requests++; signal = init!.signal!; return new Promise(resolve => { finish = resolve; }); }) as typeof fetch });
  let reopened: RecoveryLifecycle | undefined;
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original); f.lifecycle.start();
    await waitFor(() => !!finish, "record lookup start");
    await f.lifecycle.close(); assert.equal(signal!.aborted, true);
    reopened = await RecoveryLifecycle.open(f.options);
    finish(Response.json({ schema_version: 1, errors: [], receipts: [receipt(original, "replicated")], missing: [] }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests, 1); assert.deepEqual(await reopened.queue.pending(), [original]); assert.equal(await reopened.queue.receipt(original.event_id), undefined);
  } finally { await reopened?.close(); await f.close(); }
});

test("pause keeps local capture available but prevents upload until explicit confirmed start", async () => {
  const f = await fixture();
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original); f.lifecycle.start();
    await waitFor(() => f.lifecycle.status.phase === "replication-pending", "first receipt");
    await f.lifecycle.pause(); assert.equal(f.lifecycle.status.phase, "paused-auth"); const previous = f.requests();
    const second = event(); await f.lifecycle.queue.enqueue(second); await f.lifecycle.refresh();
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.requests(), previous); assert.equal(f.lifecycle.status.awaitingUpload, 1);
    f.lifecycle.start(); await waitFor(() => f.lifecycle.status.phase === "replication-pending" && f.saved.size === 2, "reconfirmed transport");
    assert.equal(f.lifecycle.status.pendingEvents, 2);
  } finally { await f.close(); }
});

test("failed transport preserves queued contents and surfaces background waiting reason", async () => {
  const f = await fixture({ fetch: (async () => new Response(null, { status: 503 })) as typeof fetch });
  let reopened: RecoveryLifecycle | undefined;
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original); f.lifecycle.start();
    await waitFor(() => f.lifecycle.status.reason === "record-service-unavailable", "transport failure state");
    assert.equal(f.lifecycle.status.phase, "upload-pending"); assert.equal(f.lifecycle.status.pendingEvents, 1);
    await f.lifecycle.close(); reopened = await RecoveryLifecycle.open(f.options);
    assert.deepEqual(await reopened.queue.pending(), [original]); assert.equal(reopened.status.awaitingUpload, 1);
  } finally { await reopened?.close(); await f.close(); }
});

test("queue summary excludes replicated content and counts queued and received separately from unsent", async () => {
  const f = await fixture();
  try {
    const pending = event(); const queued = event(); const received = event(); const replicated = event();
    for (const value of [pending, queued, received, replicated]) await f.lifecycle.queue.enqueue(value);
    await f.lifecycle.queue.acknowledge(receipt(queued)); await f.lifecycle.queue.acknowledge(receipt(received, "received")); await f.lifecycle.queue.acknowledge(receipt(replicated, "replicated"));
    assert.deepEqual(await f.lifecycle.queue.summary(), { awaitingReceipt: 1, awaitingReplication: 2, total: 3 });
    await f.lifecycle.queue.cleanup(); await f.lifecycle.refresh();
    assert.equal(f.lifecycle.status.awaitingUpload, 1); assert.equal(f.lifecycle.status.awaitingReplication, 2); assert.equal(f.lifecycle.status.pendingEvents, 3);
  } finally { await f.close(); }
});

test("lifecycle origin validation requires explicit loopback permission and assignment copies are detached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutor-lifecycle-origin-"));
  try {
    await assert.rejects(RecoveryLifecycle.open({ directory, context: { ...context, origin: "http://127.0.0.1:4318" }, assignment,
      credentials: async () => ({ ...context, token: "synthetic-token" }) }), /origin/);
    assert.deepEqual(await readdir(directory), []);
    const f = await fixture();
    try { const copied = f.lifecycle.assignment; copied.id = "changed"; assert.equal(f.lifecycle.assignment.id, assignment.id); }
    finally { await f.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("archive lifecycle distinguishes archive pending and permits offline saved-terminal cleanup", async () => {
  const f = await fixture({ protocolVersion: 2, credentials: async () => { throw new Error("Offline"); } });
  try {
    const original = event(); await f.lifecycle.queue.enqueue(original);
    await f.lifecycle.queue.acknowledge({ ...receipt(original), schema_version: 2, state: "queued" });
    assert.equal((await f.lifecycle.refresh()).phase, "archive-pending");
    await f.lifecycle.queue.acknowledge({ ...receipt(original), schema_version: 2, state: "archived", archive: { receipt_id: "receipt", store_id: "trial", policy_id: "managed-v1" } });
    await f.lifecycle.queue.cleanup();
    assert.equal((await f.lifecycle.refresh()).pendingEvents, 0);
    assert.equal((await f.lifecycle.queue.stats()).events, 0);
  } finally { await f.close(); }
});
