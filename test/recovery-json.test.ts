import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { parseRecoveryJson, assertUnicodeScalars } from "../src/recovery/json";
import { makeEvent, validateEvent, payloadHash } from "../src/recovery/protocol";
const input = () => ({ event_id: randomUUID(), turn_id: randomUUID(), session_id: randomUUID(), assignment: { id: "synthetic", version: "1.0.0" }, client_sequence: 1, event_kind: "submission" as const, client_timestamp: "2026-09-14T00:00:00.000Z", data: { text: "雪 🧪 é e\u0301  \n" } });
test("strict recovery JSON preserves valid scalars, whitespace and independent object keys", () => {
  const raw = ' { "a": [ {"same":1}, {"same":2}], "text":"雪 🧪 é é  \\n", "escaped":"\\ud83e\\uddea" }\n';
  assert.deepEqual(parseRecoveryJson(raw), JSON.parse(raw));
  for (const value of ['null','true','123','"abc"','[false,-1.2e-4,null,{},[]]','{"__proto__":1,"constructor":2}']) assert.deepEqual(parseRecoveryJson(value), JSON.parse(value));
  assert.equal(payloadHash(raw), createHash("sha256").update(raw,"utf8").digest("hex"));
});
test("duplicate decoded keys are rejected at any nesting and escaped aliases collide", () => {
  for (const raw of ['{"a":1,"a":2}', '{"a":[{"b":1,"\\u0062":2}]}', '{"__proto__":1,"__proto__":2}']) assert.throws(() => parseRecoveryJson(raw), /Duplicate/);
});
test("malformed raw and escaped Unicode is rejected in keys and values without normalisation", () => {
  for (const raw of ['"\\ud800"','"\\udc00"','{"\\udfff":1}','["\\ud800x"]', '"\ud800"']) assert.throws(() => parseRecoveryJson(raw), /Unicode/);
  assert.throws(() => assertUnicodeScalars('\ud800'), /Unicode/);
  assert.throws(() => payloadHash('\ud800'), /Unicode/);
  assert.throws(() => makeEvent({ ...input(), data: { text: '\ud800' } }), /Unicode/);
});
test("hash-correct ambiguous or malformed event payloads still fail validation", () => {
  const original = makeEvent(input());
  for (const payload of [original.payload_utf8.replace('"data":', '"source":"client_observed","data":'), original.payload_utf8.replace('"data":', '"data":{"text":"\\ud800"},"discard":')]) {
    assert.throws(() => validateEvent({ ...original, payload_utf8: payload, payload_sha256: payloadHash(payload) }));
  }
});
test("invalid grammar and excessive nesting fail without unbounded scanning", () => {
  for (const raw of ['{"a":}', '[1,]', '"unterminated', 'NaN']) assert.throws(() => parseRecoveryJson(raw));
  assert.throws(() => parseRecoveryJson('['.repeat(130)+'0'+']'.repeat(130)), /nesting/);
});
