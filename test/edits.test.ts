import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EditValidationError, parseEditResponse, validateEdit, validateEditForSubmission } from "../src/edits";
import type { Snapshot } from "../src/domain";
const snapshot = (text = "def value():\n    return 1\n"): Snapshot & { requestEdit: boolean } => ({ path: "workspace", language: "plaintext", text: "", documentVersion: 1, selection: null, requestEdit: true,
  workspace: { files: [{ path: "main.py", language: "python", text, documentVersion: 2 }, { path: "ASSIGNMENT.md", language: "markdown", text: "Brief", documentVersion: 1 }] } });
const response = (edit: unknown = { path: "main.py", oldText: "return 1", newText: "return 2" }) => JSON.stringify({ prose: "Consider this small change.", edit });

test("edit parser expands one unique replacement against the captured file and hashes exact original text", () => {
  const s = snapshot(); const result = parseEditResponse(response(), s, ["main.py"]);
  assert.ok(result.edit); assert.equal(result.edit.before, s.workspace!.files[0]!.text); assert.equal(result.edit.after, "def value():\n    return 2\n");
  assert.equal(result.edit.baseDigest, createHash("sha256").update(JSON.stringify(result.edit.before)).digest("hex"));
  validateEdit(result.edit); validateEditForSubmission(result.edit, s, ["main.py"]);
  assert.equal(s.workspace!.files[0]!.text, "def value():\n    return 1\n");
  assert.deepEqual(parseEditResponse(response(null), s, ["main.py"]), { prose: "Consider this small change." });
  assert.equal(parseEditResponse(response({ path: "main.py", oldText: "return 1", newText: "" }), s, ["main.py"]).edit!.after, "def value():\n    \n");
});

test("edit proposals cannot target traversal, hidden files, metadata or unselected files", () => {
  for (const path of ["../main.py", "/main.py", ".git/config", "TUTOR.md", "AGENTS.md", "assignment.json", "secret.py", "absent.py", "ASSIGNMENT.md"]) {
    assert.throws(() => parseEditResponse(response({ path, oldText: path === "ASSIGNMENT.md" ? "Brief" : "return 1", newText: "replacement" }), snapshot(), ["main.py"]));
  }
  assert.throws(() => parseEditResponse(response(), snapshot(), []));
  assert.throws(() => parseEditResponse(response(), { ...snapshot(), requestEdit: false }, ["main.py"]));
});

test("edit parser rejects ambiguous anchors, malformed JSON, fences and arbitrary extra fields", () => {
  for (const text of ["return 1\nreturn 1", "nothing", "aaa"]) {
    const oldText = text === "aaa" ? "aa" : "return 1";
    assert.throws(() => parseEditResponse(response({ path: "main.py", oldText, newText: "changed" }), snapshot(text), ["main.py"]));
  }
  for (const raw of ["broken", "```json\n" + response() + "\n```", "Here is a proposal: " + response(), response() + " trailing", JSON.stringify({ prose: "Explanation", edit: null, extra: true }), JSON.stringify({ prose: "", edit: null }), response({ path: "main.py", oldText: "return 1", newText: "2", extra: "instructions" }), response({ path: "main.py", oldText: "", newText: "2" })]) {
    assert.throws(() => parseEditResponse(raw, snapshot(), ["main.py"]));
  }
});

test("edit validation refuses tampered hashes, no-ops, binary text and byte overflow", () => {
  const s = snapshot(); const edit = parseEditResponse(response(), s, ["main.py"]).edit!;
  for (const value of [{ ...edit, baseDigest: "0".repeat(64) }, { ...edit, after: edit.before }, { ...edit, after: "\0" }, { ...edit, after: "\ud800" }, { ...edit, after: "é".repeat(4001) }, { ...edit, extra: true }]) assert.throws(() => validateEdit(value));
  assert.throws(() => validateEditForSubmission(edit, snapshot("changed"), ["main.py"]));
  assert.throws(() => parseEditResponse(response({ path: "main.py", oldText: "return 1", newText: "é".repeat(2001) }), s, ["main.py"]));
  assert.throws(() => parseEditResponse(response({ path: "main.py", oldText: "return 1", newText: "return 1" }), s, ["main.py"]));
  assert.throws(() => parseEditResponse(response({ path: "main.py", oldText: "x", newText: "ab" }), snapshot("x" + "y".repeat(7999)), ["main.py"]));
});


test("edit diagnostics distinguish malformed structure and exact-match failures", () => {
  const cases: [string, string, string][] = [
    ["```json\n{}\n```", "return 1", "invalid-json"],
    ['{"edit":null}', "return 1", "response-fields"],
    [response({ path: "main.py", oldText: "absent", newText: "new" }), "return 1", "old-text-not-found"],
    [response(), "return 1\nreturn 1", "old-text-not-unique"],
    [response({ path: "ASSIGNMENT.md", oldText: "Brief", newText: "new" }), "return 1", "target-not-allowed"],
    [response({ path: "main.py", oldText: "return 1", newText: "return 1" }), "return 1", "no-change"],
  ];
  for (const [raw, text, reason] of cases) assert.throws(() => parseEditResponse(raw, snapshot(text), ["main.py"]),
    error => error instanceof EditValidationError && error.reason === reason);
});
