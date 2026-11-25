// [파일 목적] resident paperwork-engine `wiki.*` typed RPC client — Rust
//   crates/paperwork-engine/src/wiki.rs·engine-wiki/{lib,queries}.rs 와
//   필드명·결과 union·사전 검증을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임. Wave 5 전까지 호출부 없음.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import { classifyHeartbeatRpcError } from "./paperwork-engine-heartbeat.js";

export const WIKI_STATUSES = ["active", "resolved", "closed"] as const;
export const WIKI_AUDIENCES = ["agent", "ops"] as const;
export type WikiStatus = (typeof WIKI_STATUSES)[number];
export type WikiAudience = (typeof WIKI_AUDIENCES)[number];

export interface WikiEntryRow {
  id: string; company_id: string; agent_id: string; mission_id: string | null;
  pattern: string; cause: string; solution: string; error_code: string | null; step_id: string | null;
  frequency: number; status: WikiStatus; audience: WikiAudience;
  last_seen_at: string; resolved_at: string | null; created_at: string; updated_at: string;
}
export interface WikiRecordFailureParams {
  company_id: string; agent_id: string; mission_id?: string | null;
  pattern: string; cause: string; solution: string; error_code: string;
  step_id?: string | null; audience?: WikiAudience | null;
}
export interface WikiSearchRelevantParams {
  company_id: string; agent_id: string; now: string | Date; step_id?: string | null; limit?: number;
}
export interface WikiListParams { company_id: string; limit?: number }
export interface WikiEntryIdParams { entry_id: string; company_id: string }
export type WikiRecordFailureResult = { recorded: true; entry: WikiEntryRow } | { recorded: false };
export interface WikiSearchRelevantResult { entries: WikiEntryRow[] }
export interface WikiListResult { entries: WikiEntryRow[] }
export type WikiMarkResolvedResult = { resolved: true; entry: WikiEntryRow } | { resolved: false };
export type WikiCloseResult = { closed: true; entry: WikiEntryRow } | { closed: false };

const STATUS_SET: ReadonlySet<string> = new Set(WIKI_STATUSES);
const AUDIENCE_SET: ReadonlySet<string> = new Set(WIKI_AUDIENCES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isUuidOrNull = (v: unknown): v is string | null => v === null || isUuid(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isStatus = (v: unknown): v is WikiStatus => isStr(v) && STATUS_SET.has(v);
const isAudience = (v: unknown): v is WikiAudience => isStr(v) && AUDIENCE_SET.has(v);
// Date.parse normalizes hour 24 and out-of-range fields Chrono rejects; the
// regex pins unsigned 2-digit fields, so only upper bounds need checking.
const isTs = (v: unknown): v is string => {
  if (!isStr(v) || !RFC3339_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [hh, mm, ss] = v.slice(11, 19).split(":").map(Number);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  if (!v.endsWith("Z") && (Number(v.slice(-5, -3)) > 23 || Number(v.slice(-2)) > 59)) return false;
  const [y, mo, d] = v.slice(0, 10).split("-").map(Number);
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
  return dt.toISOString().slice(0, 10) === v.slice(0, 10);
};
const isTsOrNull = (v: unknown): v is string | null => v === null || isTs(v);

const proto = (msg: string) => new PaperworkEngineError("protocol_error", msg);
const checkTs = (v: unknown, name: string): string => {
  // Date inputs re-validate through isTs so ±YYYYYY instants Chrono cannot parse.
  if (v instanceof Date && !Number.isNaN(v.getTime()) && isTs(v.toISOString())) return v.toISOString();
  if (isTs(v)) return v;
  throw new RangeError(`${name} must be a valid Date or RFC3339 timestamp`);
};
const checkUuid = (v: unknown, name: string): string => {
  if (!isUuid(v)) throw new RangeError(`${name} must be a UUID string`);
  return v;
};
const checkOptUuid = (v: unknown, name: string): string | null | undefined => {
  if (v === undefined || v === null) return v;
  return checkUuid(v, name);
};
const checkOptStr = (v: unknown, name: string): string | null | undefined => {
  if (v === undefined || v === null) return v;
  if (!isStr(v)) throw new RangeError(`${name} must be a string`);
  return v;
};
const checkOptAudience = (v: unknown): WikiAudience | null | undefined => {
  if (v === undefined || v === null) return v;
  if (!isAudience(v)) throw new RangeError("audience must be a valid wiki audience");
  return v;
};
const checkNonBlank = (v: unknown, name: string): string => {
  if (!isStr(v) || v.trim() === "") throw new RangeError(`${name} must be a non-empty string`);
  return v;
};
const checkLimit = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new RangeError(`${name} must be an integer >= 1`);
  }
  return v;
};

/** Classifies a rejected wiki.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyWikiRpcError = classifyHeartbeatRpcError;

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const ENTRY_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["agent_id", isUuid], ["mission_id", isUuidOrNull],
  ["pattern", isStr], ["cause", isStr], ["solution", isStr], ["error_code", isStrOrNull],
  ["step_id", isStrOrNull], ["frequency", isI32], ["status", isStatus], ["audience", isAudience],
  ["last_seen_at", isTs], ["resolved_at", isTsOrNull], ["created_at", isTs], ["updated_at", isTs],
] as const;
const toWikiEntry = (v: unknown): WikiEntryRow => row(v, ENTRY_ROW, "wiki entry");
const entriesResult = (v: unknown, method: string): { entries: WikiEntryRow[] } => {
  if (!isRec(v) || !hasExactKeys(v, ["entries"]) || !Array.isArray(v.entries)) {
    throw proto(`bad ${method} result shape`);
  }
  return { entries: v.entries.map(toWikiEntry) };
};
type FlagResult<F extends string> = ({ [K in F]: true } & { entry: WikiEntryRow }) | { [K in F]: false };
const flagResult = <F extends string>(v: unknown, method: string, flag: F): FlagResult<F> => {
  if (!isRec(v) || typeof v[flag] !== "boolean" || !hasExactKeys(v, v[flag] ? [flag, "entry"] : [flag])) {
    throw proto(`bad ${method} result shape`);
  }
  return (v[flag] ? { [flag]: true, entry: toWikiEntry(v.entry) } : { [flag]: false }) as FlagResult<F>;
};

type CallOpts = { timeoutMs?: number };

export async function recordWikiFailure(
  client: PaperworkEngineClient, params: WikiRecordFailureParams, callOpts?: CallOpts,
): Promise<WikiRecordFailureResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"), agent_id: checkUuid(params.agent_id, "agent_id"),
    pattern: checkNonBlank(params.pattern, "pattern"), cause: checkNonBlank(params.cause, "cause"),
    solution: checkNonBlank(params.solution, "solution"), error_code: checkNonBlank(params.error_code, "error_code"),
  };
  const missionId = checkOptUuid(params.mission_id, "mission_id");
  if (missionId !== undefined) wire.mission_id = missionId;
  const stepId = checkOptStr(params.step_id, "step_id");
  if (stepId !== undefined) wire.step_id = stepId;
  const audience = checkOptAudience(params.audience);
  if (audience !== undefined) wire.audience = audience;
  const o = flagResult(await client.call<unknown>("wiki.record_failure", wire, callOpts),
    "wiki.record_failure", "recorded");
  return o.recorded ? { recorded: true, entry: o.entry } : { recorded: false };
}

export async function searchRelevantWiki(
  client: PaperworkEngineClient, params: WikiSearchRelevantParams, callOpts?: CallOpts,
): Promise<WikiSearchRelevantResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"), agent_id: checkUuid(params.agent_id, "agent_id"),
    now: checkTs(params.now, "now"),
  };
  const stepId = checkOptStr(params.step_id, "step_id");
  if (stepId !== undefined) wire.step_id = stepId;
  const limit = checkLimit(params.limit, "limit");
  if (limit !== undefined) wire.limit = limit;
  return entriesResult(await client.call<unknown>("wiki.search_relevant", wire, callOpts), "wiki.search_relevant");
}

export async function listWikiEntries(
  client: PaperworkEngineClient, params: WikiListParams, callOpts?: CallOpts,
): Promise<WikiListResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  const limit = checkLimit(params.limit, "limit");
  if (limit !== undefined) wire.limit = limit;
  return entriesResult(await client.call<unknown>("wiki.list", wire, callOpts), "wiki.list");
}

export async function markWikiEntryResolved(
  client: PaperworkEngineClient, params: WikiEntryIdParams, callOpts?: CallOpts,
): Promise<WikiMarkResolvedResult> {
  const o = flagResult(await client.call<unknown>("wiki.mark_resolved", {
    entry_id: checkUuid(params.entry_id, "entry_id"), company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts), "wiki.mark_resolved", "resolved");
  return o.resolved ? { resolved: true, entry: o.entry } : { resolved: false };
}

export async function closeWikiEntry(
  client: PaperworkEngineClient, params: WikiEntryIdParams, callOpts?: CallOpts,
): Promise<WikiCloseResult> {
  const o = flagResult(await client.call<unknown>("wiki.close", {
    entry_id: checkUuid(params.entry_id, "entry_id"), company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts), "wiki.close", "closed");
  return o.closed ? { closed: true, entry: o.entry } : { closed: false };
}
