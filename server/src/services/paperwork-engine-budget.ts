// [파일 목적] resident paperwork-engine `budget.*` typed RPC client — Rust
//   crates/paperwork-engine/src/budget.rs·engine-budget/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, budget 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const BUDGET_SCOPE_TYPES = ["company", "agent", "project"] as const;
export const BUDGET_WINDOW_KINDS = ["calendar_month_utc", "lifetime"] as const;
export const BUDGET_THRESHOLD_TYPES = ["soft", "hard"] as const;
export const BUDGET_INCIDENT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];
export type BudgetThresholdType = (typeof BUDGET_THRESHOLD_TYPES)[number];
export type BudgetIncidentStatus = (typeof BUDGET_INCIDENT_STATUSES)[number];

export interface BudgetEvaluateThresholdParams { limit_cents: number; observed_cents: number; warn_percent: number; hard_stop_enabled: boolean }
export interface BudgetEvaluateThresholdResult { threshold: BudgetThresholdType | null }
export interface BudgetUtcMonthWindowParams { now: string | Date }
export interface BudgetUtcMonthWindowResult { window_start: string; window_end: string }
export interface BudgetRecordCostEventParams {
  company_id: string; agent_id: string; provider: string; model: string; occurred_at: string | Date;
  issue_id?: string | null; project_id?: string | null; goal_id?: string | null;
  heartbeat_run_id?: string | null; billing_code?: string | null; biller?: string | null;
  billing_type?: string | null; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_cents: number;
}
export interface BudgetCostEvent {
  id: string; company_id: string; agent_id: string; issue_id: string | null;
  project_id: string | null; goal_id: string | null; heartbeat_run_id: string | null;
  billing_code: string | null; provider: string; biller: string; billing_type: string; model: string;
  input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_cents: number;
  occurred_at: string; created_at: string;
}
export type BudgetRecordCostEventResult = { recorded: true; event: BudgetCostEvent } | { recorded: false };
export interface BudgetScopeParams { company_id: string; scope_type: BudgetScopeType; scope_id: string }
export interface BudgetSumScopeSpendParams extends BudgetScopeParams { window_start: string | Date; window_end: string | Date }
export interface BudgetSumScopeSpendResult { observed_cents: number }
export interface BudgetPolicy {
  id: string; company_id: string; scope_type: BudgetScopeType; scope_id: string;
  metric: string; window_kind: BudgetWindowKind; amount: number; warn_percent: number;
  hard_stop_enabled: boolean; notify_enabled: boolean; is_active: boolean; created_by_user_id: string | null;
  updated_by_user_id: string | null; created_at: string; updated_at: string;
}
export interface BudgetIncident {
  id: string; company_id: string; policy_id: string; scope_type: BudgetScopeType; scope_id: string;
  metric: string; window_kind: BudgetWindowKind; window_start: string; window_end: string;
  threshold_type: BudgetThresholdType; amount_limit: number; amount_observed: number;
  status: BudgetIncidentStatus; approval_id: string | null; resolved_at: string | null; created_at: string; updated_at: string;
}
export interface BudgetUpsertIncidentFencedParams extends BudgetScopeParams {
  policy_id: string; metric: string; window_kind: BudgetWindowKind; threshold_type: BudgetThresholdType;
  window_start: string | Date; window_end: string | Date; amount_limit: number; amount_observed: number;
  approval_id?: string | null;
}
export type BudgetUpsertIncidentFencedResult = { upserted: true; incident: BudgetIncident } | { upserted: false };
export interface BudgetResolveIncidentFencedParams { incident_id: string; company_id: string; target_status: BudgetIncidentStatus }
export type BudgetResolveIncidentFencedResult = { resolved: true; incident: BudgetIncident } | { resolved: false };

// budget.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type BudgetRpcErrorKind = HeartbeatRpcErrorKind;
export type BudgetCommitOutcome = HeartbeatCommitOutcome;
export type BudgetRpcErrorClassification = HeartbeatRpcErrorClassification;

const SCOPE_SET: ReadonlySet<string> = new Set(BUDGET_SCOPE_TYPES);
const WINDOW_SET: ReadonlySet<string> = new Set(BUDGET_WINDOW_KINDS);
const THRESHOLD_SET: ReadonlySet<string> = new Set(BUDGET_THRESHOLD_TYPES);
const INCIDENT_SET: ReadonlySet<string> = new Set(BUDGET_INCIDENT_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isUuidOrNull = (v: unknown): v is string | null => v === null || isUuid(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isEnum = <S extends string>(set: ReadonlySet<string>, v: unknown): v is S => isStr(v) && set.has(v);
const isScopeType = (v: unknown): v is BudgetScopeType => isEnum(SCOPE_SET, v);
const isWindowKind = (v: unknown): v is BudgetWindowKind => isEnum(WINDOW_SET, v);
const isThresholdType = (v: unknown): v is BudgetThresholdType => isEnum(THRESHOLD_SET, v);
const isIncidentStatus = (v: unknown): v is BudgetIncidentStatus => isEnum(INCIDENT_SET, v);
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
// budget.rs compares chrono DateTimes at ns precision; Date.parse truncates the
// fraction to ms, so digits 4-9 are re-added.
const tsNanos = (ts: string): bigint =>
  BigInt(Date.parse(ts)) * 1_000_000n + BigInt((/\.(\d+)/.exec(ts)?.[1] ?? "").slice(3, 9).padEnd(6, "0") || "0");

const proto = (msg: string) => new PaperworkEngineError("protocol_error", msg);
const checkTs = (v: unknown, name: string): string => {
  // Date inputs re-validate through isTs so ±YYYYYY instants Chrono cannot parse.
  if (v instanceof Date && !Number.isNaN(v.getTime()) && isTs(v.toISOString())) return v.toISOString();
  if (isTs(v)) return v;
  throw new RangeError(`${name} must be a valid Date or RFC3339 timestamp`);
};
const make = <T>(guard: (v: unknown) => v is T, msg: string) => (v: unknown, name: string): T => {
  if (!guard(v)) throw new RangeError(`${name} must be ${msg}`); return v;
};
const checkUuid = make(isUuid, "a UUID string");
const checkStr = make(isStr, "a string");
const checkScopeType = make(isScopeType, "a valid budget scope type");
const checkWindowKind = make(isWindowKind, "a valid budget window kind");
const checkThresholdType = make(isThresholdType, "a valid budget threshold type");
const checkIncidentStatus = make(isIncidentStatus, "a valid budget incident status");
const checkI64 = make((v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v), "a 64-bit safe integer");
const checkI32 = make(isI32, "a 32-bit signed integer");
// budget.rs gates write-side cents through cents(): i64 -> i32, non-negative.
const checkCents = make((v: unknown): v is number => isI32(v) && v >= 0, "a non-negative 32-bit integer cents");
// serde Option<T>: undefined keeps the key off the wire, null -> None.
const checkOptUuid = (v: unknown, n: string) => (v === undefined || v === null ? v : checkUuid(v, n));
const checkOptStr = (v: unknown, n: string) => (v === undefined || v === null ? v : checkStr(v, n));
const checkScopeParams = (params: BudgetScopeParams) => ({
  company_id: checkUuid(params.company_id, "company_id"),
  scope_type: checkScopeType(params.scope_type, "scope_type"),
  scope_id: checkUuid(params.scope_id, "scope_id"),
});
const checkWindow = (start: string, end: string): void => {
  if (tsNanos(end) <= tsNanos(start)) throw new RangeError("invalid window: window_end must be after window_start");
};

/** Classifies a rejected budget.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyBudgetRpcError = (error: unknown): BudgetRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const COST_EVENT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["agent_id", isUuid], ["issue_id", isUuidOrNull],
  ["project_id", isUuidOrNull], ["goal_id", isUuidOrNull], ["heartbeat_run_id", isUuidOrNull],
  ["billing_code", isStrOrNull], ["provider", isStr], ["biller", isStr], ["billing_type", isStr],
  ["model", isStr], ["input_tokens", isI32], ["cached_input_tokens", isI32], ["output_tokens", isI32],
  ["cost_cents", isI32], ["occurred_at", isTs], ["created_at", isTs],
] as const;
const POLICY_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["scope_type", isScopeType], ["scope_id", isUuid],
  ["metric", isStr], ["window_kind", isWindowKind], ["amount", isI32], ["warn_percent", isI32],
  ["hard_stop_enabled", isBool], ["notify_enabled", isBool], ["is_active", isBool],
  ["created_by_user_id", isStrOrNull], ["updated_by_user_id", isStrOrNull],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const INCIDENT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["policy_id", isUuid], ["scope_type", isScopeType],
  ["scope_id", isUuid], ["metric", isStr], ["window_kind", isWindowKind], ["status", isIncidentStatus],
  ["window_start", isTs], ["window_end", isTs], ["threshold_type", isThresholdType],
  ["amount_limit", isI32], ["amount_observed", isI32], ["created_at", isTs], ["updated_at", isTs],
  ["approval_id", isUuidOrNull], ["resolved_at", isTsOrNull],
] as const;
const toCostEvent = (v: unknown): BudgetCostEvent => row(v, COST_EVENT_ROW, "budget.record_cost_event event");
const toPolicy = (v: unknown): BudgetPolicy => row(v, POLICY_ROW, "budget.list_active_policies policy");
const toIncident = (v: unknown): BudgetIncident => row(v, INCIDENT_ROW, "budget incident");
const checkFlag = (v: unknown, method: string, flag: string): Record<string, unknown> => {
  if (!isRec(v) || typeof v[flag] !== "boolean" || !hasExactKeys(v, v[flag] ? [flag, "incident"] : [flag]))
    throw proto(`bad ${method} result shape`);
  return v;
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function evaluateBudgetThreshold(
  client: PaperworkEngineClient, params: BudgetEvaluateThresholdParams, callOpts?: CallOpts,
): Promise<BudgetEvaluateThresholdResult> {
  const hardStop = params.hard_stop_enabled;
  if (!isBool(hardStop)) throw new RangeError("hard_stop_enabled must be a boolean");
  const result = await client.call<unknown>("budget.evaluate_threshold", {
    limit_cents: checkI64(params.limit_cents, "limit_cents"),
    observed_cents: checkI64(params.observed_cents, "observed_cents"),
    warn_percent: checkI32(params.warn_percent, "warn_percent"), hard_stop_enabled: hardStop,
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["threshold"])
    || !(result.threshold === null || isThresholdType(result.threshold))) {
    throw proto("bad budget.evaluate_threshold result shape");
  }
  return { threshold: result.threshold };
}

export async function utcBudgetMonthWindow(
  client: PaperworkEngineClient, params: BudgetUtcMonthWindowParams, callOpts?: CallOpts,
): Promise<BudgetUtcMonthWindowResult> {
  const result = await client.call<unknown>("budget.utc_month_window", { now: checkTs(params.now, "now") }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["window_start", "window_end"])
    || !isTs(result.window_start) || !isTs(result.window_end)) {
    throw proto("bad budget.utc_month_window result shape");
  }
  return { window_start: result.window_start, window_end: result.window_end };
}

export async function recordBudgetCostEvent(
  client: PaperworkEngineClient, params: BudgetRecordCostEventParams, callOpts?: CallOpts,
): Promise<BudgetRecordCostEventResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"), agent_id: checkUuid(params.agent_id, "agent_id"),
    provider: checkStr(params.provider, "provider"), model: checkStr(params.model, "model"),
    input_tokens: checkI32(params.input_tokens, "input_tokens"),
    cached_input_tokens: checkI32(params.cached_input_tokens, "cached_input_tokens"),
    output_tokens: checkI32(params.output_tokens, "output_tokens"),
    cost_cents: checkCents(params.cost_cents, "cost_cents"), occurred_at: checkTs(params.occurred_at, "occurred_at"),
  };
  for (const [name, check] of [
    ["issue_id", checkOptUuid], ["project_id", checkOptUuid], ["goal_id", checkOptUuid],
    ["heartbeat_run_id", checkOptUuid], ["billing_code", checkOptStr],
    ["biller", checkOptStr], ["billing_type", checkOptStr],
  ] as const) {
    const v = check(params[name], name);
    if (v !== undefined) wire[name] = v;
  }
  const result = await client.call<unknown>("budget.record_cost_event", wire, callOpts);
  if (!isRec(result) || typeof result.recorded !== "boolean"
    || !hasExactKeys(result, result.recorded ? ["recorded", "event"] : ["recorded"])) {
    throw proto("bad budget.record_cost_event result shape");
  }
  return result.recorded ? { recorded: true, event: toCostEvent(result.event) } : { recorded: false };
}

export async function sumBudgetScopeSpend(
  client: PaperworkEngineClient, params: BudgetSumScopeSpendParams, callOpts?: CallOpts,
): Promise<BudgetSumScopeSpendResult> {
  const scope = checkScopeParams(params);
  const start = checkTs(params.window_start, "window_start");
  const end = checkTs(params.window_end, "window_end");
  // budget.rs gates only sum_scope_spend for company-scope symmetry.
  if (scope.scope_type === "company" && scope.scope_id !== scope.company_id) {
    throw new RangeError("scope_id must equal company_id for company scope");
  }
  checkWindow(start, end);
  const result = await client.call<unknown>("budget.sum_scope_spend",
    { ...scope, window_start: start, window_end: end }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["observed_cents"]) || !Number.isSafeInteger(result.observed_cents)) {
    throw proto("bad budget.sum_scope_spend result shape");
  }
  return { observed_cents: result.observed_cents as number };
}

export async function listActiveBudgetPolicies(
  client: PaperworkEngineClient, params: BudgetScopeParams, callOpts?: CallOpts,
): Promise<BudgetPolicy[]> {
  const result = await client.call<unknown>("budget.list_active_policies", checkScopeParams(params), callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["policies"]) || !Array.isArray(result.policies)) {
    throw proto("bad budget.list_active_policies result shape");
  }
  return result.policies.map(toPolicy);
}

export async function upsertBudgetIncidentFenced(
  client: PaperworkEngineClient, params: BudgetUpsertIncidentFencedParams, callOpts?: CallOpts,
): Promise<BudgetUpsertIncidentFencedResult> {
  const start = checkTs(params.window_start, "window_start");
  const end = checkTs(params.window_end, "window_end");
  const wire: Record<string, unknown> = {
    ...checkScopeParams(params), policy_id: checkUuid(params.policy_id, "policy_id"),
    metric: checkStr(params.metric, "metric"),
    window_kind: checkWindowKind(params.window_kind, "window_kind"), window_start: start, window_end: end,
    threshold_type: checkThresholdType(params.threshold_type, "threshold_type"),
    amount_limit: checkCents(params.amount_limit, "amount_limit"),
    amount_observed: checkCents(params.amount_observed, "amount_observed"),
  };
  const approval = checkOptUuid(params.approval_id, "approval_id");
  if (approval !== undefined) wire.approval_id = approval;
  checkWindow(start, end);
  const o = checkFlag(await client.call<unknown>("budget.upsert_incident_fenced", wire, callOpts),
    "budget.upsert_incident_fenced", "upserted");
  return o.upserted ? { upserted: true, incident: toIncident(o.incident) } : { upserted: false };
}

export async function resolveBudgetIncidentFenced(
  client: PaperworkEngineClient, params: BudgetResolveIncidentFencedParams, callOpts?: CallOpts,
): Promise<BudgetResolveIncidentFencedResult> {
  const target = checkIncidentStatus(params.target_status, "target_status");
  // engine-budget validate_incident_transition: open -> resolved|dismissed only.
  if (target === "open") throw new RangeError("illegal incident status transition: open -> open");
  const o = checkFlag(await client.call<unknown>("budget.resolve_incident_fenced", {
    incident_id: checkUuid(params.incident_id, "incident_id"),
    company_id: checkUuid(params.company_id, "company_id"), target_status: target,
  }, callOpts), "budget.resolve_incident_fenced", "resolved");
  return o.resolved ? { resolved: true, incident: toIncident(o.incident) } : { resolved: false };
}
