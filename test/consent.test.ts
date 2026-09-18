import { test } from "node:test";
import assert from "node:assert/strict";
import { consentFingerprint, consentMatches } from "../src/consent";
import type { Session } from "../src/remote";
const assignment = { id: "assignment", version: "1" };
const session: Session = { schema: 1, subject: "student", displayIdentity: "Test student", notice: "Original notice", noticeVersion: "1",
  enrolments: [assignment], course: { id: "course", title: "Course", activeAssignment: assignment } };
test("remembered consent fails closed for identity, recipient, notice, assignment and archive policy changes", () => {
  const fingerprint = consentFingerprint("https://example.test", session, assignment);
  const saved = { schema: 1, fingerprint };
  assert.ok(consentMatches(saved, consentFingerprint("https://example.test", structuredClone(session), { ...assignment })));
  for (const value of [undefined, null, {}, { schema: 2, fingerprint }, { schema: 1, fingerprint: "bad" }]) assert.equal(consentMatches(value, fingerprint), false);
  for (const field of ["subject", "displayIdentity", "notice", "noticeVersion"] as const) {
    assert.equal(consentMatches(saved, consentFingerprint("https://example.test", { ...session, [field]: "changed" }, assignment)), false, field);
  }
  for (const changed of [
    { ...session, course: { ...session.course!, id: "other" } },
    { ...session, course: { ...session.course!, title: "Other course" } },
    { ...session, recovery: { schema_version: 2, archive_policy: { store_id: "store", policy_id: "policy" } } },
  ]) assert.equal(consentMatches(saved, consentFingerprint("https://example.test", changed, assignment)), false);
  assert.equal(consentMatches(saved, consentFingerprint("https://other.test", session, assignment)), false);
  assert.equal(consentMatches(saved, consentFingerprint("https://example.test", session, { ...assignment, version: "2" })), false);
});

test("approval survives reopening, clears on decline and rejects corrupt local state", async () => {
  const { mkdtemp, rm, writeFile, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readConsent, saveConsent } = await import("../src/consent");
  const directory = await mkdtemp(join(tmpdir(), "tutor-consent-"));
  const connection = "a".repeat(64);
  const fingerprint = consentFingerprint("https://example.test", session, assignment);
  try {
    assert.equal(await readConsent(directory, connection), undefined);
    await saveConsent(directory, connection, fingerprint);
    assert.ok(consentMatches(await readConsent(directory, connection), fingerprint));
    assert.equal((await stat(join(directory, connection + ".json"))).mode & 0o777, 0o600);
    assert.equal(await readConsent(directory, "b".repeat(64)), undefined);
    await writeFile(join(directory, connection + ".json"), "broken");
    assert.equal(await readConsent(directory, connection), undefined);
    await saveConsent(directory, connection, fingerprint);
    await saveConsent(directory, connection);
    assert.equal(await readConsent(directory, connection), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
