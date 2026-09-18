import * as vscode from "vscode";
import { join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { assignmentFile } from "./assignment";
import { validateEdit, type EditProposal } from "./edits";

/** Read-only virtual diffs; applying uses VS Code's versioned editor transaction. */
export function createEditReview(context: vscode.ExtensionContext) {
  const documents = new Map<string, string>();
  const reviewed = new Map<string, { document: vscode.TextDocument; version: number; identity: string; after: string }>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("assignment-tutor-edit", {
    provideTextDocumentContent(uri) { return documents.get(uri.toString()) ?? "Review expired. Reopen the proposed change."; },
  }));
  async function editor(root: string, originalRoot: string, edit: EditProposal) {
    validateEdit(edit);
    const filename = join(root, edit.path);
    await assignmentFile(root, filename, [{ path: edit.path, language: "plaintext" }]);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await realpath(filename) !== filename) throw new Error("The edit target is no longer a regular assignment file.");
    const candidates = vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.scheme === "file" &&
      [filename, join(originalRoot, edit.path), ...(filename.startsWith("/private/var/") ? [filename.slice("/private".length)] : [])].includes(doc.uri.fsPath));
    if (candidates.length > 1) throw new Error("Close duplicate tabs for this file before reviewing or applying an edit.");
    if (candidates.some(doc => doc.getText() !== edit.before)) throw new Error("The file has changed since this proposal. Ask for a fresh edit.");
    const document = candidates[0] ?? await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    if (document.getText() !== edit.before) throw new Error("The file has changed since this proposal. Ask for a fresh edit.");
    return { document, identity: `${stat.dev}:${stat.ino}` };
  }
  return {
    async review(root: string, originalRoot: string, key: string, edit: EditProposal) {
      const { document, identity } = await editor(root, originalRoot, edit);
      if (reviewed.size >= 50 && !reviewed.has(key)) { reviewed.clear(); documents.clear(); }
      const before = vscode.Uri.from({ scheme: "assignment-tutor-edit", path: `/${key}/before/${edit.path}` });
      const after = vscode.Uri.from({ scheme: "assignment-tutor-edit", path: `/${key}/after/${edit.path}` });
      documents.set(before.toString(), edit.before); documents.set(after.toString(), edit.after);
      await vscode.commands.executeCommand("vscode.diff", before, after, `${edit.path}: proposed change`, { preview: true });
      reviewed.set(key, { document, version: document.version, identity, after: edit.after });
    },
    hasReviewed(key: string) { return reviewed.has(key); },
    async apply(root: string, originalRoot: string, key: string, edit: EditProposal): Promise<{ kind: "applied" | "conflict" | "failed" | "unknown"; text: string | null }> {
      const review = reviewed.get(key); reviewed.delete(key);
      let document: vscode.TextDocument;
      try {
        const current = await editor(root, originalRoot, edit); document = current.document;
        if (!review || document !== review.document || document.version !== review.version || current.identity !== review.identity || edit.after !== review.after) return { kind: "conflict", text: null };
      } catch { return { kind: "conflict", text: null }; }
      const target = await vscode.window.showTextDocument(document, { preview: false });
      try {
        const checked = await editor(root, originalRoot, edit);
        if (checked.document !== document || checked.identity !== review.identity) return { kind: "conflict", text: null };
      } catch { return { kind: "conflict", text: null }; }
      // No await between these checks and TextEditor.edit, which includes the document version.
      if (document.isClosed || document.version !== review.version || document.getText() !== edit.before) return { kind: "conflict", text: null };
      let applied: boolean;
      try {
        applied = await target.edit(builder => builder.replace(new vscode.Range(document.positionAt(0), document.positionAt(edit.before.length)), edit.after), { undoStopBefore: true, undoStopAfter: true });
      } catch { return { kind: "unknown", text: null }; }
      const text = document.getText();
      const captured = Buffer.byteLength(text, "utf8") <= 8000 ? text : null;
      if (!applied) return { kind: "failed", text: captured };
      return { kind: text === edit.after ? "applied" : "unknown", text: captured };
    },
  };
}
