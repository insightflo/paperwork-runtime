// [파일 목적] resident paperwork-engine `company.*` typed RPC client — Rust
//   crates/paperwork-engine/src/company.rs·engine-company/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, Wave 5 company 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import { classifyHeartbeatRpcError } from "./paperwork-engine-heartbeat.js";

export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export const COMPANY_KINDS = ["business", "maintenance"] as const;
export const COMPANY_DEFAULT_LANGUAGES = ["en", "ko"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
export type CompanyKind = (typeof COMPANY_KINDS)[number];
export type CompanyDefaultLanguage = (typeof COMPANY_DEFAULT_LANGUAGES)[number];

export interface EngineCompany {
  id: string; name: string; description: string | null; status: CompanyStatus;
  pause_reason: string | null; paused_at: string | null; issue_prefix: string; issue_counter: number;
  budget_monthly_cents: number; spent_monthly_cents: number; require_board_approval_for_new_agents: boolean;
  timezone: string | null; work_product_root: string | null; default_language: CompanyDefaultLanguage;
  brand_color: string | null; company_kind: CompanyKind; allows_code_modify: boolean;
  created_at: string; updated_at: string;
}
export interface CompanyListParams { limit?: number }
export interface CompanyGetByIdParams { company_id: string }
export interface CompanyGetByPrefixParams { issue_prefix: string }
export interface CompanyCreateParams {
  name: string; description: string | null; issue_prefix: string;
  budget_monthly_cents: number; spent_monthly_cents: number;
  require_board_approval_for_new_agents: boolean; timezone: string | null;
  work_product_root: string | null; default_language: CompanyDefaultLanguage;
  brand_color: string | null; company_kind: CompanyKind; allows_code_modify: boolean;
}
export interface CompanyUpdateParams {
  company_id: string; name?: string | null; description?: string | null; status?: CompanyStatus | null;
  timezone?: string | null; work_product_root?: string | null; default_language?: CompanyDefaultLanguage | null;
  brand_color?: string | null; budget_monthly_cents?: number | null; spent_monthly_cents?: number | null;
  require_board_approval_for_new_agents?: boolean | null; allows_code_modify?: boolean | null;
}
export interface CompanyPauseParams { company_id: string; pause_reason?: string | null }
export interface CompanyResumeParams { company_id: string }
export interface CompanyNextCounterParams { company_id: string }
export interface CompanyListResult { companies: EngineCompany[] }
export interface CompanyGetResult { company: EngineCompany | null }
export interface CompanyCreateResult { company: EngineCompany }
export interface CompanyUpdateResult { company: EngineCompany | null }
export type CompanyPauseResult = { paused: true; company: EngineCompany } | { paused: false; company: null };
export type CompanyResumeResult = { resumed: true; company: EngineCompany } | { resumed: false; company: null };
export interface CompanyNextCounterResult {
  company: { issue_prefix: string; issue_counter: number } | null;
}

// company.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export const classifyCompanyRpcError = classifyHeartbeatRpcError;

const STATUS_SET: ReadonlySet<string> = new Set(COMPANY_STATUSES);
const KIND_SET: ReadonlySet<string> = new Set(COMPANY_KINDS);
const LANGUAGE_SET: ReadonlySet<string> = new Set(COMPANY_DEFAULT_LANGUAGES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isEnum = <S extends string>(set: ReadonlySet<string>, v: unknown): v is S => isStr(v) && set.has(v);
const isStatus = (v: unknown): v is CompanyStatus => isEnum(STATUS_SET, v);
const isKind = (v: unknown): v is CompanyKind => isEnum(KIND_SET, v);
const isLanguage = (v: unknown): v is CompanyDefaultLanguage => isEnum(LANGUAGE_SET, v);
// Date.parse normalizes impossible calendar dates and hour 24; Chrono rejects both.
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
const make = <T>(guard: (v: unknown) => v is T, msg: string) => (v: unknown, name: string): T => {
  if (!guard(v)) throw new RangeError(`${name} must be ${msg}`); return v;
};
const checkUuid = make(isUuid, "a UUID string");
const checkStr = make(isStr, "a string");
const checkBool = make(isBool, "a boolean");
const checkStatus = make(isStatus, "a valid company status");
const checkKind = make(isKind, "a valid company kind");
const checkLanguage = make(isLanguage, "a valid company default language");
const checkI64 = make((v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v), "a 64-bit safe integer");
const checkCents = make((v: unknown): v is number => isI32(v) && v >= 0, "a non-negative 32-bit integer cents");
const checkNullableStr = (v: unknown, name: string): string | null => {
  if (!isStrOrNull(v)) throw new RangeError(`${name} must be a string or null`);
  return v;
};
const checkOpt = <T>(v: unknown, name: string, check: (v: unknown, name: string) => T): T | null | undefined =>
  v === undefined || v === null ? v : check(v, name);
const checkName = (v: unknown, name = "name"): string => {
  const s = checkStr(v, name);
  if (s.trim() === "") throw new RangeError(`${name} must not be blank`);
  return s;
};
const checkPrefix = (v: unknown): string => {
  const s = checkStr(v, "issue_prefix");
  if (s.trim() === "") throw new RangeError("issue_prefix must not be blank");
  return s;
};

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const COMPANY_ROW = [
  ["id", isUuid], ["name", isStr], ["description", isStrOrNull], ["status", isStatus],
  ["pause_reason", isStrOrNull], ["paused_at", isTsOrNull], ["issue_prefix", isStr], ["issue_counter", isI32],
  ["budget_monthly_cents", isI32], ["spent_monthly_cents", isI32],
  ["require_board_approval_for_new_agents", isBool], ["timezone", isStrOrNull],
  ["work_product_root", isStrOrNull], ["default_language", isLanguage], ["brand_color", isStrOrNull],
  ["company_kind", isKind], ["allows_code_modify", isBool], ["created_at", isTs], ["updated_at", isTs],
] as const;
const toCompany = (v: unknown): EngineCompany => row(v, COMPANY_ROW, "company row");
const toCompanyOrNull = (v: unknown): EngineCompany | null => v === null ? null : toCompany(v);
const exact = (v: unknown, keys: readonly string[], method: string): Record<string, unknown> => {
  if (!isRec(v) || !hasExactKeys(v, keys)) throw proto(`bad ${method} result shape`);
  return v;
};
type FlagResult<F extends "paused" | "resumed"> = F extends "paused" ? CompanyPauseResult : CompanyResumeResult;
const toFlagResult = <F extends "paused" | "resumed">(v: unknown, method: string, flag: F): FlagResult<F> => {
  const o = exact(v, [flag, "company"], method);
  if (typeof o[flag] !== "boolean") throw proto(`bad ${method} result shape`);
  const company = toCompanyOrNull(o.company);
  if ((o[flag] === true) !== (company !== null)) throw proto(`bad ${method} result shape`);
  return (o[flag] === true
    ? { [flag]: true, company: company! }
    : { [flag]: false, company: null }) as FlagResult<F>;
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function listCompanies(
  client: PaperworkEngineClient, params: CompanyListParams, callOpts?: CallOpts,
): Promise<CompanyListResult> {
  const wire: Record<string, unknown> = {};
  const limit = params.limit;
  if (limit !== undefined) wire.limit = checkI64(limit, "limit");
  const result = await client.call<unknown>("company.list", wire, callOpts);
  const o = exact(result, ["companies"], "company.list");
  if (!Array.isArray(o.companies)) throw proto("bad company.list result shape");
  return { companies: o.companies.map(toCompany) };
}

export async function getCompanyById(
  client: PaperworkEngineClient, params: CompanyGetByIdParams, callOpts?: CallOpts,
): Promise<CompanyGetResult> {
  const result = await client.call<unknown>("company.get_by_id", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  const o = exact(result, ["company"], "company.get_by_id");
  return { company: toCompanyOrNull(o.company) };
}

export async function getCompanyByIssuePrefix(
  client: PaperworkEngineClient, params: CompanyGetByPrefixParams, callOpts?: CallOpts,
): Promise<CompanyGetResult> {
  const result = await client.call<unknown>("company.get_by_issue_prefix", {
    issue_prefix: checkPrefix(params.issue_prefix),
  }, callOpts);
  const o = exact(result, ["company"], "company.get_by_issue_prefix");
  return { company: toCompanyOrNull(o.company) };
}

export async function createCompany(
  client: PaperworkEngineClient, params: CompanyCreateParams, callOpts?: CallOpts,
): Promise<CompanyCreateResult> {
  const wire = {
    name: checkName(params.name), description: checkNullableStr(params.description, "description"),
    issue_prefix: checkPrefix(params.issue_prefix),
    budget_monthly_cents: checkCents(params.budget_monthly_cents, "budget_monthly_cents"),
    spent_monthly_cents: checkCents(params.spent_monthly_cents, "spent_monthly_cents"),
    require_board_approval_for_new_agents: checkBool(
      params.require_board_approval_for_new_agents, "require_board_approval_for_new_agents"),
    timezone: checkNullableStr(params.timezone, "timezone"),
    work_product_root: checkNullableStr(params.work_product_root, "work_product_root"),
    default_language: checkLanguage(params.default_language, "default_language"),
    brand_color: checkNullableStr(params.brand_color, "brand_color"),
    company_kind: checkKind(params.company_kind, "company_kind"),
    allows_code_modify: checkBool(params.allows_code_modify, "allows_code_modify"),
  };
  const result = await client.call<unknown>("company.create", wire, callOpts);
  const o = exact(result, ["company"], "company.create");
  return { company: toCompany(o.company) };
}

export async function updateCompany(
  client: PaperworkEngineClient, params: CompanyUpdateParams, callOpts?: CallOpts,
): Promise<CompanyUpdateResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  const optional: readonly (readonly [string, unknown, (v: unknown, n: string) => unknown])[] = [
    ["name", params.name, (v, n) => checkName(v, n)], ["description", params.description, checkNullableStr],
    ["status", params.status, checkStatus], ["timezone", params.timezone, checkNullableStr],
    ["work_product_root", params.work_product_root, checkNullableStr],
    ["default_language", params.default_language, checkLanguage], ["brand_color", params.brand_color, checkNullableStr],
    ["budget_monthly_cents", params.budget_monthly_cents, checkCents],
    ["spent_monthly_cents", params.spent_monthly_cents, checkCents],
    ["require_board_approval_for_new_agents", params.require_board_approval_for_new_agents, checkBool],
    ["allows_code_modify", params.allows_code_modify, checkBool],
  ];
  for (const [name, value, check] of optional) {
    const checked = checkOpt(value, name, check);
    if (checked !== undefined) wire[name] = checked;
  }
  const result = await client.call<unknown>("company.update", wire, callOpts);
  const o = exact(result, ["company"], "company.update");
  return { company: toCompanyOrNull(o.company) };
}

export async function pauseCompany(
  client: PaperworkEngineClient, params: CompanyPauseParams, callOpts?: CallOpts,
): Promise<CompanyPauseResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  const reason = checkOpt(params.pause_reason, "pause_reason", checkNullableStr);
  if (reason !== undefined) wire.pause_reason = reason;
  const result = await client.call<unknown>("company.pause", wire, callOpts);
  return toFlagResult(result, "company.pause", "paused");
}

export async function resumeCompany(
  client: PaperworkEngineClient, params: CompanyResumeParams, callOpts?: CallOpts,
): Promise<CompanyResumeResult> {
  const result = await client.call<unknown>("company.resume", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  return toFlagResult(result, "company.resume", "resumed");
}

export async function nextCompanyIssueCounter(
  client: PaperworkEngineClient, params: CompanyNextCounterParams, callOpts?: CallOpts,
): Promise<CompanyNextCounterResult> {
  const result = await client.call<unknown>("company.next_issue_counter", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  const o = exact(result, ["company"], "company.next_issue_counter");
  if (o.company === null) return { company: null };
  if (!isRec(o.company) || !hasExactKeys(o.company, ["issue_prefix", "issue_counter"])
    || !isStr(o.company.issue_prefix) || !isI32(o.company.issue_counter)) {
    throw proto("bad company.next_issue_counter result shape");
  }
  return { company: { issue_prefix: o.company.issue_prefix, issue_counter: o.company.issue_counter } };
}
