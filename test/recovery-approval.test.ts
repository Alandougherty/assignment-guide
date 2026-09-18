import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { archiveApprovalPath, approvalMatches, readArchiveApproval, writeArchiveApproval, validateArchiveApproval, type ArchiveApproval } from "../src/recovery/approval";
const context = { origin: "https://synthetic.invalid", subject: "alice", courseId: "course" };
const policy = { store_id: "trial", policy_id: "managed-v1" };
const approval: ArchiveApproval = { schema_version: 1, origin: context.origin, subject: context.subject, course_id: context.courseId,
  ...policy, notice_version: "notice-1", approved_at: "2026-09-16T00:00:00.000Z" };
test("archive approval persists separately, binds origin/owner/course/policy/notice and keeps no token", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-approval-")); const directory = join(root, "approvals");
  try {
    assert.equal(await readArchiveApproval(directory, context), undefined);
    await writeArchiveApproval(directory, approval);
    const saved = await readArchiveApproval(directory, context);
    assert.deepEqual(saved, approval); assert.equal(approvalMatches(saved, context, policy, "notice-1"), true);
    assert.equal(approvalMatches(saved, context, { ...policy, policy_id: "new" }, "notice-1"), false);
    assert.equal(approvalMatches(saved, context, { ...policy, store_id: "new" }, "notice-1"), false);
    assert.equal(approvalMatches(saved, context, policy, "notice-2"), false);
    for (const changed of [{ ...context, origin: "https://other.invalid" }, { ...context, subject: "bob" }, { ...context, courseId: "other" }]) {
      assert.equal(approvalMatches(saved, changed, policy, "notice-1"), false);
      assert.equal(await readArchiveApproval(directory, changed), undefined);
    }
    assert.equal((await stat(archiveApprovalPath(directory, context))).mode & 0o777, 0o600);
    await writeArchiveApproval(directory, { ...approval, policy_id: "new" });
    assert.equal((await readArchiveApproval(directory, context))?.policy_id, "new");
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("archive approvals fail closed on corrupt, foreign, extra-key or malformed Unicode files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-approval-invalid-"));
  try {
    for (const bad of [{ ...approval, token: "synthetic" }, { ...approval, approved_at: "2026-09-16" }, { ...approval, policy_id: "" }, { ...approval, notice_version: "\n" }]) assert.throws(() => validateArchiveApproval(bad));
    for (const body of ["{", JSON.stringify({ ...approval, subject: "bob" }), JSON.stringify(approval).replace('"schema_version":1', '"schema_version":1,"schema_version":1'), Buffer.from([0xff]), "x".repeat(8193)]) {
      await writeFile(archiveApprovalPath(directory, context), body);
      await assert.rejects(readArchiveApproval(directory, context));
    }
    const blocked = join(directory, "not-a-directory"); await writeFile(blocked, "blocked");
    await assert.rejects(writeArchiveApproval(blocked, approval));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("archive approval retries flush all ancestors after an interrupted directory sync", async t => {
  const root = await mkdtemp(join(tmpdir(), "archive-approval-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "first", "second", "approvals");
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.open;
  const synced: string[] = [];
  let fail = true;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof original>) => {
    const file = await original(...args);
    if (args[1] === "r") {
      const originalSync = file.sync.bind(file);
      file.sync = async () => {
        synced.push(String(args[0]));
        if (args[0] === root && fail) throw new Error("injected ancestor sync failure");
        await originalSync();
      };
    }
    return file;
  });
  try {
    await assert.rejects(writeArchiveApproval(directory, approval), /ancestor sync failure/);
    assert.deepEqual(synced, [directory, dirname(directory), join(root, "first"), root]);
    synced.length = 0; fail = false;
    // Every directory now exists, but the failed parent sync is still required.
    await writeArchiveApproval(directory, approval);
    const fullChain: string[] = [];
    for (let current = resolve(directory); ; current = dirname(current)) {
      fullChain.push(current);
      if (current === dirname(current)) break;
    }
    assert.deepEqual(synced, fullChain);
    assert.deepEqual(await readArchiveApproval(directory, context), approval);
    assert.deepEqual(await readdir(directory), [archiveApprovalPath(directory, context).slice(directory.length + 1)]);
  } finally { mocked.mock.restore(); }
});
