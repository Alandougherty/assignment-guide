import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateTokenAllowance, tokenAllowanceLabel, tokenAllowanceDetails, type TokenAllowance } from "../src/token-allowance";
import { RemoteTutor, type Session } from "../src/remote";
import { consentFingerprint } from "../src/consent";
const assignment = { id: "tutor-test-primes", version: "1.0.0" };
const allowance = (): TokenAllowance => ({ schema: 1, assignment, epoch: { id: randomUUID(), startedAt: "2026-09-17T00:00:00.000Z" },
  revision: 1, limit: 100000, used: 75400, remaining: 24600, usageComplete: true, mode: "reporting", updatedAt: "2026-09-17T01:00:00.000Z" });
const session = (): Session => ({ schema: 1, subject: "alice", displayIdentity: "Alice", notice: "Synthetic trial", noticeVersion: "1",
  course: { id: "course", title: "Course", activeAssignment: assignment }, enrolments: [assignment], tokenAllowance: allowance() });
test("Allowance validation binds assignment and rejects dishonest, unsafe or malformed balances", () => {
  const good = allowance(); assert.deepEqual(validateTokenAllowance(good, assignment), good);
  const unknown = { ...good, usageComplete: false, remaining: null }; assert.deepEqual(validateTokenAllowance(unknown, assignment), unknown);
  const over = { ...good, used: 100001, remaining: 0 }; assert.equal(validateTokenAllowance(over, assignment).remaining, 0);
  for (const invalid of [null, {}, { ...good, extra: true }, { ...good, revision: 0 }, { ...good, limit: -1 },
    { ...good, used: Number.MAX_SAFE_INTEGER + 1 }, { ...good, used: 1.5 }, { ...good, remaining: 24601 },
    { ...good, remaining: null }, { ...unknown, remaining: 0 }, { ...good, mode: "enforced" },
    { ...good, epoch: { ...good.epoch, startedAt: "2026-02-30T00:00:00Z" } },
    { ...good, updatedAt: "2026-09-16T00:00:00Z" }, { ...good, assignment: { ...assignment, version: "other" } }]) {
    assert.throws(() => validateTokenAllowance(invalid, assignment));
  }
});
test("Trial label discloses epoch, unknown usage and staleness without claiming a hard cap", () => {
  const good = allowance(); assert.equal(tokenAllowanceLabel(good, false), "24,600 tokens remaining");
  assert.match(tokenAllowanceDetails(good), /since 2026-09-17.*Reporting only/);
  assert.match(tokenAllowanceLabel(good, true), /Last known:/);
  assert.match(tokenAllowanceLabel({ ...good, usageComplete: false, remaining: null }, false), /balance unavailable/);
  assert.equal(tokenAllowanceLabel(undefined, true), "");
});
test("Balance changes do not invalidate consent; assignment and identity still do", () => {
  const s = session(), before = consentFingerprint("https://course.test", s, assignment);
  assert.equal(consentFingerprint("https://course.test", { ...s, tokenAllowance: { ...s.tokenAllowance!, used: 76000, remaining: 24000, revision: 2 } }, assignment), before);
  assert.notEqual(consentFingerprint("https://course.test", { ...s, subject: "bob" }, assignment), before);
});
test("Actual client keeps stale balance on outage, replaces epochs and hides unconfigured allowance", async t => {
  let value: any = session(), failing = false, requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++; if (failing) throw new Error("Synthetic disconnected transport");
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  });
  const tutor = new RemoteTutor({ directory: "/unused", endpoint: "https://course.test", token: "synthetic", assignment });
  await tutor.agree(); assert.match(tutor.allowanceLabel(), /24,600/); assert.doesNotMatch(tutor.allowanceLabel(), /Last known/);
  failing = true; await tutor.refreshAllowance(); assert.match(tutor.allowanceLabel(), /Last known.*24,600/);
  failing = false; value.tokenAllowance = { ...allowance(), used: 0, remaining: 100000 }; await tutor.refreshAllowance();
  assert.match(tutor.allowanceLabel(), /100,000/); assert.doesNotMatch(tutor.allowanceLabel(), /Last known/);
  value.tokenAllowance.used = 5; value.tokenAllowance.remaining = 99995; await tutor.refreshAllowance();
  value.tokenAllowance.used = 0; value.tokenAllowance.remaining = 100000; await tutor.refreshAllowance();
  assert.match(tutor.allowanceLabel(), /Last known.*99,995/);
  delete value.tokenAllowance; await tutor.refreshAllowance(); assert.equal(tutor.allowanceLabel(), "");
  assert.equal(requests, 6); await tutor.close();
});
