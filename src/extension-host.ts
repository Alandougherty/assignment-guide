import { SessionConnectionCancelled } from "./session-connection";
import { STUDENT_SERVICE_ORIGIN } from "./student-connection";
import { consentFingerprint, consentMatches, readConsent, saveConsent } from "./consent";
import { RecoveryAuthenticationError } from "./recovery/worker";
import * as vscode from "vscode";
import { randomBytes, createHash } from "node:crypto";
import { join, relative, sep, isAbsolute } from "node:path";
import { open } from "node:fs/promises";
import { recognise, assignmentFile, assignmentFiles, type AssignmentDefinition } from "./assignment";
import { RecoveryLifecycle, type RecoveryLifecycleStatus } from "./recovery/lifecycle";
import { approvalMatches, readArchiveApproval, writeArchiveApproval } from "./recovery/approval";
import { validateArchivePolicy } from "./recovery/protocol";
import { recoveryCredential } from "./recovery/identity";
import { RemoteTutor, AssignmentFolderError, type Session } from "./remote";
import { createEditReview } from "./edit-review";
import { validateEditForSubmission } from "./edits";
import { Lease } from "./lease";
import { formatChatExport, chatExportFilename, writeChatExport } from "./chat-export";
import { captureWorkspace, eligibleWorkspacePath } from "./workspace";
import { type Mode, type Snapshot } from "./domain";

export type TestApi = {
  dispatch: (message: unknown) => Promise<void>;
  messages: Record<string, unknown>[];
  close: () => Promise<void>;
  configureRemote: (endpoint: string | undefined, token?: string, recoveryEnabled?: boolean, archiveEnabled?: boolean) => Promise<void>;
};

/** Shared host contract; no dependency on the development implementation. */
export interface TutorSession {
  readonly ready: boolean;
  readonly busy: boolean;
  readonly confirmedSubject: string | undefined;
  agree(): Promise<string>;
  confirm(): Promise<void>;
  decline(): void;
  cancel(): void;
  history(): Promise<import("./domain").Turn[]>;
  submit(prompt: string, snapshot: Snapshot, mode: Mode, recorded?: () => void | Promise<void>): Promise<void>;
  retry(submissionId: string, mode: Mode): Promise<void>;
  recover(): Promise<void>;
  sync(): Promise<{ delivered: number; queued: number }>;
}

export interface DevelopmentTools {
  connection(): Promise<{ endpoint: string; token: string } | undefined>;
  preview(context: vscode.ExtensionContext): void;
  definition(ref: import("./domain").AssignmentRef): AssignmentDefinition;
  simulator(storage: string, guard: () => void, assignment: import("./domain").AssignmentRef, started: () => void): {
    tutor: TutorSession; setOffline(value: boolean): void;
  };
}

export async function activateHost(context: vscode.ExtensionContext, development?: DevelopmentTools): Promise<TestApi | undefined> {
  const developmentTools = !!development && context.extensionMode !== vscode.ExtensionMode.Production;
  await vscode.commands.executeCommand("setContext", "assignmentGuide.developmentTools", developmentTools);
  if (developmentTools) context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.previewStudent", () => development!.preview(context)));
  const editReview = createEditReview(context);
  // Test-only driver exercises the real host/message handler without exposing
  // an authentication bypass or a development command in ordinary sessions.
  const testApi: TestApi | undefined = developmentTools && context.extensionMode === vscode.ExtensionMode.Test
    ? { dispatch: async () => { throw new Error("Open the tutor first."); }, messages: [], close: async () => undefined, configureRemote: async () => undefined }
    : undefined;
  let sidebar: vscode.WebviewView | undefined;
  let diagnosticsVisible = false;
  context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.toggleDiagnostics", async () => {
    diagnosticsVisible = !diagnosticsVisible;
    await vscode.commands.executeCommand("assignmentTutorV2.open");
    await sidebar?.webview.postMessage({ type: "diagnostics", visible: diagnosticsVisible });
  }));
  let resolveFirstView!: () => void;
  const firstView = new Promise<void>(resolve => { resolveFirstView = resolve; });
  let startup: Promise<void> = Promise.resolve();
  let cleanup: () => Promise<void> = async () => undefined;
  let latestEditor = vscode.window.activeTextEditor;
  let opening = false;
  let previewClosed = async (): Promise<void> => { await vscode.window.showInformationMessage("Open the tutor and confirm your identity before previewing closure."); };
  let testConnection: { endpoint: string; token: string; recoveryEnabled: boolean; archiveEnabled: boolean } | undefined;
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) latestEditor = editor;
  }));
  const chooseAssignmentFolder = async (): Promise<void> => {
    const folders = await vscode.window.showOpenDialog({ title: "Open assignment repository", canSelectFiles: false,
      canSelectFolders: true, canSelectMany: false, openLabel: "Open assignment" });
    if (!folders?.length) return;
    const chosen = folders[0]!;
    try {
      if (chosen.scheme !== "file") throw new Error("Choose a local assignment folder.");
      const assignment = await recognise(chosen.fsPath);
      const target = vscode.Uri.file(assignment.root);
      const current = vscode.workspace.workspaceFolders;
      if (current?.length === 1 && current[0]!.uri.toString() === target.toString()) {
        await vscode.commands.executeCommand("assignmentTutorV2.restart");
        await vscode.commands.executeCommand("assignmentTutorV2.open");
        return;
      }
      // Folder changes reload the extension host. Resume only in the chosen folder.
      await context.globalState.update("openTutorForFolder", target.toString());
      await vscode.commands.executeCommand("vscode.openFolder", target, { forceReuseWindow: true });
    } catch {
      await context.globalState.update("openTutorForFolder", undefined);
      await vscode.window.showErrorMessage("Choose your assignment Git repository containing assignment.json, not the extension source folder.");
    }
  };
  const initialise = async (view: vscode.WebviewView): Promise<void> => {
    if (opening) return;
    opening = true;
    let lease: Lease | undefined;
    let recovery: RecoveryLifecycle | undefined;
    try {
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media"), vscode.Uri.joinPath(context.extensionUri, "node_modules", "markdown-it", "dist", "browser")] };
      view.webview.html = loadingHtml(view.webview, context.extensionUri);
      await cleanup();
      if (!vscode.workspace.isTrusted) throw new Error("Trust the assignment workspace first.");
      const folders = vscode.workspace.workspaceFolders;
      if (folders?.length !== 1 || folders[0]!.uri.scheme !== "file") throw new Error("Open one local assignment repository as a folder.");
      if (!context.storageUri || context.storageUri.scheme !== "file") throw new Error("Local workspace storage is unavailable.");
      const folder = folders[0]!;
      const assignment = await recognise(folder.uri.fsPath);
      const localConnection = developmentTools ? await development!.connection() : undefined;
      const endpoint = developmentTools
        ? testConnection?.endpoint ?? localConnection?.endpoint ?? context.globalState.get<string>("courseServiceUrl")
        : STUDENT_SERVICE_ORIGIN;
      const remote = !developmentTools || !!testConnection || !!localConnection || context.globalState.get<string>("tutorMode") === "remote";
      const token = testConnection?.token ?? localConnection?.token ?? (remote && endpoint ? await context.secrets.get(`courseServiceKey:${endpoint}`) : undefined);
      if (remote && (!endpoint || !token)) throw new Error("Course service connection is incomplete. Run Assignment Guide: Connect to Your Course.");
      // Separate credentials/accounts cannot display or upload each other's local records.
      // Credential rotation starts a fresh namespace; old records are retained.
      const ownerHash = remote ? createHash("sha256").update(JSON.stringify([endpoint, token])).digest("hex") : "";
      const storage = remote ? join(context.storageUri.fsPath, "remote-v1", ownerHash) : join(context.storageUri.fsPath, "simulator-v1");
      const archiveEnabled = !!testApi && testConnection?.archiveEnabled === true;
      const approvalDirectory = join(context.globalStorageUri.fsPath, "archive-approvals-v1");
      const archiveContext = (session: Session) => {
        if (!session.course) throw new Error("Archive approval requires a verified course.");
        return { origin: endpoint!, subject: session.subject, courseId: session.course.id };
      };
      const verifyArchiveApproval = async (session: Session) => {
        const binding = archiveContext(session);
        const policy = validateArchivePolicy(session.recovery?.archive_policy);
        const approval = await readArchiveApproval(approvalDirectory, binding);
        if (!approvalMatches(approval, binding, policy, session.noticeVersion)) throw new Error("Confirm the current archive policy before submitting or saving records.");
        await recoveryCredential({ context: binding, assignment: assignment.assignment, noticeVersion: session.noticeVersion,
          protocolVersion: 2, archivePolicy: policy, token: testConnection?.token ?? "", allowLoopback: true, signal: AbortSignal.timeout(10_000) });
      };
      let tutor: TutorSession | RemoteTutor;
      lease = await Lease.acquire(storage, () => {
        tutor?.cancel();
        void vscode.window.showErrorMessage("Tutor recording lock lost. Close and reopen the tutor.");
      });
      const started = () => { if (disposed) tutor.cancel(); else post({ type: "request-started" }); };
      const simulation = remote ? undefined : development!.simulator(storage, lease.check, assignment.assignment, started);
      tutor = remote ? new RemoteTutor({ directory: storage, endpoint: endpoint!, token: token!,
        assignment: assignment.assignment, archivePolicyMode: archiveEnabled,
        onSessionConnectionState: state => { if (!disposed) post({ type: "session-connection", state }); },
        beforeArchiveActivity: verifyArchiveApproval,
        afterArchiveConfirmation: async session => {
          const binding = archiveContext(session);
          const policy = validateArchivePolicy(session.recovery?.archive_policy);
          await recoveryCredential({ context: binding, assignment: assignment.assignment, noticeVersion: session.noticeVersion,
            protocolVersion: 2, archivePolicy: policy, token: testConnection?.token ?? "", allowLoopback: true, signal: AbortSignal.timeout(10_000) });
          await writeArchiveApproval(approvalDirectory, { schema_version: 1, origin: binding.origin, subject: binding.subject,
            course_id: binding.courseId, ...policy, notice_version: session.noticeVersion, approved_at: new Date().toISOString() });
        }, guard: lease.check, onRequestStarted: started, allowLoopback: (!!testApi && !!testConnection) || !!localConnection, ...(localConnection ? { pollTimeoutMs: 120_000 } : {}) })
        : simulation!.tutor;
      const currentDefinition = (): AssignmentDefinition => {
        if (tutor instanceof RemoteTutor) {
          if (!tutor.assignmentDefinition) throw new Error("Confirm your course identity to load the assignment files first.");
          return tutor.assignmentDefinition;
        }
        return development!.definition(assignment.assignment);
      };
      const showAssignment = () => {
        const d = currentDefinition();
        post({ type: "assignment", title: d.title, version: d.version, course: tutor instanceof RemoteTutor ? tutor.course : undefined, files: assignmentFiles(d).map(f => f.path) });
      };
      let disposed = false;
      let processing = false;
      let connectionGeneration = 0;
      const checkConnectionOperation = (generation: number) => {
        if (disposed || generation !== connectionGeneration) throw new SessionConnectionCancelled();
      };
      let folderRefused = false;
      let closedPreview = false;
      const tasks = new Set<Promise<void>>();
      const post = (msg: Record<string, unknown>) => {
        testApi?.messages.push(msg);
        if (!disposed) void view.webview.postMessage(msg);
      };
      // No user/workspace setting can enable this. Only the isolated Test API can
      // opt into a synthetic loopback session and its proposed archival grant.
      const developmentRecovery = !!testApi && testConnection?.recoveryEnabled === true;
      const showRecovery = (status: RecoveryLifecycleStatus) => {
        if (disposed || !tutor.ready) return;
        const labels: Record<string, string> = {
          idle: "Saved on this device",
          "upload-pending": "Saved on this device · waiting to upload",
          "archive-pending": "Saved to the course service · archive pending",
          "replication-pending": "Saved to the course service · backup pending",
          "paused-auth": "Saved on this device · reconnect to resume saving",
          "paused-conflict": "Saved on this device · recording needs attention",
          unavailable: "Saved on this device · waiting to reconnect",
        };
        post({ type: "recovery-status", message: labels[status.phase] ?? null,
          phase: status.phase, pendingEvents: status.pendingEvents });
      };
      const prepareRecovery = async () => {
        if (!developmentRecovery || !(tutor instanceof RemoteTutor) || recovery) return;
        const globalStorage = context.globalStorageUri;
        const localUserData = globalStorage.scheme === "vscode-userdata" && !globalStorage.authority && !vscode.env.remoteName;
        if ((!localUserData && globalStorage.scheme !== "file") || !isAbsolute(globalStorage.fsPath)) throw new Error("Local recovery storage is unavailable.");
        const session = await tutor.session();
        if (!session.course) throw new Error("Recovery requires a verified course identity.");
        const binding = { origin: endpoint!, subject: session.subject, courseId: session.course.id };
        const policy = archiveEnabled ? validateArchivePolicy(session.recovery?.archive_policy) : undefined;
        const credentials = async (signal?: AbortSignal) => {
          if (policy) {
            try {
              if (!approvalMatches(await readArchiveApproval(approvalDirectory, binding), binding, policy, session.noticeVersion)) throw new Error();
            } catch { throw new RecoveryAuthenticationError("Confirm the current archive policy before saving records."); }
          }
          return recoveryCredential({ context: binding,
            assignment: assignment.assignment, noticeVersion: session.noticeVersion,
            ...(policy ? { protocolVersion: 2, archivePolicy: policy } : {}),
            token: testConnection && testConnection.endpoint === endpoint ? testConnection.token : "",
            allowLoopback: true, signal });
        };
        await recoveryCredential({ context: binding, assignment: assignment.assignment,
          noticeVersion: session.noticeVersion, token: testConnection!.token,
          ...(policy ? { protocolVersion: 2, archivePolicy: policy } : {}),
          allowLoopback: true, signal: AbortSignal.timeout(10_000), requireAccepted: false });
        if (disposed) throw new Error("Tutor session closed.");
        recovery = await RecoveryLifecycle.open({
          directory: join(context.globalStorageUri.fsPath, "recovery-development-v1"),
          context: binding, assignment: assignment.assignment, allowLoopback: true,
          credentials, ...(policy ? { protocolVersion: 2 } : {}),
          onStatus: showRecovery,
        });
        try { tutor.attachRecoveryQueue(recovery.queue); }
        catch (error) { await recovery.close(); recovery = undefined; throw error; }
      };
      const showAllowance = (stale = false) => {
        if (!disposed) post({ type: "token-allowance", message: tutor instanceof RemoteTutor && tutor.canReadHistory ? tutor.allowanceLabel(stale) : "", details: tutor instanceof RemoteTutor && tutor.canReadHistory ? tutor.allowanceDetails() : "" });
      };
      const render = async () => {
        if (tutor.ready || (tutor instanceof RemoteTutor && tutor.canReadHistory)) {
          const turns = tutor instanceof RemoteTutor ? await tutor.history(50) : await tutor.history();
          post({ type: "history", turns: turns.slice(-50), warning: tutor instanceof RemoteTutor ? tutor.historyWarning : "" });
        }
        showAllowance(processing);
      };
      const sync = async () => {
        const result = await tutor.sync();
        await render();
        post({ type: "sync", message: remote
          ? result.queued ? `${result.queued} records or attempts await reconciliation. Saved locally; use Check service status to try again.` : "Saved records reconciled with the course service."
          : result.queued ? `${result.queued} events await simulated ingestion. Stored locally.` : "All records delivered to the local simulated service." });
      };
      const consentDirectory = join(context.globalStorageUri.fsPath, "consent-v1");
      let readyHandled = false;
      const confirmTutor = async () => {
        const generation = connectionGeneration;
        const session = tutor instanceof RemoteTutor ? await tutor.session() : undefined;
        checkConnectionOperation(generation);
        await recovery?.pause(); checkConnectionOperation(generation);
        await prepareRecovery(); checkConnectionOperation(generation);
        try { await tutor.confirm(); }
        catch (error) {
          await recovery?.close(); recovery = undefined;
          if (tutor instanceof RemoteTutor && !tutor.ready) tutor.attachRecoveryQueue(undefined);
          throw error;
        }
        checkConnectionOperation(generation);
        if (session) await saveConsent(consentDirectory, ownerHash, consentFingerprint(endpoint!, session, assignment.assignment));
        checkConnectionOperation(generation);
        showAssignment(); post({ type: "confirmed" });
        await recovery?.refresh();
        if (!disposed) recovery?.start();
        await render(); await sync();
      };
      const onMessage = async (message: unknown) => {
        if (typeof message !== "object" || message === null) return;
        const m = message as Record<string, unknown>;
        if (m.type === "cancel-connection") {
          connectionGeneration++;
          if (tutor instanceof RemoteTutor) tutor.cancelSessionConnection();
          return;
        }
        if (m.type === "cancel") { connectionGeneration++; tutor.cancel(); return; }
        if (m.type === "ready") {
          if (readyHandled) return;
          readyHandled = true;
          post({ type: "initial", remote, endpoint: remote ? endpoint : undefined });
          post({ type: "diagnostics", visible: diagnosticsVisible });
          // A previous explicit acceptance also permits fetching the current
          // identity on reopen. It never permits sending work before revalidation.
          try {
            if (remote && await readConsent(consentDirectory, ownerHash)) await onMessage({ type: "agree" });
          } catch (error) {
            post({ type: "error", message: error instanceof Error ? error.message : "Could not load your conversation. Reconnect to try again." });
            post({ type: "session-required", canReadHistory: false });
          } finally { post({ type: "conversation-loading", value: false }); }
          return;
        }
        if (processing) return;
        processing = true;
        const operationGeneration = connectionGeneration;
        showAllowance(true);
        const loadingConversation = ["agree", "confirm", "recover"].includes(String(m.type));
        if (loadingConversation) post({ type: "conversation-loading", value: true });
        post({ type: "busy", value: true });
        try {
          if (m.type === "agree") {
            const studentId = await tutor.agree(); checkConnectionOperation(operationGeneration);
            if (tutor instanceof RemoteTutor) {
              const session = await tutor.session(); checkConnectionOperation(operationGeneration);
              // The definition is fetched after consent. Until then use the service reference,
              // never a title from the simulator catalogue.
              const assignmentTitle = session.course?.activeAssignment?.id ?? assignment.assignment.id;
              post({ type: "identity", studentId, remote: true, assignmentTitle, displayIdentity: session.displayIdentity,
                notice: session.notice, noticeVersion: session.noticeVersion, course: session.course, subclass: session.subclass });
              if (consentMatches(await readConsent(consentDirectory, ownerHash), consentFingerprint(endpoint!, session, assignment.assignment))) {
                checkConnectionOperation(operationGeneration); await confirmTutor();
              } else await saveConsent(consentDirectory, ownerHash);
            } else post({ type: "identity", studentId });
          }
          else if (m.type === "decline" || m.type === "wrong-identity") {
            if (remote) await saveConsent(consentDirectory, ownerHash);
            tutor.decline(); await recovery?.close(); recovery = undefined;
            if (tutor instanceof RemoteTutor) tutor.attachRecoveryQueue(undefined);
            post({ type: "off", wrongIdentity: m.type === "wrong-identity" });
          }
          else if (m.type === "confirm") {
            await confirmTutor();
          } else if (["review-edit", "accept-edit", "reject-edit"].includes(String(m.type))) {
            if (!(tutor instanceof RemoteTutor) || (!tutor.ready && !(m.type === "reject-edit" && tutor.canReadHistory)) || typeof m.submissionId !== "string" || typeof m.attemptId !== "string") throw new Error("Connect to the course service and select a recorded proposal.");
            const current = await recognise(folder.uri.fsPath);
            if (current.root !== assignment.root || JSON.stringify(current.assignment) !== JSON.stringify(assignment.assignment)) throw new Error("Assignment changed. Reopen the tutor.");
            const proposal = await tutor.editProposal(m.submissionId, m.attemptId);
            if (!proposal) throw new Error("No recorded edit proposal was found.");
            validateEditForSubmission(proposal.edit, proposal.snapshot, [...assignmentFiles(currentDefinition()).map(file => file.path), "specifications.md"]);
            if (await tutor.editStatus(m.submissionId, m.attemptId)) throw new Error("This proposal already has a recorded decision. Recover its status or ask for a new proposal.");
            const key = m.submissionId + "/" + m.attemptId;
            if (m.type === "review-edit") {
              await editReview.review(assignment.root, folder.uri.fsPath, key, proposal.edit);
              post({ type: "edit-reviewed", submissionId: m.submissionId, attemptId: m.attemptId });
            } else if (m.type === "reject-edit") {
              await tutor.recordEdit(m.submissionId, m.attemptId, "rejected");
            } else {
              if (!editReview.hasReviewed(key)) throw new Error("Review the proposed diff before accepting it.");
              await tutor.recordEdit(m.submissionId, m.attemptId, "accepted");
              const result = await editReview.apply(assignment.root, folder.uri.fsPath, key, proposal.edit);
              await tutor.recordEdit(m.submissionId, m.attemptId, result.kind, result.text);
            }
            await render();
          } else if (m.type === "submit" || m.type === "retry") {
            if (!tutor.ready) throw new Error("Agree and confirm your identity first.");
            const modes: Mode[] = ["normal", "failure", "timeout", "malformed"];
            if (!remote && !modes.includes(m.mode as Mode)) throw new Error("Invalid simulator mode.");
            const mode: Mode = remote ? "normal" : m.mode as Mode;
            // Capture synchronously at host receipt, before filesystem/service awaits.
            const buffers = vscode.workspace.textDocuments
              .filter(doc => !doc.isClosed && doc.uri.scheme === "file" &&
                [assignment.root, folder.uri.fsPath].some(root => eligibleWorkspacePath(relative(root, doc.uri.fsPath).split(sep).join("/"))))
              .map(doc => ({ filename: doc.uri.fsPath, text: doc.getText(), documentVersion: doc.version, language: doc.languageId }));
            if (m.type === "submit" && typeof m.text !== "string") throw new Error("Invalid prompt.");
            const current = await recognise(folder.uri.fsPath);
            if (current.root !== assignment.root || current.assignment.id !== assignment.assignment.id || current.assignment.version !== assignment.assignment.version) throw new Error("Assignment changed. Reopen the tutor.");
            if (m.type === "retry") {
              if (typeof m.submissionId !== "string") throw new Error("Invalid submission ID.");
              if (remote) {
                const proceed = testApi && testConnection ? "Retry original submission" : await vscode.window.showWarningMessage("Retry uses the original prompt and code. If the previous model request has an unknown outcome, another request may incur another charge.", { modal: true }, "Retry original submission");
                if (proceed !== "Retry original submission") return;
              }
              if (disposed) return;
              if (tutor instanceof RemoteTutor) await tutor.retry(m.submissionId, mode, true);
              else await tutor.retry(m.submissionId, mode);
            } else {
              const snapshot: Snapshot = {
                path: "workspace", language: "plaintext", text: "", documentVersion: 1, selection: null,
                workspace: await captureWorkspace(assignment.root, buffers),
                // Wire compatibility: this allows a proposal, never automatic application.
                ...(remote ? { requestEdit: true } : {}),
              };
              await tutor.submit(m.text as string, snapshot, mode, async () => {
                // Finish recording an accepted Send even if the view closed during
                // capture, but cancel before any fresh provider dispatch.
                if (disposed) { tutor.cancel(); return; }
                await recovery?.refresh();
                if (disposed) { tutor.cancel(); return; }
                post({ type: "recorded", capturedPaths: snapshot.workspace?.files.map(file => file.path) ?? [snapshot.path] }); await render();
              });
            }
            if (disposed) return;
            await render(); await sync();
          } else if (m.type === "sync") {
            if (!tutor.ready || (!remote && typeof m.offline !== "boolean")) throw new Error("Confirm your identity first.");
            if (!remote) simulation!.setOffline(m.offline as boolean);
            await sync();
          } else if (m.type === "recover") {
            await tutor.recover(); await render(); await sync();
          }
        } catch (err) {
          if (err instanceof AssignmentFolderError) {
            folderRefused = true;
            await recovery?.pause();
            const course = tutor instanceof RemoteTutor ? tutor.course : undefined;
            const expected = course?.activeAssignment;
            const title = expected?.id;
            const message = expected ? `This folder is not for your current assignment: ${title} (${expected.id}, version ${expected.version}). Open its assignment folder to use the tutor.` : err.message;
            view.webview.html = setupHtml(view.webview, context.extensionUri, message, true);
            testApi?.messages.push({ type: "folder-refused", message });
            return;
          }
          post({ type: "error", message: err instanceof Error ? err.message : "The operation failed.",
            ...(["review-edit", "accept-edit", "reject-edit"].includes(String(m.type)) && typeof m.submissionId === "string" && typeof m.attemptId === "string"
              ? { submissionId: m.submissionId, attemptId: m.attemptId } : {}),
          });
          if (tutor instanceof RemoteTutor && !tutor.ready) {
            await recovery?.pause();
            post({ type: "session-required", canReadHistory: tutor.canReadHistory });
          }
          try { await render(); } catch { /* Fail closed on unreadable history. */ }
        } finally {
          processing = false;
          showAllowance();
          if (loadingConversation) post({ type: "conversation-loading", value: false });
          post({ type: "busy", value: false });
          // Informational balance refresh must not hold the composer lock during backoff.
          if (!disposed && operationGeneration === connectionGeneration && tutor instanceof RemoteTutor && tutor.canReadHistory &&
              ["agree", "confirm", "submit", "retry", "sync", "recover"].includes(String(m.type))) {
            await tutor.refreshAllowance();
            if (!disposed && operationGeneration === connectionGeneration) {
              showAllowance(processing);
              if (!tutor.ready) post({ type: "session-required", canReadHistory: tutor.canReadHistory });
            }
          }
          if (recovery && tutor.ready && !disposed) {
            try { await recovery.refresh(); } catch { post({ type: "recovery-status", message: "Saved on this device · recording needs attention", phase: "unavailable" }); }
          }
        }
      };
      let exporting = false;
      const exportChat = async (): Promise<void> => {
        if (exporting) return;
        exporting = true;
        try {
          const identity = tutor.confirmedSubject;
          if (!identity) throw new Error("Confirm your identity before exporting chat.");
          const d = currentDefinition();
          const exportedAt = new Date().toISOString();
          // Freeze a local snapshot before the dialog; a running reply may finish
          // independently and will appear in the next export.
          const markdown = formatChatExport({ assignment: { id: d.id, version: d.version, title: d.title }, studentIdentity: identity,
            course: tutor instanceof RemoteTutor ? tutor.course : undefined, turns: await tutor.history(), historyWarning: tutor instanceof RemoteTutor ? tutor.historyWarning : undefined, exportedAt });
          const target = await vscode.window.showSaveDialog({ title: "Export chat · local records", saveLabel: "Export chat",
            defaultUri: vscode.Uri.file(join(assignment.root, chatExportFilename(d.id, exportedAt))), filters: { Markdown: ["md"] } });
          if (!target) { post({ type: "export-result", message: "Export cancelled." }); return; }
          if (disposed || target.scheme !== "file") throw new Error("Choose a local file for the export.");
          if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === target.toString() && doc.isDirty)) throw new Error("Save or close the unsaved export document before replacing it.");
          if (disposed) return;
          try { await writeChatExport(target.fsPath, markdown); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const replace = await vscode.window.showWarningMessage("Replace this existing chat export?", { modal: true }, "Replace export");
            if (replace !== "Replace export") { post({ type: "export-result", message: "Export cancelled. Existing file kept." }); return; }
            if (disposed) return;
            await writeChatExport(target.fsPath, markdown, true);
          }
          post({ type: "export-result", message: "Chat exported. This copy contains local records and may be incomplete." });
        } catch (error) { post({ type: "export-result", message: error instanceof Error ? error.message : "Could not export chat." }); }
        finally { exporting = false; }
      };
      previewClosed = async () => {
        if (!developmentTools) return;
        if (disposed || folderRefused || !tutor.ready) { await vscode.window.showInformationMessage("Open the tutor and confirm your identity before previewing closure."); return; }
        if (processing || tutor.busy) { await vscode.window.showInformationMessage("Wait for the current request to finish before previewing closure."); return; }
        closedPreview = true;
        post({ type: "closed-preview", value: true, title: currentDefinition().title });
      };
      const receive = async (message: unknown): Promise<void> => {
        if (disposed || typeof message !== "object" || message === null) return;
        const m = message as Record<string, unknown>;
        if (m.type === "export-chat") {
          if (exporting) return;
          const task = exportChat(); tasks.add(task);
          try { await task; } finally { tasks.delete(task); }
          return;
        }
        if (m.type === "preview-closed") { await previewClosed(); return; }
        if (closedPreview) {
          if (m.type === "leave-closed-preview" && !processing) { closedPreview = false; post({ type: "closed-preview", value: false }); }
          return;
        }
        if (m.type === "connect") { await vscode.commands.executeCommand("assignmentTutorV2.connect"); return; }
        if (m.type === "choose-folder") { await chooseAssignmentFolder(); return; }
        if (m.type === "restart" || m.type === "check-folder") { await vscode.commands.executeCommand("assignmentTutorV2.restart"); return; }
        if (folderRefused) return;
        if (m.type === "open-file") {
          try {
            const d = currentDefinition();
            const files = assignmentFiles(d);
            const selected = files.length === 1 ? files[0]!.path : await vscode.window.showQuickPick(files.map(f => f.path), { placeHolder: "Choose an assignment file" });
            if (!selected) return;
            const filename = join(assignment.root, selected);
            await assignmentFile(assignment.root, filename, files);
            await vscode.window.showTextDocument(vscode.Uri.file(filename), { preserveFocus: true });
          } catch (err) {
            post({ type: "error", message: err instanceof Error ? err.message : "Could not open the assignment file." });
          }
          return;
        }
        const task = onMessage(message);
        tasks.add(task);
        try { await task; } finally { tasks.delete(task); }
      };
      if (testApi) {
        testApi.dispatch = receive;
        testApi.close = async () => { startup = initialise(view); await startup; };
      }
      const bridge = view.webview.onDidReceiveMessage(message => { void receive(message); });
      const ownedLease = lease;
      let disposal: Promise<void> | undefined;
      cleanup = () => disposal ??= (async () => {
        disposed = true; connectionGeneration++; tutor.cancel();
        if (tutor instanceof RemoteTutor) await tutor.close();
        bridge.dispose();
        const stopping = recovery?.pause();
        await Promise.allSettled([...tasks]);
        await stopping; await recovery?.close();
        await ownedLease.release();
      })();
      view.webview.html = html(view.webview, context.extensionUri, remote);
    } catch (err) {
      await recovery?.close();
      await lease?.release();
      const message = setupMessage(err);
      view.webview.html = setupHtml(view.webview, context.extensionUri, message);
      if (testApi) {
        testApi.messages.push({ type: "setup", message });
        testApi.dispatch = async () => { throw new Error("Open the recognised assignment folder first."); };
      }
      const bridge = view.webview.onDidReceiveMessage(message => {
        if (message?.type === "connect") void vscode.commands.executeCommand("assignmentTutorV2.connect");
        if (message?.type === "choose-folder") void chooseAssignmentFolder();
        if (message?.type === "check-folder") void vscode.commands.executeCommand("assignmentTutorV2.restart");
      });
      cleanup = async () => { bridge.dispose(); };

    } finally { opening = false; }
  };
  if (testApi) testApi.configureRemote = async (endpoint, token, recoveryEnabled = false, archiveEnabled = false) => {
    if (endpoint) {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.username || url.password || url.search || url.hash || !token) throw new Error("Host tests require a loopback synthetic service.");
      if (archiveEnabled && !recoveryEnabled) throw new Error("Archive trial requires explicit recovery enablement.");
      testConnection = { endpoint, token, recoveryEnabled: recoveryEnabled === true, archiveEnabled: archiveEnabled === true };
    } else testConnection = undefined;
    if (sidebar) { startup = initialise(sidebar); await startup; }
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("assignmentTutorV2.chat", {
    resolveWebviewView(view) {
      sidebar = view;
      view.onDidDispose(() => { sidebar = undefined; void cleanup(); }, undefined, context.subscriptions);
      startup = initialise(view);
      resolveFirstView();
      return startup;
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.open", async () => {
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand("assignmentTutorV2.chat.focus");
    await firstView;
    await startup;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.restart", async () => {
    if (sidebar) { startup = initialise(sidebar); await startup; }
  }));
  if (developmentTools) context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.previewClosed", async () => {
    if (!developmentTools) return;
    await vscode.commands.executeCommand("assignmentTutorV2.open");
    await previewClosed();
  }));
  const saveConnection = async (endpoint: string, key: string): Promise<void> => {
    await context.secrets.store(`courseServiceKey:${endpoint}`, key);
    await context.globalState.update("courseServiceUrl", endpoint);
    await context.globalState.update("tutorMode", "remote");
    await vscode.commands.executeCommand("assignmentTutorV2.open");
    await vscode.commands.executeCommand("assignmentTutorV2.restart");
  };
  if (developmentTools) context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.importConnection", async () => {
    const chosen = await vscode.window.showOpenDialog({ title: "Import Course Connection", canSelectMany: false,
      canSelectFolders: false, canSelectFiles: true, filters: { "Course connection": ["json"] }, openLabel: "Import connection" });
    if (!chosen?.length) return;
    try {
      if (chosen[0]!.scheme !== "file") throw new Error("Local file required.");
      const file = await open(chosen[0]!.fsPath, "r");
      let source: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 65_536) throw new Error("Invalid connection file.");
        // Bound the actual read as well as stat, including a file growing after stat.
        const bytes = Buffer.alloc(65_537);
        let size = 0;
        while (size < bytes.length) {
          const result = await file.read(bytes, size, bytes.length - size, null);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        if (size > 65_536) throw new Error("Invalid connection file.");
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
      } finally { await file.close(); }
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid connection file.");
      const connection = value as Record<string, unknown>;
      if (Object.keys(connection).length !== 2 || !Object.hasOwn(connection, "endpoint") || !Object.hasOwn(connection, "token") ||
          typeof connection.endpoint !== "string" || typeof connection.token !== "string" || !connection.token || /\s/.test(connection.token)) throw new Error("Invalid connection file.");
      const endpoint = courseUrl(connection.endpoint);
      const confirmed = await vscode.window.showInformationMessage(`Import the course connection for ${endpoint}? The key will be saved in VS Code's secret store. You will review the service notice before any authentication or coursework submission.`, { modal: true }, "Import connection");
      if (confirmed !== "Import connection") return;
      await saveConnection(endpoint, connection.token);
    } catch {
      // Never echo parser errors or file contents, which may contain the credential.
      await vscode.window.showErrorMessage("Could not import the connection. Choose a local JSON file of at most 64 KiB containing only an HTTPS endpoint and a non-empty token without whitespace. Check that VS Code's secret store is available.");
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.connect", async () => {
    // Application-scoped setting: an assignment workspace cannot choose the key recipient.
    const address = developmentTools ? vscode.workspace.getConfiguration("assignmentTutorV2").inspect<string>("courseServiceUrl") : undefined;
    let suppliedAddress = developmentTools
      ? address?.globalValue || context.globalState.get<string>("courseServiceUrl") || address?.defaultValue
      : STUDENT_SERVICE_ORIGIN;
    if (!suppliedAddress) {
      suppliedAddress = await vscode.window.showInputBox({ title: "Connect to your course", prompt: "Enter the HTTPS course service address supplied by your teacher.", ignoreFocusOut: true,
        validateInput: value => { try { courseUrl(value); return undefined; } catch { return "Enter an HTTPS address without a path, query or credentials."; } } });
      if (suppliedAddress === undefined) return;
    }
    let endpoint: string;
    try { endpoint = courseUrl(suppliedAddress); }
    catch { await vscode.window.showErrorMessage("Check the course service address in User settings. Use the HTTPS address supplied by your teacher."); return; }
    const key = await vscode.window.showInputBox({ title: "Connect to your course", prompt: developmentTools ? `Enter the personal course key for ${endpoint}.` : "Enter the personal course key supplied by your teacher. Your course and assignment will be selected automatically.", password: true, ignoreFocusOut: true,
      validateInput: value => !value.trim() || /\s/.test(value) ? "Enter the credential without whitespace." : undefined });
    if (key === undefined || !key.trim() || /\s/.test(key)) return;
    await saveConnection(endpoint, key);
  }));
  if (developmentTools) context.subscriptions.push(vscode.commands.registerCommand("assignmentTutorV2.simulator", async () => {
    if (!developmentTools) return;
    await context.globalState.update("tutorMode", "simulator");
    await vscode.commands.executeCommand("assignmentTutorV2.open");
    await vscode.commands.executeCommand("assignmentTutorV2.restart");
  }));
  context.subscriptions.push({ dispose: () => { void cleanup(); } });
  const resumeFolder = context.globalState.get<string>("openTutorForFolder");
  if (resumeFolder && vscode.workspace.workspaceFolders?.length === 1 &&
      vscode.workspace.workspaceFolders[0]!.uri.toString() === resumeFolder) {
    void context.globalState.update("openTutorForFolder", undefined).then(() =>
      vscode.commands.executeCommand("assignmentTutorV2.open"));
  }
  return testApi;
}

const conversationLoadingMarkup = `<p id="conversation-loading" role="status" aria-live="polite" aria-atomic="true"><span class="conversation-spinner" aria-hidden="true"></span><span>Loading your conversation…</span></p>`;
function loadingHtml(webview: vscode.Webview, extension: vscode.Uri): string {
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, "media", "chat.css"));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource};"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${style}"></head><body>${conversationLoadingMarkup}</body></html>`;
}

function html(webview: vscode.Webview, extension: vscode.Uri, remote = false): string {
  const nonce = randomBytes(24).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, "media", "chat.js"));
  const markdownScript = webview.asWebviewUri(vscode.Uri.joinPath(extension, "node_modules", "markdown-it", "dist", "browser", "markdown-it.umd.min.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, "media", "chat.css"));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${style}">
    <title>Assignment Guide</title></head><body>
    <h1>Assignment Guide</h1>${remote ? "" : '<p class="banner">Test version: replies are simulated. No AI is connected and nothing leaves this computer.</p>'}
    <div id="session-connection" hidden><span id="session-connection-status" role="status" aria-live="polite"></span> <button id="cancel-connection" type="button">Cancel connection</button></div>
    <div class="export-toolbar"><button id="export-chat" type="button">Export chat</button><span id="export-status" role="status"></span></div>
    <button id="reconnect" type="button" hidden>Reconnect to course</button><p id="error" role="alert"></p>
    <p id="history-warning" role="alert" hidden></p>
    ${conversationLoadingMarkup}
    <section id="consent" hidden><h2>Before you begin</h2>
      ${remote ? `<p>Understand your assignment. Develop your own solution.</p>
      <p>Every question you submit, captured project files, tutor replies and edit decisions are saved on your device and by your course service. Relevant coursework is sent to an AI provider for guidance. Unsent drafts are not recorded.</p>
      <p>AI replies can be wrong. You remain responsible for your work. Changes to your files require your review and acceptance. Keep passwords and personal information out of your project files.</p>
      <p>Select <strong>Continue</strong> to connect and review your identity and the course’s recording notice. No questions or code are sent at this stage.</p>` : `<p>The planned tutor uses AI. This simulator produces canned guidance using the registered assignment definition.</p>
      <p>Every question you submit, bounded snapshots of eligible workspace text files (including unsaved editor contents), response and request outcome are stored on this computer under a test identity. A second local copy simulates course ingestion. Nothing leaves this computer.</p>`}
      ${remote ? "" : "<p>Unsent drafts are not recorded. You remain responsible for your code. Declining keeps the tutor off.</p>"}
      <button id="agree">${remote ? "Continue" : "Agree"}</button><button id="decline">Don’t use the tutor</button>
    </section>
    <section id="identity" hidden><h2>Confirm your details</h2><p id="identity-copy"></p><p id="course-info"></p><p id="recipient-label"></p>${remote ? '<p>By continuing, you accept the course’s recording notice and confirm these details are yours.</p><details id="notice-details"><summary>Full recording notice</summary><p id="service-notice"></p></details><p>We’ll remember your acceptance on this device. You’ll be asked again if your identity, assignment or recording terms change.</p>' : '<p id="service-notice"></p>'}<button id="confirm">${remote ? "Confirm and start" : "Confirm test identity"}</button><button id="wrong-identity">These details aren’t mine</button></section>
    <section id="off" hidden><p id="off-copy">The tutor is off. You can reconsider below.</p><button id="reconsider">Review consent</button></section>
    <section id="closed-assignment" hidden>
      <p class="banner">Preview only · the live assignment remains open.</p>
      <h2>This assignment has closed.</h2><p id="closed-title"></p>
      <p>You can export your conversation for your records or submission.</p>
      <p>This preview exports all chat saved on this device. It may be incomplete.</p>
      <button id="leave-closed-preview" type="button">Return to open assignment</button>
    </section>
    <main id="chat" hidden><button id="open-file" type="button">Open assignment file</button><h2 id="assignment-info"></h2>
      <section id="history" aria-live="polite"></section>
      <p id="thinking" role="status" aria-live="polite" aria-atomic="true" hidden>
        <span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        <span id="thinking-label"></span>
      </p>
      <form id="composer"><label for="prompt">Your question</label><textarea id="prompt" rows="4" aria-describedby="prompt-hint"></textarea>
        <small id="prompt-hint">Enter to send · Shift+Enter for a new line</small>
        <div class="composer-actions">
          <div class="request-buttons"><button id="send" type="submit">Send</button><button id="cancel" type="button" disabled>Cancel request</button></div>
          <small id="token-allowance" role="status" aria-live="polite" tabindex="0" hidden></small>
        </div>
        <small id="saving-status" role="status" aria-live="polite"></small>
        <details id="captured-files" hidden><summary>Files included with your last question</summary><p>These files were captured for the course record. The tutor may use a selection of them.</p><ul id="captured-paths"></ul></details>
      </form>
      <details id="diagnostics" hidden><summary>${remote ? "Service and recovery" : "Simulator checks"}</summary><div ${remote ? "hidden" : ""}>
        <label for="mode">Next attempt</label><select id="mode"><option value="normal">Normal response</option><option value="failure">Service failure</option><option value="timeout">Timeout</option><option value="malformed">Malformed response</option></select>
        <label><input type="checkbox" id="offline">Simulated ingestion offline</label></div>
        <button id="restart">Restart tutor session</button><button id="sync">${remote ? "Check service status" : "Retry ingestion"}</button><button id="recover">${remote ? "Recover service attempts" : "Recover interrupted attempts"}</button>
        <p>Retries reuse the original prompt and code snapshot. Send again to record changed code.</p>
        <p id="sync-status" role="status"></p>
      </details>
    </main><script nonce="${nonce}" src="${markdownScript}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function courseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("Invalid course service URL.");
  return url.href.replace(/\/+$/, "");
}

function setupMessage(error: unknown): string {
  if (error instanceof Error && /lock|records|storage|course service connection/i.test(error.message)) return error.message;
  return "Open your assignment Git repository as a single folder. It should contain assignment.json identifying the assignment and version. Then click Check this folder. Do not open the extension source folder.";
}

function setupHtml(webview: vscode.Webview, extension: vscode.Uri, message: string, refused = false): string {
  const nonce = randomBytes(24).toString("base64");
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, "media", "chat.css"));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, "media", "setup.js"));
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${style}"></head><body>
    <h1>Open your assignment</h1><p>${escaped}</p>
    <button id="connect">Connect to your course</button>
    <button id="choose-folder">Open assignment folder</button><button id="check-folder">Check this folder</button>
    <p>${refused ? "The tutor is unavailable in this folder. Previously saved submissions are retained." : "No questions or code have been collected."}</p><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
