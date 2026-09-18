import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, link, stat, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatChatExport, chatExportFilename, writeChatExport } from "../src/chat-export";
import type { RemoteTurn } from "../src/remote";
import type { Turn } from "../src/domain";

const date = "2026-09-14T01:02:03.000Z";
function turn(index: number): RemoteTurn {
  return {
    recordedByService: index % 2 === 0,
    submission: { id: `submission-${index}`, ts: date, prompt: `Prompt ${index}`, snapshot: { text: "PRIVATE SNAPSHOT" } },
    attempts: [
      { start: { attemptId: `failed-${index}` }, outcome: { status: "failed", reply: null, error: "PRIVATE ERROR" }, editEvents: [], editStatus: null, editPending: false },
      { start: { attemptId: `retry-${index}` }, outcome: { status: "completed", reply: { prose: `Reply ${index}`, model: "synthetic", usage: null, providerRequestId: "PRIVATE PROVIDER", edit: { after: "PRIVATE PROPOSAL" } }, error: null },
        editEvents: [{ eventId: `decision-${index}`, observedAt: date, kind: "accepted", text: null }, { eventId: `outcome-${index}`, observedAt: date, kind: "applied", text: "PRIVATE EDIT CONTENT" }], editStatus: "applied", editPending: true }
    ]
  } as unknown as RemoteTurn;
}
function render(turns: (Turn | RemoteTurn)[]) {
  return formatChatExport({ assignment: { id: "test", version: "1.0.0", title: "Test assignment" }, studentIdentity: "Synthetic student", course: { id: "course", title: "Synthetic course" }, exportedAt: date, turns });
}

test("local export includes all 75 submissions, failed attempts, retries and edit decisions without private payload fields", () => {
  const text = render(Array.from({ length: 75 }, (_, i) => turn(i)));
  assert.equal((text.match(/^## Submission /gm) ?? []).length, 75);
  assert.equal((text.match(/^### Attempt /gm) ?? []).length, 150);
  for (const value of ["Prompt 0", "Prompt 74", "Reply 74", "State: failed", "State: accepted", "State: applied", "not confirmed by course service", "recorded by course service", "may be incomplete", "not an officially verified submission", "Synthetic student", "Synthetic course"]) assert.ok(text.includes(value), value);
  assert.ok(!text.includes("PRIVATE"));
});

test("export keeps hostile Markdown and HTML inside fences longer than all embedded backticks", () => {
  const record = turn(0);
  const hostile = "```\n# Fake heading\n``````\n<img src=https://example.invalid/tracker>\n[click](command:execute)";
  record.submission.prompt = hostile;
  record.attempts[1]!.outcome.reply!.prose = hostile;
  const text = render([record]);
  assert.equal(text.split("```````text\n" + hostile + "\n```````\n").length - 1, 2);
});

test("export retains simulator timestamps and attempts without outcomes and handles empty history", () => {
  const record = { submission: { id: "local", ts: date, prompt: "Local question" }, attempts: [{ start: { attemptId: "pending", ts: date } }] } as unknown as Turn;
  const text = render([record]);
  assert.ok(text.includes("State: pending")); assert.ok(text.includes(`Started at: ${date}`));
  assert.ok(text.includes("local simulator record"));
  assert.ok(render([]).includes("Submissions: 0"));
});

test("export preserves queued, running, cancelled and unknown attempt states without inventing replies", () => {
  const record = turn(0);
  record.attempts = ["queued", "running", "cancelled", "unknown"].map((status, index) => ({
    start: { attemptId: `attempt-${index}` }, outcome: { status: status as "queued" | "running" | "cancelled" | "unknown", reply: null, error: "PRIVATE ERROR" }, editEvents: [], editStatus: null, editPending: false
  }));
  const text = render([record]);
  for (const status of ["queued", "running", "cancelled", "unknown"]) assert.ok(text.includes(`State: ${status}`));
  assert.equal((text.match(/No tutor reply recorded/g) ?? []).length, 4);
  assert.ok(!text.includes("PRIVATE ERROR"));
});

test("export filename is reserved, deterministic and sanitises assignment IDs", () => {
  assert.equal(chatExportFilename("../Some Assignment", date), "tutor-chat--some-assignment-2026-09-14T01-02-03-000Z.md");
  assert.throws(() => chatExportFilename("test", "invalid"), /date/);
});

test("export writer creates private files, requires explicit overwrite and refuses links or unreserved names", async () => {
  const root = await mkdtemp(join(tmpdir(), "tutor-export-"));
  try {
    const target = join(root, "tutor-chat-test.md");
    await writeChatExport(target, "first");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(writeChatExport(target, "second"));
    assert.equal(await readFile(target, "utf8"), "first");
    await writeChatExport(target, "second", true);
    assert.equal(await readFile(target, "utf8"), "second");
    const symbolic = join(root, "tutor-chat-symbolic.md");
    await symlink(target, symbolic);
    await assert.rejects(writeChatExport(symbolic, "bad", true));
    const hard = join(root, "tutor-chat-hard.md"); await link(target, hard);
    await assert.rejects(writeChatExport(hard, "bad", true));
    await assert.rejects(writeChatExport(target, "bad", true));
    assert.equal(await readFile(target, "utf8"), "second");
    const directory = join(root, "tutor-chat-directory.md"); await mkdir(directory);
    await assert.rejects(writeChatExport(directory, "bad", true));
    const source = join(root, "assignment.py"); await writeFile(source, "source");
    await assert.rejects(writeChatExport(source, "bad", true), /filename/);
    assert.equal(await readFile(source, "utf8"), "source");
  } finally { await rm(root, { recursive: true, force: true }); }
});
