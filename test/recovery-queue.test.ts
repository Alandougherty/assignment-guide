import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { RecoveryQueue } from "../src/recovery/queue";
import { makeEvent, RecordEvent, RecordReceipt } from "../src/recovery/protocol";
const context = { origin: "https://course.example", subject: "synthetic-student", courseId: "test-course" };
const event = (sequence = 1, data: unknown = { prompt: "Synthetic question", files: [] }): RecordEvent => makeEvent({ event_id: randomUUID(), turn_id: randomUUID(), session_id: randomUUID(), assignment: { id: "test-assignment", version: "1.0.0" }, client_sequence: sequence, event_kind: "submission", client_timestamp: "2026-09-14T00:00:00.000Z", data });
const receipt = (e: RecordEvent, state: "queued" | "received" | "replicated"): RecordReceipt => ({ schema_version: 1, event_id: e.event_id, payload_sha256: e.payload_sha256, state, server_timestamp: "2026-09-14T00:00:01.000Z", subject: context.subject, course_id: context.courseId, ...(state === "replicated" ? { replication: { receipt_id: "synthetic-receipt", generation: "generation-1", replica_id: "replica-1" } } : {}) });
async function fixture(t: { after(fn: () => Promise<void>): void }) { const directory = await mkdtemp(join(tmpdir(), "tutor-recovery-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
test("queue restart preserves exact unsent bytes and original context without inference", async t => {
  const directory = await fixture(t); let queue = await RecoveryQueue.open({ directory, context }); const e = event();
  await queue.enqueue(e); await queue.close(); queue = await RecoveryQueue.open({ directory, context });
  assert.deepEqual(await queue.pending(), [e]); const copy = queue.context; copy.subject = "changed"; assert.equal(queue.context.subject, context.subject);
  await queue.enqueue(e); assert.equal((await queue.pending()).length, 1); await queue.close();
  await assert.rejects(RecoveryQueue.open({ directory, context: { ...context, subject: "other-student" } }), /different/);
  await assert.rejects(RecoveryQueue.open({ directory, context: { ...context, origin: "https://other.example" } }), /different/);
  await assert.rejects(RecoveryQueue.open({ directory, context: { ...context, courseId: "other-course" } }), /different/);
});
test("replication acknowledgement releases only exact event; durable tombstone rejects changed envelope", async t => {
  const directory = await fixture(t); let queue = await RecoveryQueue.open({ directory, context }); const first = event(), second = event(2);
  await queue.enqueue(first); await queue.enqueue(second);
  await queue.acknowledge(receipt(first, "received")); await queue.cleanup(); assert.equal((await queue.pending()).length, 2);
  await assert.rejects(queue.acknowledge({ ...receipt(first, "replicated"), subject: "other" }), /match/);
  await assert.rejects(queue.acknowledge({ ...receipt(first, "replicated"), payload_sha256: "0".repeat(64) }), /match/);
  await queue.acknowledge(receipt(first, "replicated")); await queue.cleanup(); assert.deepEqual(await queue.pending(), [second]);
  await queue.close(); queue = await RecoveryQueue.open({ directory, context }); await queue.enqueue(first);
  const { payload_utf8: _payload, payload_sha256: _hash, schema_version: _schema, source: _source, ...metadata } = first;
  const changed = makeEvent({ ...metadata, event_kind: "outcome", data: { error: "changed" } });
  await assert.rejects(queue.enqueue(changed), /conflicts/);
  await queue.acknowledge(receipt(first, "queued")); assert.equal((await queue.receipt(first.event_id))?.state, "replicated");
  assert.deepEqual(await queue.pending(), [second]); await queue.close();
});
test("only one queue owner may write and corrupt retained records fail closed", async t => {
  const directory = await fixture(t); const queue = await RecoveryQueue.open({ directory, context }); await queue.enqueue(event());
  await assert.rejects(RecoveryQueue.open({ directory, context }), /Another tutor session/); await queue.close();
  const file = (await readdir(directory)).find(n => n.endsWith(".e.json"))!;
  const saved = JSON.parse(await readFile(join(directory, file), "utf8")); saved.value.payload_utf8 += "corruption";
  await writeFile(join(directory, file), JSON.stringify(saved)); await assert.rejects(RecoveryQueue.open({ directory, context }), /Corrupt/);
});
test("bounded queue rejects admission without losing unreplicated records and reserves receipt capacity", async t => {
  const directory = await fixture(t); const queue = await RecoveryQueue.open({ directory, context, maxBytes: 12_000 });
  const accepted: RecordEvent[] = [];
  for (let i = 1; i < 30; i++) { const e = event(i, { text: "x".repeat(500) }); try { await queue.enqueue(e); accepted.push(e); } catch (error) { assert.match(String(error), /full/); break; } }
  assert.ok(accepted.length > 0 && accepted.length < 30); assert.deepEqual(await queue.pending(), accepted);
  assert.ok((await queue.stats()).bytes <= 12_000);
  await queue.acknowledge(receipt(accepted[0]!, "replicated")); await queue.cleanup(); assert.equal((await queue.pending()).length, accepted.length - 1); await queue.close();
});
for (const phase of ["after-file-sync", "after-publish", "after-receipt", "after-tombstone", "after-cleanup"]) {
  test(`restart is safe after interrupted ${phase}`, async t => {
    const directory = await fixture(t); let armed = false;
    let queue = await RecoveryQueue.open({ directory, context, fault: point => { if (armed && point === phase) throw new Error("simulated process interruption"); } });
    const e = event();
    if (["after-file-sync", "after-publish"].includes(phase)) { armed = true; await assert.rejects(queue.enqueue(e), /interruption/); }
    else {
      await queue.enqueue(e);
      if (phase === "after-receipt") { armed = true; await assert.rejects(queue.acknowledge(receipt(e, "replicated")), /interruption/); }
      else { await queue.acknowledge(receipt(e, "replicated")); armed = true; await assert.rejects(queue.cleanup(), /interruption/); }
    }
    await assert.rejects(queue.pending(), /unavailable/); await queue.close(); queue = await RecoveryQueue.open({ directory, context });
    if (phase === "after-file-sync") assert.deepEqual(await queue.pending(), []);
    else if (phase === "after-publish") assert.deepEqual(await queue.pending(), [e]);
    else { assert.equal((await queue.receipt(e.event_id))?.state, "replicated"); await queue.cleanup(); assert.deepEqual(await queue.pending(), []); }
    await queue.enqueue(e); if (!["after-file-sync", "after-publish"].includes(phase)) assert.deepEqual(await queue.pending(), []);
    assert.ok(!(await readdir(directory)).some(n => n.endsWith(".tmp"))); await queue.close();
  });
}

for (const receiptSchema of [1, 2] as const) test(`v${receiptSchema} SIGKILL between durable tombstone and payload unlink recovers after stale lease`, { timeout: 25_000 }, async t => {
  const directory = await fixture(t); const e = event();
  const script = `const { RecoveryQueue } = require(${JSON.stringify(join(__dirname, "../src/recovery/queue.js"))});
    (async () => {
      const queue = await RecoveryQueue.open({ directory: ${JSON.stringify(directory)}, context: ${JSON.stringify(context)},
        fault: async point => { if (point === "after-tombstone") { setInterval(() => {}, 1000); process.send("durable"); await new Promise(() => {}); } } });
      await queue.enqueue(${JSON.stringify(e)});
      await queue.acknowledge(${JSON.stringify(receiptSchema === 1 ? receipt(e, "replicated") : archiveReceipt(e))});
      await queue.cleanup();
    })().catch(() => process.exit(2));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [message] = await once(child, "message"); assert.equal(message, "durable");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  await assert.rejects(RecoveryQueue.open({ directory, context }), /Another tutor session/);
  await delay(11_100);
  const queue = await RecoveryQueue.open({ directory, context });
  assert.equal((await queue.receipt(e.event_id))?.state, receiptSchema === 1 ? "replicated" : "archived");
  await queue.cleanup(); await queue.enqueue(e); assert.deepEqual(await queue.pending(), []); await queue.close();
});

test("new ancestor chain must flush through its existing parent before queue admission", async t => {
  const parent = await fixture(t); const directory = join(parent, "first", "second", "queue");
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.open;
  const seen: string[] = [];
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof original>) => {
    if (args[1] === "r") { seen.push(String(args[0])); if (args[0] === parent) throw new Error("synthetic ancestor fsync failure"); }
    return original(...args);
  });
  try {
    await assert.rejects(RecoveryQueue.open({ directory, context }), /ancestor fsync/);
    // Retry sees already-created directories but must still establish their durability.
    await assert.rejects(RecoveryQueue.open({ directory, context }), /ancestor fsync/);
  }
  finally { mocked.mock.restore(); }
  const chain = [directory, join(parent, "first", "second"), join(parent, "first"), parent];
  assert.deepEqual(seen, [...chain, ...chain]);
  assert.deepEqual(await readdir(directory), []);
});

test("bounded round-robin batches cover more than 100 events and several MiB without changing pending", async t => {
  const directory = await fixture(t); const queue = await RecoveryQueue.open({ directory, context });
  const events: RecordEvent[] = [];
  for (let i = 1; i <= 105; i++) { const e = event(i); events.push(e); await queue.enqueue(e); }
  for (let i = 106; i <= 110; i++) { const e = event(i, { text: "x".repeat(600_000) }); events.push(e); await queue.enqueue(e); }
  assert.equal(await queue.pendingCount(), 110);
  const seen = new Set<string>(); let cursor: string | undefined;
  for (let i = 0; i < 12 && seen.size < 110; i++) {
    const batch = await queue.batch(cursor);
    assert.ok(batch.length > 0 && batch.length <= 100);
    assert.ok(Buffer.byteLength(JSON.stringify({ schema_version: 1, events: batch })) <= 1_048_576);
    if (i === 0) assert.equal(batch.length, 100);
    for (const e of batch) seen.add(e.event_id);
    cursor = batch.at(-1)!.event_id;
    batch[0]!.payload_utf8 = "mutating returned clone must not change retained bytes";
  }
  assert.equal(seen.size, 110);
  assert.deepEqual(await queue.pending(), events);
  assert.equal((await queue.batch(events.at(-1)!.event_id))[0]!.event_id, events[0]!.event_id);
  await queue.acknowledge(receipt(events[99]!, "replicated"));
  await queue.cleanup();
  assert.equal((await queue.batch(events[99]!.event_id))[0]!.event_id, events[100]!.event_id);
  await queue.acknowledge(receipt(events[0]!, "replicated"));
  assert.equal(await queue.pendingCount(), 108);
  assert.equal((await queue.batch())[0]!.event_id, events[1]!.event_id);
  await queue.close();
});

test("malformed UTF-8 in local records is refused and original bytes remain intact", async t => {
  const directory = await fixture(t); const queue = await RecoveryQueue.open({ directory, context }); await queue.close();
  const file = join(directory, "context.json");
  const bytes = Buffer.concat([await readFile(file), Buffer.from([0xff])]);
  await writeFile(file, bytes);
  await assert.rejects(RecoveryQueue.open({ directory, context }), /encoded data|encoding/i);
  assert.deepEqual(await readFile(file), bytes);
});

const archiveReceipt = (e: RecordEvent, state: "queued" | "received" | "archived" = "archived"): RecordReceipt => ({
  schema_version: 2, event_id: e.event_id, payload_sha256: e.payload_sha256, state,
  server_timestamp: "2026-09-16T00:00:00.000Z", subject: context.subject, course_id: context.courseId,
  ...(state === "archived" ? { archive: { receipt_id: "archive-receipt", store_id: "trial", policy_id: "managed-v1" } } : {})
});

test("mixed receipt schemas preserve first terminal identity and clean each event offline", async t => {
  const directory = await fixture(t); let queue = await RecoveryQueue.open({ directory, context });
  const legacy = event(), archived = event(2), pending = event(3);
  for (const e of [legacy, archived, pending]) await queue.enqueue(e);
  const firstLegacy = receipt(legacy, "replicated"), firstArchive = archiveReceipt(archived);
  await queue.acknowledge(firstLegacy); await queue.acknowledge(firstArchive);
  await queue.acknowledge(receipt(pending, "received"));
  await queue.acknowledge(archiveReceipt(pending, "queued"));
  assert.equal((await queue.receipt(pending.event_id))?.state, "received");
  await queue.acknowledge(archiveReceipt(legacy)); await queue.acknowledge(receipt(archived, "replicated"));
  await queue.acknowledge({ ...archiveReceipt(archived), server_timestamp: "2026-09-17T00:00:00.000Z" });
  await queue.acknowledge({ ...archiveReceipt(archived), schema_version: 2, state: "archived", archive: { receipt_id: "changed-receipt", store_id: "changed-store", policy_id: "changed-policy" } });
  await queue.acknowledge(archiveReceipt(archived, "queued"));
  assert.deepEqual(await queue.receipt(legacy.event_id), firstLegacy);
  assert.deepEqual(await queue.receipt(archived.event_id), firstArchive);
  assert.deepEqual(await queue.pending(), [pending]); assert.deepEqual(await queue.batch(), [pending]);
  assert.equal(await queue.pendingCount(), 1);
  assert.deepEqual(await queue.summary(), { awaitingReceipt: 0, awaitingReplication: 1, total: 1 });
  await queue.close(); queue = await RecoveryQueue.open({ directory, context });
  // No credentials, grant or approval lookup is needed to honour already saved promises.
  await queue.cleanup(); assert.equal((await queue.stats()).events, 1);
  await queue.enqueue(archived); await queue.enqueue(legacy); assert.deepEqual(await queue.pending(), [pending]);
  await queue.close(); queue = await RecoveryQueue.open({ directory, context });
  assert.deepEqual(await queue.receipt(archived.event_id), firstArchive);
  assert.deepEqual(await queue.receipt(legacy.event_id), firstLegacy);
  assert.deepEqual(await queue.pending(), [pending]); await queue.close();
});

for (const phase of ["after-file-sync", "after-publish", "after-receipt", "after-tombstone", "after-cleanup"]) {
  test(`archive receipt restart preserves bytes or terminal promise after ${phase}`, async t => {
    const directory = await fixture(t); const e = event(); let armed = false;
    let queue = await RecoveryQueue.open({ directory, context, fault: point => { if (armed && point === phase) throw new Error("injected interruption"); } });
    await queue.enqueue(e);
    if (["after-tombstone", "after-cleanup"].includes(phase)) {
      await queue.acknowledge(archiveReceipt(e)); armed = true; await assert.rejects(queue.cleanup(), /interruption/);
    } else { armed = true; await assert.rejects(queue.acknowledge(archiveReceipt(e)), /interruption/); }
    await queue.close(); queue = await RecoveryQueue.open({ directory, context });
    if (phase === "after-file-sync") { assert.deepEqual(await queue.pending(), [e]); await queue.cleanup(); assert.equal((await queue.stats()).events, 1); }
    else { assert.deepEqual(await queue.receipt(e.event_id), archiveReceipt(e)); await queue.cleanup(); assert.equal((await queue.stats()).events, 0); await queue.enqueue(e); assert.deepEqual(await queue.pending(), []); }
    await queue.close();
  });
}
