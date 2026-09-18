import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryCredential } from "../src/recovery/identity";
import { RecoveryAuthenticationError } from "../src/recovery/worker";
const context = { origin: "https://synthetic.invalid", subject: "alice", courseId: "course" };
const assignment = { id: "closed-assignment", version: "1.0.0" };
const session = () => ({ schema: 1, accepted: true, subject: "alice", noticeVersion: "synthetic-1", course: { id: "course", activeAssignment: null }, enrolments: [],
  recovery: { schema_version: 1, course_id: "course", query_missing: true, assignments: [assignment] } });
const options = { context, assignment, noticeVersion: "synthetic-1", token: "synthetic-key" };
test("archival identity verifies original course and grant without current inference enrolment", async () => {
  let calls = 0;
  const credential = await recoveryCredential({ ...options, fetch: (async (url, init) => {
    calls++; assert.equal(url, context.origin + "/v1/session"); assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string,string>).Authorization, "Bearer synthetic-key");
    return Response.json(session());
  }) as typeof fetch });
  assert.deepEqual(credential, { ...context, token: options.token }); assert.equal(calls, 1);
});
test("archival lookup refuses changed identity, notice, course, absent or malformed recovery grants", async () => {
  const edits: ((s: any) => void)[] = [s => s.accepted = false, s => delete s.accepted, s => s.subject = "bob", s => s.course.id = "another", s => s.noticeVersion = "changed",
    s => delete s.recovery, s => s.recovery.query_missing = false, s => s.recovery.course_id = "another",
    s => s.recovery.assignments = [], s => s.recovery.assignments.push(assignment), s => s.recovery.extra = true,
    s => s.recovery.assignments[0] = { ...assignment, extra: true }];
  for (const edit of edits) { const body = session(); edit(body);
    await assert.rejects(recoveryCredential({ ...options, fetch: (async () => Response.json(body)) as typeof fetch }), RecoveryAuthenticationError);
  }
});
test("revocation pauses authentication, temporary server outage remains retryable", async () => {
  for (const status of [401,403]) await assert.rejects(recoveryCredential({ ...options, fetch: (async () => new Response(null,{status})) as typeof fetch }), RecoveryAuthenticationError);
  await assert.rejects(recoveryCredential({ ...options, fetch: (async () => new Response(null,{status:503})) as typeof fetch }), e => e instanceof Error && !(e instanceof RecoveryAuthenticationError));
});
test("archival lookup bounds responses, honours cancellation signal and requires explicit loopback allowance", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json(session()); }) as typeof fetch;
  await assert.rejects(recoveryCredential({ ...options, context: { ...context, origin: "http://127.0.0.1:4317" }, fetch: fetcher }), RecoveryAuthenticationError); assert.equal(calls, 0);
  await assert.rejects(recoveryCredential({ ...options, fetch: (async () => new Response("x".repeat(1_048_577),{headers:{"content-type":"application/json"}})) as typeof fetch }), RecoveryAuthenticationError);
  const signal = AbortSignal.abort();
  await assert.rejects(recoveryCredential({ ...options, signal, fetch: (async (_url, init) => { assert.equal(init?.signal,signal); throw new Error("Aborted synthetic lookup"); }) as typeof fetch }), /Aborted/);
});

test("preflight checks permission before acceptance, but active recovery requires accepted consent", async () => {
  const body = { ...session(), accepted: false };
  const fetcher = (async () => Response.json(body)) as typeof fetch;
  assert.deepEqual(await recoveryCredential({ ...options, requireAccepted: false, fetch: fetcher }), { ...context, token: options.token });
  await assert.rejects(recoveryCredential({ ...options, fetch: fetcher }), RecoveryAuthenticationError);
});

test("ambiguous or malformed identity JSON cannot grant recovery permission", async () => {
  const valid = JSON.stringify(session());
  for (const body of [valid.replace('"query_missing":true', '"query_missing":false,"query_missing":true'),
    valid.replace('"subject":"alice"', '"subject":"\\ud800"'), Buffer.from([0xff])]) {
    await assert.rejects(recoveryCredential({ ...options, fetch: (async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch }), RecoveryAuthenticationError);
  }
});

const archivePolicy = { store_id: "archive-trial", policy_id: "managed-archive-v1" };
const archiveSession = () => ({ ...session(), recovery: { ...session().recovery, schema_version: 2, archive_policy: archivePolicy } });
test("archive identity explicitly negotiates v2 and binds approved policy without fallback", async () => {
  const fetcher = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("X-Record-Protocol"), "2");
    return Response.json(archiveSession());
  }) as typeof fetch;
  assert.deepEqual(await recoveryCredential({ ...options, protocolVersion: 2, archivePolicy, fetch: fetcher }),
    { ...context, token: options.token, protocolVersion: 2, archivePolicy });
  await assert.rejects(recoveryCredential({ ...options, protocolVersion: 2, fetch: fetcher }), RecoveryAuthenticationError);
  assert.equal((await recoveryCredential({ ...options, protocolVersion: 2, requireAccepted: false, fetch: fetcher })).archivePolicy?.store_id, archivePolicy.store_id);
  const invalid = [session(), { ...archiveSession(), recovery: { ...archiveSession().recovery, archive_policy: { ...archivePolicy, policy_id: "other" } } },
    { ...archiveSession(), recovery: { ...archiveSession().recovery, archive_policy: { ...archivePolicy, extra: true } } }];
  for (const body of invalid) await assert.rejects(recoveryCredential({ ...options, protocolVersion: 2, archivePolicy,
    fetch: (async () => Response.json(body)) as typeof fetch }), RecoveryAuthenticationError);
  await assert.rejects(recoveryCredential({ ...options, fetch: (async () => Response.json(archiveSession())) as typeof fetch }), RecoveryAuthenticationError);
});
