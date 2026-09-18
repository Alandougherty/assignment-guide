import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeEvent, type RecordEvent } from "../src/recovery/protocol";
import { RecoveryQueue } from "../src/recovery/queue";
import { RecoveryWorker } from "../src/recovery/worker";
const context = { origin: "https://synthetic.invalid", subject: "alice", courseId: "course" };
const policy = { store_id: "archive-trial", policy_id: "managed-archive-v1" };
const event = () => makeEvent({ event_id: randomUUID(), turn_id: randomUUID(), session_id: randomUUID(),
  assignment: { id: "test", version: "1.0.0" }, client_sequence: 1, event_kind: "submission", client_timestamp: "2026-09-16T00:00:00.000Z", data: { text: "synthetic" } });
const receipt = (e: RecordEvent) => ({ schema_version: 2, event_id: e.event_id, payload_sha256: e.payload_sha256, state: "archived",
  subject: context.subject, course_id: context.courseId, server_timestamp: "2026-09-16T00:00:01.000Z", archive: { ...policy, receipt_id: "ar1:test" } });
const response = (receipts: unknown[], missing: unknown[] = []) => Response.json({ schema_version: 2, receipts, missing, errors: [] });
async function fixture(run: (queue: RecoveryQueue, original: RecordEvent) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "archive-worker-"));
  const queue = await RecoveryQueue.open({ directory, context });
  try { const original = event(); await queue.enqueue(original); await run(queue, original); }
  finally { await queue.close(); await rm(directory, { recursive: true, force: true }); }
}
const credential = async () => ({ ...context, token: "synthetic", protocolVersion: 2 as const, archivePolicy: policy });
test("v2 worker retains schema1 event bytes and cleans only after an approved archive receipt", async () => fixture(async (queue, original) => {
  let now = 0, stored = false, reads = 0;
  const worker = new RecoveryWorker(queue, { protocolVersion: 2, now: () => now, credentials: credential, fetch: (async (url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.schema_version, 2);
    assert.equal(init?.redirect, "error");
    if (String(url).endsWith("/records/v2/events")) {
      assert.deepEqual(body.events, [original]); assert.equal(body.events[0].schema_version, 1); stored = true;
      return Response.json({ schema_version: 2, receipts: [{ ...receipt(original), state: "queued", archive: undefined }], errors: [] });
    }
    assert.ok(String(url).endsWith("/records/v2/receipts")); reads++;
    return stored ? response([receipt(original)]) : response([], [{ event_id: original.event_id, payload_sha256: original.payload_sha256 }]);
  }) as typeof fetch });
  try {
    await worker.runOnce(); assert.equal((await queue.pending()).length, 1); assert.equal((await queue.receipt(original.event_id))?.state, "queued");
    now = 300_000; await worker.runOnce(); assert.equal((await queue.pending()).length, 0);
    assert.equal((await queue.receipt(original.event_id))?.state, "archived"); assert.equal(reads, 2);
  } finally { await worker.close(); }
}));
test("wrong policy, mixed schema, malformed terminal and invalid batch never release original bytes", async () => {
  for (const mutate of [
    (r: any) => r.archive.policy_id = "unapproved", (r: any) => r.archive.store_id = "elsewhere",
    (r: any) => r.schema_version = 1, (r: any) => r.replication = {}, (r: any) => r.archive = null,
    (r: any) => r.subject = "bob",
  ]) await fixture(async (queue, original) => {
    const r = receipt(original); mutate(r);
    const worker = new RecoveryWorker(queue, { protocolVersion: 2, credentials: credential, fetch: (async () => response([r])) as typeof fetch });
    try { await worker.runOnce(); assert.equal(await queue.receipt(original.event_id), undefined); assert.deepEqual(await queue.pending(), [original]); }
    finally { await worker.close(); }
  });
});
test("v2 worker rejects an unnegotiated credential before any record request", async () => fixture(async (queue, original) => {
  let calls = 0;
  const worker = new RecoveryWorker(queue, { protocolVersion: 2, credentials: async () => ({ ...context, token: "synthetic" }),
    fetch: (async () => { calls++; throw new Error("must not send"); }) as typeof fetch });
  try { assert.equal((await worker.runOnce()).phase, "paused-auth"); assert.equal(calls, 0); assert.deepEqual(await queue.pending(), [original]); }
  finally { await worker.close(); }
}));
test("reconfirmation stop invalidates late archived response without acknowledging it", async () => fixture(async (queue, original) => {
  let resolve!: (r: Response) => void, reached!: () => void;
  const dispatched = new Promise<void>(r => reached = r);
  const worker = new RecoveryWorker(queue, { protocolVersion: 2, credentials: credential, fetch: (async () => {
    reached(); return new Promise<Response>(r => resolve = r);
  }) as typeof fetch });
  const running = worker.runOnce(); await dispatched; await worker.close();
  resolve(response([receipt(original)])); await running;
  assert.equal(await queue.receipt(original.event_id), undefined); assert.deepEqual(await queue.pending(), [original]);
}));
test("v2 batch validation is atomic and rejects archived receipt mixed with unknown event", async () => fixture(async (queue, original) => {
  const worker = new RecoveryWorker(queue, { protocolVersion: 2, credentials: credential, fetch: (async () => response([receipt(original), receipt(event())])) as typeof fetch });
  try { await worker.runOnce(); assert.equal(await queue.receipt(original.event_id), undefined); assert.deepEqual(await queue.pending(), [original]); }
  finally { await worker.close(); }
}));
