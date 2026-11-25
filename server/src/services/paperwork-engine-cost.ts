// [파일 목적] resident paperwork-engine `cost.*` typed RPC client — Rust
//   crates/paperwork-engine/src/cost.rs·engine-cost/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, cost 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

// engine-cost BillingType: serde snake_case closed set; unknown strings never
// reach the wire (param gate) nor pass response validation (row gate).
export const COST_BILLING_TYPES = [
  "metered_api", "subscription_included", "subscription_overage", "credits", "fixed", "unknown",
] as const;
export type CostBillingType = (typeof COST_BILLING_TYPES)[number];

export interface CostRecordEventParams {
  company_id: string; agent_id: string; provider: string; model: string;
  input_tokens: number; cached_input_tokens: number; output_tokens: number;
  cost_cents: number; occurred_at: string | Date;
  issue_id?: string | null; project_id?: string | null; goal_id?: string | null;
  heartbeat_run_id?: string | null; billing_code?: string | null;
  biller?: string | null; billing_type?: CostBillingType | null;
}
export interface CostEvent {
  id: string; company_id: string; agent_id: string;
  issue_id: string | null; project_id: string | null; goal_id: string | null;
  heartbeat_run_id: string | null; billing_code: string | null;
  provider: string; biller: string; billing_type: CostBillingType; model: string;
  input_tokens: number; cached_input_tokens: number; output_tokens: number;
  cost_cents: number; occurred_at: string; created_at: string;
}
export type CostRecordEventResult = { recorded: true; event: CostEvent } | { recorded: false };
export interface CostListEventsParams {
  company_id: string; agent_id?: string | null;
  from?: string | Date | null; to?: string | Date | null; limit?: number;
}
export interface CostListEventsResult { events: CostEvent[] }
export interface CostSummarizeWindowParams {
  company_id: string; from?: string | Date | null; to?: string | Date | null;
}
export interface CostSummarizeWindowResult { spend_cents: number }
export interface CostSpendSnapshotParams { company_id: string }
export type CostSpendSnapshotResult =
  | { found: true; company_id: string; budget_monthly_cents: number; spent_monthly_cents: number }
  | { found: false };

// cost.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type CostRpcErrorKind = HeartbeatRpcErrorKind;
export type CostCommitOutcome = HeartbeatCommitOutcome;
export type CostRpcErrorClassification = HeartbeatRpcErrorClassification;

const BILLING_SET: ReadonlySet<string> = new Set(COST_BILLING_TYPES);
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
const isBillingType = (v: unknown): v is CostBillingType => isStr(v) && BILLING_SET.has(v);
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
// engine-cost compares chrono DateTimes at ns precision; Date.parse truncates
// the fraction to ms, so digits 4-9 are re-added for window comparison.
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
const checkBillingType = make(isBillingType, "a valid billing type");
const checkI64 = make((v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v),
  "a 64-bit safe integer");
// cost.rs dispatch gates tokens i32>=0 and cost_cents through validate_cost_cents
// (i64 -> i32, non-negative) before any PG I/O.
const checkNonNegI32 = make((v: unknown): v is number => isI32(v) && v >= 0,
  "a non-negative 32-bit integer");
// cost.rs dispatch rejects provider/model that are blank after trim; the value
// is sent verbatim (the engine does not normalize it).
const checkNonBlank = (v: unknown, name: string): string => {
  if (!isStr(v) || v.trim() === "") throw new RangeError(`${name} must be a non-blank string`);
  return v;
};
// serde Option<T>: undefined keeps the key off the wire, null -> None.
const checkOptUuid = (v: unknown, n: string) => (v === undefined || v === null ? v : checkUuid(v, n));
const checkOptStr = (v: unknown, n: string) => (v === undefined || v === null ? v : checkStr(v, n));
const checkOptTs = (v: unknown, n: string) => (v === undefined || v === null ? v : checkTs(v, n));
const checkOptBillingType = (v: unknown, n: string) =>
  (v === undefined || v === null ? v : checkBillingType(v, n));
// engine-cost validate_cost_window (list_events + summarize_window): only
// window_end < window_start is invalid; equal bounds form a legal empty window.
const checkWindow = (from: string | null, to: string | null): void => {
  if (from !== null && to !== null && tsNanos(to) < tsNanos(from)) {
    throw new RangeError("invalid window: to must be at or after from");
  }
};

/** Classifies a rejected cost.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyCostRpcError = (error: unknown): CostRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
// CostEventRow serde order (matches RETURNING/SELECT column order): 18 keys.
const EVENT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["agent_id", isUuid], ["issue_id", isUuidOrNull],
  ["project_id", isUuidOrNull], ["goal_id", isUuidOrNull], ["heartbeat_run_id", isUuidOrNull],
  ["billing_code", isStrOrNull], ["provider", isStr], ["biller", isStr],
  ["billing_type", isBillingType], ["model", isStr], ["input_tokens", isI32],
  ["cached_input_tokens", isI32], ["output_tokens", isI32], ["cost_cents", isI32],
  ["occurred_at", isTs], ["created_at", isTs],
] as const;
const toCostEvent = (v: unknown): CostEvent => row(v, EVENT_ROW, "cost event");

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function recordCostEvent(
  client: PaperworkEngineClient, params: CostRecordEventParams, callOpts?: CallOpts,
): Promise<CostRecordEventResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"), agent_id: checkUuid(params.agent_id, "agent_id"),
    provider: checkNonBlank(params.provider, "provider"), model: checkNonBlank(params.model, "model"),
    input_tokens: checkNonNegI32(params.input_tokens, "input_tokens"),
    cached_input_tokens: checkNonNegI32(params.cached_input_tokens, "cached_input_tokens"),
    output_tokens: checkNonNegI32(params.output_tokens, "output_tokens"),
    cost_cents: checkNonNegI32(params.cost_cents, "cost_cents"),
    occurred_at: checkTs(params.occurred_at, "occurred_at"),
  };
  for (const [name, check] of [
    ["issue_id", checkOptUuid], ["project_id", checkOptUuid], ["goal_id", checkOptUuid],
    ["heartbeat_run_id", checkOptUuid], ["billing_code", checkOptStr],
    ["biller", checkOptStr], ["billing_type", checkOptBillingType],
  ] as const) {
    const v = check(params[name], name);
    if (v !== undefined) wire[name] = v;
  }
  const result = await client.call<unknown>("cost.record_event", wire, callOpts);
  if (!isRec(result) || typeof result.recorded !== "boolean"
    || !hasExactKeys(result, result.recorded ? ["recorded", "event"] : ["recorded"])) {
    throw proto("bad cost.record_event result shape");
  }
  return result.recorded ? { recorded: true, event: toCostEvent(result.event) } : { recorded: false };
}

export async function listCostEvents(
  client: PaperworkEngineClient, params: CostListEventsParams, callOpts?: CallOpts,
): Promise<CostListEventsResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  const agent = checkOptUuid(params.agent_id, "agent_id");
  if (agent !== undefined) wire.agent_id = agent;
  const from = checkOptTs(params.from, "from");
  if (from !== undefined) wire.from = from;
  const to = checkOptTs(params.to, "to");
  if (to !== undefined) wire.to = to;
  // limit is i64 (not Option): serde defaults it engine-side to 100 and clamps
  // to 1..=500; the client sends the value verbatim, omitting it when undefined.
  if (params.limit !== undefined) wire.limit = checkI64(params.limit, "limit");
  checkWindow(from ?? null, to ?? null);
  const result = await client.call<unknown>("cost.list_events", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["events"]) || !Array.isArray(result.events)) {
    throw proto("bad cost.list_events result shape");
  }
  return { events: result.events.map(toCostEvent) };
}

export async function summarizeCostWindow(
  client: PaperworkEngineClient, params: CostSummarizeWindowParams, callOpts?: CallOpts,
): Promise<CostSummarizeWindowResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  const from = checkOptTs(params.from, "from");
  if (from !== undefined) wire.from = from;
  const to = checkOptTs(params.to, "to");
  if (to !== undefined) wire.to = to;
  checkWindow(from ?? null, to ?? null);
  const result = await client.call<unknown>("cost.summarize_window", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["spend_cents"]) || !Number.isSafeInteger(result.spend_cents)) {
    throw proto("bad cost.summarize_window result shape");
  }
  return { spend_cents: result.spend_cents as number };
}

export async function getCostSpendSnapshot(
  client: PaperworkEngineClient, params: CostSpendSnapshotParams, callOpts?: CallOpts,
): Promise<CostSpendSnapshotResult> {
  const result = await client.call<unknown>("cost.get_spend_snapshot", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || typeof result.found !== "boolean"
    || !hasExactKeys(result, result.found
      ? ["found", "company_id", "budget_monthly_cents", "spent_monthly_cents"] : ["found"])) {
    throw proto("bad cost.get_spend_snapshot result shape");
  }
  if (!result.found) return { found: false };
  if (!isUuid(result.company_id) || !isI32(result.budget_monthly_cents) || !isI32(result.spent_monthly_cents)) {
    throw proto("bad cost.get_spend_snapshot result shape");
  }
  return {
    found: true, company_id: result.company_id,
    budget_monthly_cents: result.budget_monthly_cents, spent_monthly_cents: result.spent_monthly_cents,
  };
}
