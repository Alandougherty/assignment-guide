import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

function webview(initialise = true) {
  class Element {
    textContent = ""; value = ""; hidden = false; disabled = false; checked = false;
    className = ""; innerHTML = ""; dataset: Record<string, string> = {};
    children: Element[] = [];
    onclick?: () => void;
    onsubmit?: (event: { preventDefault(): void }) => void;
    append(...nodes: Element[]) { this.children.push(...nodes); }
    before(..._nodes: Element[]) {}
    replaceChildren(...nodes: Element[]) { this.children = nodes; }
    setAttribute(_name: string, _value: string) {}
    addEventListener(_name: string, _listener: unknown) {}
    scrollIntoView() {}
    open = false;
    querySelector(_selector: string) { return this; }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  let receive!: (event: { data: unknown }) => void;
  const posted: unknown[] = [];
  runInNewContext(readFileSync(resolve(__dirname, "../../media/chat.js"), "utf8"), {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
    document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [] },
    window: { addEventListener: (_name: string, listener: typeof receive) => { receive = listener; }, scrollTo: () => {} },
    markdownit: () => ({ disable() { return this; }, render: (text: string) => text }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  const message = (data: unknown) => receive({ data });
  const submit = () => { get("prompt").value = "Synthetic question"; get("composer").onsubmit!({ preventDefault() {} }); };
  const history = () => message({ type: "history", turns: [{ submission: { id: "synthetic", prompt: "Question" }, attempts: [], recordedByService: true }] });
  if (initialise) {
    message({ type: "initial", remote: true, endpoint: "https://synthetic.invalid" });
    message({ type: "confirmed" });
    message({ type: "conversation-loading", value: false });
  }
  return { get, message, submit, history, posted, label: () => get("saving-status").textContent };
}

test("recovery status survives history refresh and tutor request progress", () => {
  const view = webview();
  view.message({ type: "recovery-status", message: "Saved on this device · waiting to upload" });
  view.history();
  assert.equal(view.label(), "Saved on this device · waiting to upload");
  view.message({ type: "busy", value: true });
  view.message({ type: "request-started" });
  assert.equal(view.label(), "Saved on this device · waiting to upload");
  view.message({ type: "busy", value: false });
  view.message({ type: "recovery-status", message: "Course record saved" });
  view.history();
  assert.equal(view.label(), "Course record saved");
  view.message({ type: "recovery-status", message: null });
  assert.equal(view.label(), "Saved to the course service");
});

test("recovery notifications cannot cover an unsaved prompt or local recording failure", () => {
  const view = webview();
  view.submit();
  assert.equal(view.label(), "Saving…");
  view.message({ type: "recovery-status", message: "Earlier records saved" });
  view.history();
  assert.equal(view.label(), "Saving…");
  view.message({ type: "error", message: "Synthetic recording failure" });
  assert.equal(view.label(), "Not saved · your question is still in the box");
  view.message({ type: "recovery-status", message: "Course record saved" });
  view.message({ type: "busy", value: false });
  view.history();
  assert.equal(view.label(), "Not saved · your question is still in the box");
  assert.equal(view.get("prompt").value, "Synthetic question");
  view.message({ type: "recorded" });
  assert.equal(view.label(), "Course record saved");
});

test("declining and initialisation discard account-specific recovery status", () => {
  const view = webview();
  view.message({ type: "recovery-status", message: "Course record saved" });
  view.message({ type: "off" });
  view.message({ type: "recovery-status", message: "Late worker update" });
  view.history();
  assert.equal(view.label(), "");
  view.message({ type: "initial", remote: true, endpoint: "https://other.invalid" });
  view.message({ type: "recovery-status", message: "Not yet confirmed" });
  assert.equal(view.label(), "");
  view.message({ type: "confirmed" });
  view.history();
  assert.equal(view.label(), "Saved to the course service");
  view.message({ type: "recovery-status", message: { untrusted: true } });
  assert.equal(view.label(), "Saved to the course service");
});

test("simulator saving status is unaffected by remote recovery messages", () => {
  const view = webview();
  view.message({ type: "initial", remote: false });
  view.message({ type: "confirmed" });
  view.message({ type: "recovery-status", message: "Remote status" });
  view.history();
  assert.equal(view.label(), "Saved on this device");
});


test("conversation loading starts before host readiness and blocks submissions until restoration finishes", () => {
  const view = webview(false);
  assert.equal(view.get("conversation-loading").hidden, false);
  assert.equal(view.get("prompt").disabled, true);
  view.message({ type: "initial", remote: true });
  view.message({ type: "confirmed" });
  view.submit();
  assert.equal(view.posted.length, 1, "Only ready, no duplicate submission while history is delayed");
  view.history();
  assert.equal(view.get("conversation-loading").hidden, false, "History can arrive before reconciliation finishes");
  view.message({ type: "conversation-loading", value: false });
  assert.equal(view.get("conversation-loading").hidden, true);
  view.submit();
  assert.equal(view.posted.length, 2);
});

test("empty history ends loading and failure clears spinner while retaining reconnect gate", () => {
  const view = webview();
  view.message({ type: "conversation-loading", value: true });
  view.message({ type: "history", turns: [] });
  view.message({ type: "conversation-loading", value: false });
  assert.equal(view.get("conversation-loading").hidden, true);
  assert.equal(view.get("prompt").disabled, false);
  view.message({ type: "conversation-loading", value: true });
  view.message({ type: "error", message: "Service unavailable. Reconnect to try again." });
  view.message({ type: "session-required", canReadHistory: false });
  view.message({ type: "conversation-loading", value: false });
  view.message({ type: "busy", value: false });
  assert.equal(view.get("conversation-loading").hidden, true);
  assert.equal(view.get("reconnect").hidden, false);
  assert.equal(view.get("prompt").disabled, true);
  assert.match(view.get("error").textContent, /Reconnect/);
});


test("Subclass confirmation is plain text and does not replace course identity", () => {
  const view = webview(false);
  view.message({ type: "identity", remote: true, studentId: "alice", displayIdentity: "Alice", notice: "Synthetic", noticeVersion: "1",
    course: { title: "COMP1117", activeAssignment: { id: "assignment", version: "1" } }, subclass: { id: "a", title: "A <script>" } });
  assert.match(view.get("course-info").textContent, /Course: COMP1117\nSubclass: A <script>\nAssignment:/);
  assert.equal(view.get("course-info").innerHTML, "");
});


test("Allowance stays separate from saving status and clears with identity state", () => {
  const view = webview();
  view.message({ type: "token-allowance", message: "Trial allowance: 24,600 tokens remaining" });
  assert.equal(view.get("token-allowance").hidden, false);
  assert.match(view.get("token-allowance").textContent, /24,600/);
  view.message({ type: "recovery-status", phase: "complete", message: "Saved to the course service" });
  assert.equal(view.label(), "Saved to the course service");
  assert.match(view.get("token-allowance").textContent, /24,600/);
  view.message({ type: "token-allowance", message: "Last known balance: 24,600 tokens remaining" });
  assert.match(view.get("token-allowance").textContent, /Last known/);
  view.message({ type: "off" }); assert.equal(view.get("token-allowance").hidden, true);
  view.message({ type: "token-allowance", message: "Old identity balance" }); assert.equal(view.get("token-allowance").hidden, true);
  view.message({ type: "initial", remote: false }); view.message({ type: "confirmed" });
  view.message({ type: "token-allowance", message: "Remote balance" }); assert.equal(view.get("token-allowance").hidden, true);
});

test("session connection feedback exposes cancellation before confirmation and settles without submission claims", () => {
  const view=webview(false);
  view.message({type:"busy",value:true});
  view.message({type:"session-connection",state:{phase:"waiting",attempt:1,maxAttempts:4,delayMs:250}});
  assert.equal(view.get("cancel-connection").hidden,false); assert.equal(view.get("cancel-connection").disabled,false);
  assert.match(view.get("session-connection-status").textContent,/Retrying/);
  view.get("cancel-connection").onclick!(); assert.ok(view.posted.some((m:any)=>m.type==="cancel-connection"));
  view.message({type:"session-connection",state:{phase:"cancelled"}});
  assert.equal(view.get("cancel-connection").hidden,true); assert.equal(view.get("session-connection-status").textContent,"Connection cancelled.");
  view.message({type:"session-connection",state:{phase:"failed",reason:"busy"}});
  assert.match(view.get("session-connection-status").textContent,/try connecting again/);
});

test("incomplete history warning survives ordinary request status and clears after a clean history", () => {
  const view = webview();
  view.message({ type: "history", turns: [], warning: "Incomplete local history" });
  view.message({ type: "busy", value: true });
  view.message({ type: "busy", value: false });
  assert.equal(view.get("history-warning").textContent, "Incomplete local history");
  assert.equal(view.get("history-warning").hidden, false);
  view.history();
  assert.equal(view.get("history-warning").hidden, true);
});

test("captured-file list uses literal paths and clears when the identity is cleared", () => {
  const view = webview();
  view.message({ type: "recorded", capturedPaths: ["main.py", "<example>.md"] });
  assert.equal(view.get("captured-files").hidden, false);
  assert.deepEqual(view.get("captured-paths").children.map(child => child.textContent), ["main.py", "<example>.md"]);
  view.message({ type: "off" });
  assert.equal(view.get("captured-files").hidden, true);
  assert.equal(view.get("captured-paths").children.length, 0);
});
