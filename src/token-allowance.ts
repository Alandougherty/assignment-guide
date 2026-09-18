import type { AssignmentRef } from "./domain";

export type TokenAllowance = {
  schema: 1; assignment: AssignmentRef; epoch: { id: string; startedAt: string };
  revision: number; limit: number; used: number; remaining: number | null;
  usageComplete: boolean; mode: "reporting"; updatedAt: string;
};
const exact = (v: unknown, keys: string): v is Record<string, unknown> => !!v && typeof v === "object" &&
  !Array.isArray(v) && Object.keys(v).sort().join() === keys;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
export function validateTokenAllowance(value: unknown, assignment: AssignmentRef): TokenAllowance {
  if (!exact(value, "assignment,epoch,limit,mode,remaining,revision,schema,updatedAt,usageComplete,used") ||
      value.schema !== 1 || value.mode !== "reporting" || !exact(value.assignment, "id,version") ||
      value.assignment.id !== assignment.id || value.assignment.version !== assignment.version ||
      !exact(value.epoch, "id,startedAt") || typeof value.epoch.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.epoch.id) ||
      !timestamp(value.epoch.startedAt) || !timestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.epoch.startedAt) ||
      !count(value.revision) || value.revision < 1 || !count(value.limit) || !count(value.used) ||
      typeof value.usageComplete !== "boolean" || (value.usageComplete
        ? !count(value.remaining) || value.remaining !== Math.max(0, value.limit - value.used)
        : value.remaining !== null)) throw new Error("Invalid assignment token allowance.");
  return structuredClone(value) as TokenAllowance;
}
export function tokenAllowanceLabel(value: TokenAllowance | undefined, stale: boolean): string {
  if (!value) return "";
  const balance = value.usageComplete ? `${value.remaining!.toLocaleString("en-GB")} tokens remaining` : "Token balance unavailable";
  return `${stale ? "Last known: " : ""}${balance}`;
}
export function tokenAllowanceDetails(value: TokenAllowance | undefined): string {
  if (!value) return "";
  return `Trial since ${value.epoch.startedAt.slice(0, 19).replace("T", " ")} UTC. Reporting only; this allowance is not enforced. Earlier usage is excluded.${value.usageComplete ? "" : " Some usage is unknown."}`;
}
