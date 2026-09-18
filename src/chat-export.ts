import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, link, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AssignmentRef, Turn } from "./domain";
import type { RemoteTurn } from "./remote";

export type ChatExport = {
  assignment: AssignmentRef & { title: string };
  studentIdentity: string;
  course?: { id: string; title: string };
  turns: readonly (Turn | RemoteTurn)[];
  exportedAt: string;
  historyWarning?: string;
};
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;

/** Untrusted conversation text stays literal, including HTML and embedded fences. */
function literal(value: string): string {
  let longest = 2;
  for (const run of value.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}\n`;
}
function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid chat export date.");
  return date.toISOString();
}

/** Includes every supplied local turn. Never silently truncates an export. */
export function formatChatExport(input: ChatExport): string {
  const pieces: string[] = []; let bytes = 0;
  const append = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_EXPORT_BYTES) throw new Error("Chat export exceeds the 100 MiB limit. No export was written.");
    pieces.push(value);
  };
  append("# Assignment Guide conversation\n\nSource: locally saved records. This export may be incomplete, including conversations on other devices and outcomes not yet synchronised. It is not an officially verified submission.\n\n");
  if (input.historyWarning) append("## Incomplete local history\n\n" + literal(input.historyWarning) + "\n");
  append("## Export details\n\n" + literal(`Assignment: ${input.assignment.title}\nAssignment ID: ${input.assignment.id}\nVersion: ${input.assignment.version}\nStudent identity: ${input.studentIdentity}\n${input.course ? `Course: ${input.course.title} (${input.course.id})\n` : ""}Exported at: ${timestamp(input.exportedAt)}\nSubmissions: ${input.turns.length}`));
  append("\nFile snapshots, proposed/applied file contents, credentials and internal diagnostics are not included. Prompt and reply text is reproduced literally. Attempt timestamps are included where available in local records.\n\n");
  input.turns.forEach((turn, index) => {
    append(`## Submission ${index + 1}\n\n`);
    const remote = "recordedByService" in turn;
    append(literal(`Submission ID: ${turn.submission.id}\nCaptured at: ${turn.submission.ts}\nReceipt: ${remote ? turn.recordedByService ? "recorded by course service" : "not confirmed by course service" : "local simulator record"}`));
    append("\n### Student prompt\n\n" + literal(turn.submission.prompt));
    if (!turn.attempts.length) append("\nNo attempt recorded.\n");
    turn.attempts.forEach((attempt, attemptIndex) => {
      append(`\n### Attempt ${attemptIndex + 1}\n\n`);
      append(literal(`Attempt ID: ${attempt.start.attemptId}\nState: ${attempt.outcome?.status ?? "pending"}${"ts" in attempt.start ? `\nStarted at: ${attempt.start.ts}` : ""}${attempt.outcome && "ts" in attempt.outcome ? `\nOutcome at: ${attempt.outcome.ts}` : ""}`));
      if (attempt.outcome?.reply) append("\nTutor reply:\n\n" + literal(attempt.outcome.reply.prose));
      else append("\nNo tutor reply recorded for this attempt.\n");
      if ("editEvents" in attempt) {
        if (attempt.outcome?.reply && "edit" in attempt.outcome.reply && attempt.outcome.reply.edit) append("\nA file edit was proposed. File contents are excluded from this export.\n");
        for (const event of attempt.editEvents) append("\nEdit decision or outcome:\n\n" + literal(`State: ${event.kind}\nObserved at: ${event.observedAt}\nEvent ID: ${event.eventId}`));
        if (attempt.editPending) append("\nEdit records awaiting course service confirmation.\n");
      }
    });
    append("\n");
  });
  return pieces.join("");
}

export function chatExportFilename(assignmentId: string, exportedAt: string): string {
  const slug = assignmentId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 100) || "assignment";
  return `tutor-chat-${slug}-${timestamp(exportedAt).replace(/[:.]/g, "-")}.md`;
}

/** Save As must explicitly confirm replacement; never truncate a link or special file. */
export async function writeChatExport(path: string, markdown: string, overwrite = false): Promise<void> {
  if (!/^tutor-chat-[a-zA-Z0-9_-]+\.md$/.test(basename(path))) throw new Error("Use an export filename beginning tutor-chat- and ending .md, containing only letters, numbers, hyphens or underscores.");
  if (Buffer.byteLength(markdown) > MAX_EXPORT_BYTES) throw new Error("Chat export exceeds the 100 MiB limit.");
  let existing;
  try { existing = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    if (!overwrite) throw Object.assign(new Error("Export already exists."), { code: "EEXIST" });
    if (!existing.isFile() || existing.nlink !== 1) throw new Error("Export destination must be a regular file with no links.");
  }
  const temporary = join(dirname(path), `.tutor-chat-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(markdown, "utf8"); await file.sync(); }
    finally { await file.close(); }
    if (existing) {
      const current = await lstat(path);
      if (!current.isFile() || current.nlink !== 1 || current.dev !== existing.dev || current.ino !== existing.ino ||
          current.size !== existing.size || current.mtimeMs !== existing.mtimeMs || current.ctimeMs !== existing.ctimeMs) {
        throw new Error("Export destination changed. Choose another file.");
      }
      await rename(temporary, path);
    } else {
      // Exclusive publication: never replace a file created after the Save As check.
      await link(temporary, path);
      await unlink(temporary);
    }
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
