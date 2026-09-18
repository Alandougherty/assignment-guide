import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

export type TutorPreferences = {
  responseLength: "brief" | "standard";
  explanationStyle: "plain" | "technical";
  guidance: "hints-first" | "examples-first";
};
export const DEFAULT_PREFERENCES: Readonly<TutorPreferences> = Object.freeze({
  responseLength: "brief", explanationStyle: "plain", guidance: "hints-first",
});
const choices = {
  responseLength: ["brief", "standard"], explanationStyle: ["plain", "technical"], guidance: ["hints-first", "examples-first"],
} as const;
const invalid = () => new Error("Invalid tutor preferences. Use only the supported preference names and values.");
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Only this bounded enum structure is permitted in recorded snapshots or model requests. */
export function validatePreferences(value: unknown): asserts value is TutorPreferences {
  if (!object(value) || Object.keys(value).length !== 3 ||
      Object.entries(choices).some(([key, allowed]) => !Object.hasOwn(value, key) || !(allowed as readonly unknown[]).includes(value[key]))) throw invalid();
}
/** Read only the first Preferences section. Teacher examples and subsequent sections never enter the request. */
export function parsePreferencesFile(value: unknown): TutorPreferences {
  if (typeof value !== "string") throw invalid();
  const lines = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex(line => /^\s*##[ \t]+Preferences[ \t]*(?:##[ \t]*)?$/i.test(line));
  if (start < 0) throw invalid();
  const result = { ...DEFAULT_PREFERENCES };
  const names: Record<string, keyof TutorPreferences> = {
    "response length": "responseLength", "explanation style": "explanationStyle", guidance: "guidance",
  };
  const seen = new Set<keyof TutorPreferences>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*#{1,6}(?:\s|$)/.test(line) || (line.trim() && /^\s*(?:=+|-+)\s*$/.test(lines[i + 1] ?? ""))) break;
    if (!line.trim()) continue;
    const match = line.match(/^\s*-[ \t]+(Response length|Explanation style|Guidance)[ \t]*:[ \t]*([^ \t]+)[ \t]*$/i);
    if (!match) throw invalid();
    const key = names[match[1]!.toLowerCase()]!;
    if (seen.has(key) || !(choices[key] as readonly string[]).includes(match[2]!)) throw invalid();
    seen.add(key);
    Object.assign(result, { [key]: match[2]! });
  }
  validatePreferences(result);
  return result;
}

/** Read the fixed workspace file only, never AGENTS.md or free-form teacher instructions. */
export async function readPreferences(root: string): Promise<TutorPreferences> {
  try {
    const canonicalRoot = await realpath(root);
    const path = join(canonicalRoot, "TUTOR.md");
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_PREFERENCES }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_000 || relative(canonicalRoot, await realpath(path)) !== "TUTOR.md") throw invalid();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > 16_000) throw invalid();
      const bytes = Buffer.alloc(16_001); let length = 0;
      while (length < bytes.length) {
        const next = await file.read(bytes, length, bytes.length - length, null);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length > 16_000) throw invalid();
      return parsePreferencesFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } finally { await file.close(); }
  } catch {
    throw new Error("Cannot read TUTOR.md. Use a regular Markdown file of at most 16,000 bytes with supported preference values.");
  }
}
