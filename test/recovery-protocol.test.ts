import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeEvent, validateEvent, validateReceipt, payloadHash } from "../src/recovery/protocol";
const input = () => ({ event_id: randomUUID(),turn_id:randomUUID(),session_id:randomUUID(),assignment:{id:"tutor-test-primes",version:"1.0.0"},client_sequence:1,event_kind:"submission" as const,client_timestamp:new Date().toISOString(),data:{prompt:"Exact Unicode 雪\n",files:["synthetic"]} });
test("recovery hash binds exact UTF-8 payload bytes and every duplicated event field", () => {
 const e=makeEvent(input()); assert.deepEqual(validateEvent(e),e);
 for(const changed of [{...e,turn_id:randomUUID()},{...e,assignment:{...e.assignment,id:"other"}},{...e,client_sequence:2},{...e,payload_utf8:e.payload_utf8+" "}]) assert.throws(()=>validateEvent(changed));
 const spaced=e.payload_utf8+" ";assert.equal(validateEvent({...e,payload_utf8:spaced,payload_sha256:payloadHash(spaced)}).payload_utf8,spaced);
 assert.throws(()=>validateEvent({...e,token:"forbidden"}));
});
test("replicated receipts require identity, matching schema and concrete recovery generation",()=>{
 const e=makeEvent(input()); const receipt={schema_version:1,event_id:e.event_id,payload_sha256:e.payload_sha256,state:"replicated",server_timestamp:new Date().toISOString(),subject:"alice",course_id:"comp1117"};
 assert.throws(()=>validateReceipt(receipt));assert.throws(()=>validateReceipt({...receipt,replication:{receipt_id:"x",generation:"",replica_id:"r"}}));
 assert.equal(validateReceipt({...receipt,replication:{receipt_id:"x",generation:"generation-1",replica_id:"replica-1"}}).state,"replicated");
});

test("archive receipts strictly separate versions, states and bounded policy identifiers", () => {
 const e = makeEvent(input());
 const base = { schema_version: 2, event_id: e.event_id, payload_sha256: e.payload_sha256, state: "archived", server_timestamp: "2026-09-16T00:00:00.000Z", subject: "alice", course_id: "comp1117" };
 const archive = { receipt_id: "receipt-1", store_id: "trial", policy_id: "managed-v1" };
 assert.deepEqual(validateReceipt({ ...base, archive }), { ...base, archive });
 for (const state of ["queued", "received"]) assert.equal(validateReceipt({ ...base, state }).state, state);
 for (const invalid of [base, { ...base, archive: null }, { ...base, archive: { ...archive, extra: true } },
   { ...base, archive, extra: true }, { ...base, archive, replication: {} }, { ...base, archive, schema_version: 1 },
   { ...base, archive, schema_version: 3 }, { ...base, archive, state: "replicated" },
   { ...base, archive, state: "received" }, { ...base, archive, state: "queued" }]) assert.throws(() => validateReceipt(invalid));
 for (const key of Object.keys(archive)) {
   for (const value of ["", "x".repeat(201), "_first", "a/b", "snow雪", "a\n", 1, null]) {
     assert.throws(() => validateReceipt({ ...base, archive: { ...archive, [key]: value } }));
   }
   for (const value of ["a", "x".repeat(200), "A0_.:-"]) assert.doesNotThrow(() => validateReceipt({ ...base, archive: { ...archive, [key]: value } }));
 }
});

test("archive policy validation clones exactly the two bounded identifiers", () => {
 const { validateArchivePolicy, isTerminalReceipt } = require("../src/recovery/protocol") as typeof import("../src/recovery/protocol");
 const policy = { store_id: "trial", policy_id: "managed-v1" };
 const validated = validateArchivePolicy(policy); policy.store_id = "changed";
 assert.equal(validated.store_id, "trial");
 for (const bad of [null, {}, { ...policy, token: "secret" }, { ...policy, policy_id: "" }, { ...policy, store_id: "x".repeat(201) }]) assert.throws(() => validateArchivePolicy(bad));
 assert.equal(isTerminalReceipt(undefined), false);
});
