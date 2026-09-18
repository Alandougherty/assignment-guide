/* No prompt drafts in setState/localStorage. Only submitted events are durable. */
const api = acquireVsCodeApi();
const get = id => document.getElementById(id);
// Model output is untrusted. No raw HTML, embedded images or executable links.
const markdown = markdownit({ html: false, linkify: false, typographer: false }).disable("image");
markdown.validateLink = url => /^https?:\/\//i.test(url);
function reply(prose) {
  const element = document.createElement("div");
  element.className = "tutor-reply";
  element.innerHTML = markdown.render(prose);
  return element;
}
let busy = false;
let conversationLoading = true;
let confirmed = false;
let exporting = false;
let remote = false;
let sessionRequired = false;
let scrollFrame;
let awaitingLocalSave = false;
let recoveryStatus = null;
let fallbackSavingStatus = "";
const reviewedEdits = new Set();
const editErrors = new Map();
function saving(label) { get("saving-status").textContent = label; }
function savedStatus(label) {
  if (label !== undefined) fallbackSavingStatus = label;
  // A queue update describes previously durable work, not an in-flight capture.
  if (!awaitingLocalSave) saving(confirmed ? recoveryStatus ?? fallbackSavingStatus : "");
}
function resetSavingStatus() {
  recoveryStatus = null; fallbackSavingStatus = ""; awaitingLocalSave = false;
  saving("");
}
function scrollToConversation() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    if (!get("chat").hidden) get("composer").scrollIntoView({ block: "end", behavior: "auto" });
  });
}
function send(message) {
  if ((busy || conversationLoading) && !["cancel", "cancel-connection"].includes(message.type)) return;
  if (["agree", "confirm", "recover"].includes(message.type)) loadingConversation(true);
  if (message.type === "submit") {
    awaitingLocalSave = true;
    saving("Saving…");
    // Immediate display only; the host replaces this with durable history after recording.
    const pending = document.createElement("article");
    pending.dataset.pending = "true";
    pending.append(studentBubble(message.text));
    get("history").append(pending);
  }
  if (message.type === "submit" || message.type === "retry") { progress("Sending your question…"); }
  if (["review-edit", "accept-edit", "reject-edit"].includes(message.type)) progress(message.type === "review-edit" ? "Opening proposed change…" : "Recording your decision…");
  if (message.type === "cancel") progress("Cancelling request…");
  if (!["cancel", "cancel-connection"].includes(message.type)) lock(true);
  get("error").textContent = "";
  if (["review-edit", "accept-edit", "reject-edit"].includes(message.type)) {
    const key = message.submissionId + "/" + message.attemptId;
    editErrors.delete(key);
    document.querySelectorAll(".edit-error").forEach(node => { if (node.dataset.editKey === key) node.textContent = ""; });
  }
  api.postMessage(message);
}
function progress(label) {
  get("thinking-label").textContent = label;
  get("thinking").hidden = !label;
  scrollToConversation();
}
function loadingConversation(value) {
  conversationLoading = value;
  get("conversation-loading").hidden = !value;
  get("history").setAttribute("aria-busy", String(value));
  lock(busy);
}
function lock(value) {
  busy = value;
  value = value || conversationLoading;
  get("composer").setAttribute("aria-busy", String(value));
  if (!value) progress("");
  document.querySelectorAll("button").forEach(button => { button.disabled = value; });
  get("export-chat").disabled = exporting || conversationLoading;
  // Enable cancellation only once the host has a durable attempt and an active
  // cancellation controller, rather than during snapshot/recording/ingestion.
  document.querySelectorAll(".retry-submission").forEach(button => { button.hidden = value; });
  get("cancel").disabled = true;
  get("prompt").disabled = value;
  get("mode").disabled = value;
  get("offline").disabled = value;
  if (sessionRequired) {
    ["prompt", "send", "sync", "recover"].forEach(id => { get(id).disabled = true; });
    document.querySelectorAll(".retry-submission, .accept-edit").forEach(button => { button.disabled = true; });
  }
}
get("export-chat").onclick = () => { if (exporting) return; exporting = true; get("export-chat").disabled = true; get("export-status").textContent = "Preparing export…"; api.postMessage({ type: "export-chat" }); };
get("leave-closed-preview").onclick = () => api.postMessage({ type: "leave-closed-preview" });
get("reconnect").onclick = () => api.postMessage({ type: "restart" });
get("open-file").onclick = () => api.postMessage({ type: "open-file" });
get("reconsider").onclick = () => api.postMessage({ type: "restart" });
get("restart").onclick = () => api.postMessage({ type: "restart" });
get("agree").onclick = () => send({ type: "agree" });
get("decline").onclick = () => send({ type: "decline" });
get("confirm").onclick = () => send({ type: "confirm" });
get("wrong-identity").onclick = () => send({ type: "wrong-identity" });
get("cancel-connection").onclick = () => send({ type: "cancel-connection" });
get("cancel").onclick = () => send({ type: "cancel" });
get("sync").onclick = () => send({ type: "sync", offline: get("offline").checked });
get("offline").onchange = () => send({ type: "sync", offline: get("offline").checked });
get("recover").onclick = () => send({ type: "recover" });
get("composer").onsubmit = event => {
  event.preventDefault();
  const text = get("prompt").value;
  if (!text.trim() || busy || conversationLoading || !confirmed) return;
  send({ type: "submit", text, mode: get("mode").value });
};
get("prompt").addEventListener("keydown", event => {
  // Enter used to confirm an IME composition must not send unfinished text.
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) get("composer").requestSubmit();
});
function text(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
function bubble(kind, author) {
  const element = document.createElement("div");
  element.className = `chat-bubble ${kind}-bubble`;
  element.append(text("h3", author));
  return element;
}
function studentBubble(prompt) {
  const element = bubble("student", "You");
  const question = text("p", prompt); question.className = "student-question";
  element.append(question);
  return element;
}
function render(turns) {
  if (!awaitingLocalSave) {
    const latest = turns.at(-1);
    savedStatus(!latest ? "" : remote ? latest.recordedByService ? "Saved to the course service" : "Saved on this device · waiting to upload" : "Saved on this device");
  }
  get("history").replaceChildren();
  for (const turn of turns) {
    const section = document.createElement("article");
    section.dataset.submissionId = turn.submission.id;
    section.append(studentBubble(turn.submission.prompt));
    const tutorBubble = bubble("tutor", remote ? "Tutor" : "Simulated tutor");
    const successful = [...turn.attempts].reverse().find(attempt => attempt.outcome?.status === "completed" && attempt.outcome.reply);
    if (successful) {
      tutorBubble.append(reply(successful.outcome.reply.prose));
      if (remote && successful.outcome.reply.edit) {
        const attemptId = successful.start.attemptId;
        const key = turn.submission.id + "/" + attemptId;
        const status = successful.editStatus;
        if (!status) {
          tutorBubble.append(text("p", `Proposed change to ${successful.outcome.reply.edit.path}. Review the diff before accepting.`));
          for (const [type, label] of [["review-edit", "Review change"], ["accept-edit", "Accept change"], ["reject-edit", "Reject change"]]) {
            const button = text("button", label);
            button.dataset.editKey = key;
            if (type === "accept-edit") { button.className = "accept-edit"; button.hidden = !reviewedEdits.has(key); }
            button.disabled = busy;
            button.onclick = () => send({ type, submissionId: turn.submission.id, attemptId });
            tutorBubble.append(button);
          }
        } else {
          const labels = { applied: "Applied in the editor. Save the file when ready; normal Undo is available.", rejected: "Change rejected.",
            conflict: "The file changed. No proposed edit was applied. Ask for a fresh proposal.", failed: "The editor did not apply the change. Ask for a fresh proposal.",
            unknown: "The edit outcome is uncertain. Check the file before requesting another change.", accepted: "Acceptance recorded. Check the file before requesting another change." };
          tutorBubble.append(text("p", labels[status] ?? "Edit decision recorded."));
        }
        const editError = text("p", editErrors.get(key) ?? "");
        editError.className = "edit-error"; editError.dataset.editKey = key; editError.setAttribute("role", "alert");
        tutorBubble.append(editError);
        if (successful.editPending) tutorBubble.append(text("p", "Edit record saved locally; waiting to confirm with the course service."));
      }
    } else {
      const outcome = turn.attempts.at(-1)?.outcome;
      if (outcome?.error) {
        const message = outcome.error === "provider-unavailable"
          ? "The tutor service was temporarily unavailable. Retry the original submission when ready."
          : outcome.error;
        tutorBubble.append(text("p", message));
      }
    }
    if (turn.attempts.every(a => a.outcome && !["completed", "queued", "running"].includes(a.outcome.status))) {
      const retry = text("button", "Retry original submission");
      retry.className = "retry-submission";
      retry.hidden = busy;
      retry.disabled = busy;
      // The host obtains acknowledgement before any remote retry.
      retry.onclick = () => send({ type: "retry", submissionId: turn.submission.id, mode: get("mode").value });
      tutorBubble.append(retry);
    }
    if (tutorBubble.children.length > 1) section.append(tutorBubble);
    get("history").append(section);
  }
  scrollToConversation();
}
window.addEventListener("message", event => {
  const message = event.data;
  if (message.type === "edit-reviewed") {
    const key = message.submissionId + "/" + message.attemptId;
    reviewedEdits.add(key);
    document.querySelectorAll(".accept-edit").forEach(button => { if (button.dataset.editKey === key) button.hidden = false; });
  }
  if (message.type === "closed-preview") {
    get("closed-assignment").hidden = !message.value;
    get("chat").hidden = !!message.value;
    get("reconnect").hidden = true;
    if (message.value) { get("closed-title").textContent = message.title; get("export-status").textContent = ""; window.scrollTo(0, 0); }
    else scrollToConversation();
  }
  if (message.type === "export-result") { exporting = false; get("export-chat").disabled = false; get("export-status").textContent = message.message; }
  if (message.type === "assignment") {
    get("assignment-info").textContent = message.title;
  }
  if (message.type === "diagnostics") {
    get("diagnostics").hidden = message.visible !== true;
    get("diagnostics").open = message.visible === true;
  }
  if (message.type === "token-allowance") {
    const label = remote && confirmed && typeof message.message === "string" ? message.message : "";
    get("token-allowance").textContent = label;
    get("token-allowance").title = label && typeof message.details === "string" ? message.details : "";
    get("token-allowance").hidden = !label;
  }
  if (message.type === "initial" || message.type === "off") {
    get("captured-files").hidden = true; get("captured-paths").replaceChildren();
    get("history-warning").textContent = ""; get("history-warning").hidden = true;
    get("token-allowance").textContent = "";
    get("token-allowance").title = "";
    get("token-allowance").hidden = true;
  }
  if (message.type === "initial") {
    resetSavingStatus();
    confirmed = false;
    remote = !!message.remote;
    get("consent").hidden = false;
    loadingConversation(true);
  }
  if (message.type === "recovery-status" && remote && confirmed &&
      (message.message === null || typeof message.message === "string")) {
    recoveryStatus = message.message;
    get("reconnect").hidden = message.phase !== "paused-auth";
    savedStatus();
  }
  if (message.type === "conversation-loading") loadingConversation(message.value === true);
  if (message.type === "session-connection") {
    const state = message.state;
    if (!state || !["connecting", "waiting", "connected", "cancelled", "failed"].includes(state.phase)) return;
    const active = ["connecting", "waiting"].includes(state.phase);
    get("session-connection").hidden = state.phase === "connected";
    get("cancel-connection").hidden = !active;
    get("cancel-connection").disabled = !active;
    get("session-connection-status").textContent = state.phase === "connecting" ? "Connecting to your course…"
      : state.phase === "waiting" ? `Course service is busy. Retrying… (${state.attempt}/4)`
      : state.phase === "cancelled" ? "Connection cancelled."
      : state.phase === "failed" ? state.reason === "busy" ? "Course service is busy. Please try connecting again shortly." : "Could not connect to your course. Check the message below." : "";
  }
  if (message.type === "busy") lock(message.value);
  if (message.type === "request-started" && busy && confirmed) {
    get("cancel").disabled = false;
    savedStatus(remote ? "Saved to the course service" : "Saved on this device");
    progress(remote ? "Tutor is thinking…" : "Simulated tutor is responding…");
  }
  if (message.type === "identity") {
    get("consent").hidden = true; get("identity").hidden = false;
    get("identity-copy").textContent = message.remote
      ? `Name: ${message.displayIdentity}\nStudent ID: ${message.studentId}`
      : `The local simulated service identifies you as ${message.studentId}. This is not a real student identity.`;
    get("course-info").textContent = message.course
      ? `Course: ${message.course.title}${message.subclass ? `\nSubclass: ${message.subclass.title}` : ""}\nAssignment: ${message.assignmentTitle || message.course.activeAssignment.id} · version ${message.course.activeAssignment.version}` : "";
    get("recipient-label").textContent = message.remote
      ? message.course ? `Your coursework is sent to the ${message.course.title} course service.`
        : "Your coursework is sent to the configured course service."
      : "";
    get("service-notice").textContent = message.remote ? `Service notice ${message.noticeVersion}: ${message.notice}` : "";
  }
  if (message.type === "session-required") {
    sessionRequired = true; confirmed = false;
    get("reconnect").hidden = !remote;
    get("error").textContent += " Use Reconnect to course to confirm again.";
    if (!message.canReadHistory) { get("history").replaceChildren(); get("chat").hidden = true; get("consent").before(get("error")); }
    lock(busy);
  }
  if (message.type === "confirmed") { get("consent").hidden = true; get("reconnect").hidden = true; sessionRequired = false; confirmed = true; get("composer").append(get("error")); get("identity").hidden = true; get("chat").hidden = false; }
  if (message.type === "off") { get("off-copy").textContent = message.wrongIdentity ? "Do not continue with someone else’s details. Ask your course team to check your access. The tutor is off; no questions or code have been submitted by this confirmation step." : "The tutor is off. You can reconsider below."; confirmed = false; resetSavingStatus(); get("reconnect").hidden = true; get("consent").hidden = true; get("identity").hidden = true; get("off").hidden = false; }
  if (message.type === "recorded" && Array.isArray(message.capturedPaths)) {
    get("captured-paths").replaceChildren();
    for (const path of message.capturedPaths) {
      const item = document.createElement("li"); item.textContent = path; get("captured-paths").append(item);
    }
    get("captured-files").hidden = false;
  }
  if (message.type === "recorded") { awaitingLocalSave = false; get("prompt").value = ""; savedStatus(remote ? "Saved on this device · uploading…" : "Saved on this device"); }
  if (message.type === "history") {
    render(message.turns);
    get("history-warning").textContent = message.warning || "";
    get("history-warning").hidden = !message.warning;
  }
  if (message.type === "sync") get("sync-status").textContent = message.message;
  if (message.type === "error") {
    if (typeof message.submissionId === "string" && typeof message.attemptId === "string") {
      const key = message.submissionId + "/" + message.attemptId;
      editErrors.set(key, message.message);
      document.querySelectorAll(".edit-error").forEach(node => { if (node.dataset.editKey === key) node.textContent = message.message; });
    } else {
      get("error").textContent = message.message;
      if (awaitingLocalSave) saving("Not saved · your question is still in the box");
    }
  }
});
loadingConversation(true);
api.postMessage({ type: "ready" });
