import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type WorkspaceFile = { path: string; language: string; text: string; documentVersion: number };
export type WorkspaceContext = { files: WorkspaceFile[] };
export type WorkspaceBuffer = { filename: string; text: string; documentVersion: number; language: string };
export const MAX_WORKSPACE_FILES = 40;
export const MAX_WORKSPACE_BYTES = 12_000;
export const MAX_WORKSPACE_FILE_BYTES = 8_000;
const MAX_ENTRIES = 2_000;
const languages: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", tsx: "typescriptreact", jsx: "javascriptreact", md: "markdown", txt: "plaintext", json: "json", css: "css", html: "html", csv: "csv" };
const excludedDirectories = new Set(["node_modules", "bower_components", "vendor", "dist", "build", "out", "coverage", "target", "__pycache__", "venv", "env", "site-packages", "typings"]);
const excludedFiles = new Set(["assignment.json", "pilot.json", "pilot-connection.json", "proxy-environment.json", "tutor-preferences.json", "tutor.md", "agents.md", "claude.md", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]);
const secretName = /(?:secret|credential|password|passwd|token|(?:api|private|access)[_-]?key|(?:^|[._-])keys?(?:[._-]|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$))/i;
const lockName = /(?:^|[._-])lock(?:[._-]|$)/i;
const error = (reason: string) => new Error(`Cannot capture workspace: ${reason}`);
function parts(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || isAbsolute(value)) return undefined;
  const result = value.split("/");
  if (result.some(part => !part || part.startsWith(".") || part.includes(":"))) return undefined;
  return result;
}
function permittedDirectories(segments: string[]): boolean { return segments.every(segment => !excludedDirectories.has(segment.toLowerCase()) && !secretName.test(segment)); }
/** Shared client/service allowlist. Filename filtering is not a content secret scanner. */
export function eligibleWorkspacePath(value: unknown): value is string {
  const segments = parts(value); if (!segments || !permittedDirectories(segments.slice(0, -1))) return false;
  const name = segments.at(-1)!.toLowerCase();
  return name.includes(".") && !excludedFiles.has(name) && !/^tutor-chat-.*\.md$/.test(name) && !secretName.test(name) && !lockName.test(name) && Object.hasOwn(languages, name.split(".").at(-1)!);
}
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function textValid(text: unknown): text is string {
  return typeof text === "string" && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) && Buffer.byteLength(text, "utf8") <= MAX_WORKSPACE_FILE_BYTES;
}
export function validateWorkspace(value: unknown): asserts value is WorkspaceContext {
  if (!object(value, ["files"]) || !Array.isArray(value.files) || value.files.length > MAX_WORKSPACE_FILES) throw error("use at most 40 eligible text files.");
  const seen = new Set<string>();
  for (const file of value.files) {
    if (!object(file, ["path", "language", "text", "documentVersion"]) || !eligibleWorkspacePath(file.path) || seen.has(file.path) ||
        typeof file.language !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(file.language) || !textValid(file.text) ||
        !Number.isSafeInteger(file.documentVersion) || Number(file.documentVersion) < 1) throw error("an eligible file has an invalid path, text, version or language, or exceeds 8,000 bytes.");
    seen.add(file.path);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_WORKSPACE_BYTES) throw error("eligible files exceed the 12,000-byte context limit. Reduce the files before sending.");
}
function inside(root: string, target: string): string | undefined {
  const path = relative(root, target).split(sep).join("/");
  return parts(path) ? path : undefined;
}

/** Captures existing eligible files only. No commands, execution, links, or silent size truncation. */
export async function captureWorkspace(root: string, buffers: readonly WorkspaceBuffer[] = []): Promise<WorkspaceContext> {
  // Copy immediately, before filesystem awaits, so a caller cannot change captured buffer text.
  const captured = buffers.map(buffer => ({ ...buffer }));
  const canonicalRoot = await realpath(root);
  const overrides = new Map<string, WorkspaceBuffer>();
  for (const buffer of captured) {
    const filename = resolve(buffer.filename);
    let path = inside(canonicalRoot, filename);
    // Canonicalise only the parent: this supports /var aliases without following a file symlink.
    if (!path) {
      try { path = inside(canonicalRoot, join(await realpath(dirname(filename)), basename(filename))); }
      catch { continue; }
    }
    if (!path || !eligibleWorkspacePath(path)) continue;
    const previous = overrides.get(path);
    if (previous) {
      if (previous.text !== buffer.text || previous.language !== buffer.language) throw error("duplicate editor tabs have conflicting contents. Close the duplicate tabs before sending.");
      if (buffer.documentVersion > previous.documentVersion) overrides.set(path, buffer);
    } else overrides.set(path, buffer);
  }
  const files: WorkspaceFile[] = []; let entries = 0;
  const observed = new Map<string, Stats>();
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;

  async function read(path: string): Promise<string> {
    const filename = join(canonicalRoot, path);
    const canonical = await realpath(filename);
    if (canonical !== filename || inside(canonicalRoot, canonical) !== path) throw error("a file path changed or points outside the workspace.");
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw error("a file changed while capturing.");
    if (before.size > MAX_WORKSPACE_FILE_BYTES && !overrides.has(path)) throw error("an eligible file exceeds 8,000 bytes.");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !same(before, stat) || await realpath(filename) !== filename) throw error("a file changed while capturing.");
      const buffer = overrides.get(path);
      observed.set(path, stat);
      if (buffer) return buffer.text;
      if (stat.size > MAX_WORKSPACE_FILE_BYTES) throw error("an eligible file exceeds 8,000 bytes.");
      const bytes = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1); let size = 0;
      while (size < bytes.length) { const chunk = await handle.read(bytes, size, bytes.length - size, null); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
      if (size > MAX_WORKSPACE_FILE_BYTES) throw error("an eligible file exceeds 8,000 bytes.");
      if (!same(stat, await handle.stat())) throw error("a file changed while capturing. Send again when edits have finished.");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); }
      catch { throw error("an eligible file is not UTF-8 text."); }
    } finally { await handle.close(); }
  }
  async function scan(directory: string): Promise<void> {
    const filename = join(canonicalRoot, directory);
    if (await realpath(filename) !== filename) throw error("a directory changed while capturing.");
    const handle = await opendir(filename);
    for await (const entry of handle) {
      if (++entries > MAX_ENTRIES) throw error("workspace enumeration exceeds 2,000 entries.");
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const segments = parts(path); if (segments && permittedDirectories(segments)) await scan(path);
      } else if (entry.isFile() && eligibleWorkspacePath(path)) {
        if (files.length >= MAX_WORKSPACE_FILES) throw error("workspace contains more than 40 eligible files.");
        const buffer = overrides.get(path);
        files.push({ path, language: buffer?.language ?? languages[path.split(".").at(-1)!.toLowerCase()]!, text: await read(path), documentVersion: buffer?.documentVersion ?? 1 });
        validateWorkspace({ files });
      }
    }
  }
  await scan("");
  // Filesystem capture spans a bounded interval, not an atomic filesystem snapshot.
  // Recheck every observed file after the scan to detect concurrent disk edits.
  for (const [path, before] of observed) {
    const filename = join(canonicalRoot, path);
    const after = await lstat(filename);
    if (!after.isFile() || after.isSymbolicLink() || !same(before, after) || await realpath(filename) !== filename) throw error("a file changed while capturing. Send again when edits have finished.");
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const result = { files }; validateWorkspace(result); return result;
}
