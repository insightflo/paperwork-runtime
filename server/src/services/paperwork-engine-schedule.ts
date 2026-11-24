// [파일 목적] resident paperwork-engine `schedule.*` typed RPC client — Rust
//   crates/paperwork-engine/src/schedule.rs·engine-schedule/lib.rs 와 필드명·
//   에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, schedule 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError,
  type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification,
  type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export interface ScheduleValidateAdvanceWindowParams {
  last_run_at: string | Date; next_run_at: string | Date;
}
export type ScheduleValidateAdvanceWindowResult =
  | { valid: true }
  | { valid: false; reason: "invalid_advance_window" };

export interface ScheduleListDueParams { company_id: string; due_before: string | Date; limit: number }
export interface DueSchedule {
  id: string; company_id: string; agent_id: string;
  cron_expression: string; timezone: string; mission_id: string | null;
  enabled: boolean; last_run_at: string | null; next_run_at: string | null;
}

export interface ScheduleAdvanceFencedParams {
  schedule_id: string; company_id: string;
  last_run_at: string | Date; next_run_at: string | Date;
  expected_next_run_at?: string | Date | null;
}
export type ScheduleAdvanceFencedResult =
  | { applied: true; id: string; company_id: string; agent_id: string;
      last_run_at: string | null; next_run_at: string | null; updated_at: string }
  | { applied: false };

export interface ScheduleSetEnabledParams { schedule_id: string; company_id: string; enabled: boolean }
export type ScheduleSetEnabledResult =
  | { updated: true; id: string; enabled: boolean; updated_at: string }
  | { updated: false };

export type ScheduleRpcErrorKind = HeartbeatRpcErrorKind;
export type ScheduleCommitOutcome = HeartbeatCommitOutcome;
export type ScheduleRpcErrorClassification = HeartbeatRpcErrorClassification;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PG_EPOCH_NS = 946_684_800_000_000_000n; // 2000-01-01T00:00:00Z in Unix ns
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
// Date.parse silently normalizes hour 24 and other out-of-range fields that
// Rust Chrono rejects; the regex pins each field to unsigned 2-digit values,
// so only the upper bounds need checking before the calendar roundtrip.
const isTs = (v: unknown): v is string => {
  if (typeof v !== "string" || !RFC3339_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [hh, mm, ss] = v.slice(11, 19).split(":").map(Number);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  if (!v.endsWith("Z")) {
    const [oh, om] = v.slice(-5).split(":").map(Number);
    if (oh > 23 || om > 59) return false;
  }
  const [y, mo, d] = v.slice(0, 10).split("-").map(Number);
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
  return dt.toISOString().slice(0, 10) === v.slice(0, 10);
};
const isTsOrNull = (v: unknown): v is string | null => v === null || isTs(v);

// Mirrors schedule.rs pg_micros: postgres-types binds DateTime<Utc> as whole
// µs since the PG epoch, truncating toward zero — (unixNs - epochNs) / 1_000
// in signed BigInt is the same truncation (Date.parse already truncates
// sub-ms digits; digits 4-9 of the fraction re-add them at ns precision).
// Out-of-i64 matches Rust num_microseconds() -> None.
function pgMicros(rfc3339: string): bigint | null {
  const ms = Date.parse(rfc3339);
  const frac = /\.(\d+)/.exec(rfc3339)?.[1] ?? "";
  const subMsNs = BigInt(frac.slice(3, 9).padEnd(6, "0") || "0");
  const micros = (BigInt(ms) * 1_000_000n + subMsNs - PG_EPOCH_NS) / 1_000n;
  return micros >= I64_MIN && micros <= I64_MAX ? micros : null;
}

function proto(msg: string): PaperworkEngineError {
  return new PaperworkEngineError("protocol_error", msg);
}
function checkUuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new RangeError(`${name} must be a UUID string`);
  return v;
}
function checkTs(v: unknown, name: string): string {
  // Dates re-validate through isTs so out-of-4-digit-year instants (±YYYYYY
  // ISO strings Chrono cannot parse as RFC3339) fail exactly like malformed
  // string inputs instead of reaching the wire.
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) {
      const iso = v.toISOString();
      if (isTs(iso)) return iso;
    }
  } else if (isTs(v)) {
    return v;
  }
  throw new RangeError(`${name} must be a valid Date or RFC3339 timestamp`);
}
// schedule.rs dispatch re-checks valid_advance_window_pg pre-I/O (-32602);
// gate at the same driver µs precision before client.call ever runs.
function checkAdvanceWindow(last: string, next: string): void {
  const l = pgMicros(last), n = pgMicros(next);
  if (l === null || n === null || n <= l) {
    throw new RangeError("invalid advance window: next_run_at must advance past last_run_at at PG microsecond precision");
  }
}

/** Maps a rejected schedule.* call to its commit contract — the engine reuses
 *  the same Fail tuples as heartbeat.*, so classification delegates to keep
 *  the two tables from drifting apart. */
export function classifyScheduleRpcError(error: unknown): ScheduleRpcErrorClassification {
  return classifyHeartbeatRpcError(error);
}

// --- response validators -----------------------------------------------------
function toDueSchedule(v: unknown): DueSchedule {
  if (!isRec(v) || Object.keys(v).length !== 9 || !isUuid(v.id) || !isUuid(v.company_id)
    || !isUuid(v.agent_id) || typeof v.cron_expression !== "string" || typeof v.timezone !== "string"
    || !(v.mission_id === null || isUuid(v.mission_id)) || typeof v.enabled !== "boolean"
    || !isTsOrNull(v.last_run_at) || !isTsOrNull(v.next_run_at)) {
    throw proto("bad schedule.list_due schedule shape");
  }
  return {
    id: v.id, company_id: v.company_id, agent_id: v.agent_id,
    cron_expression: v.cron_expression, timezone: v.timezone, mission_id: v.mission_id,
    enabled: v.enabled, last_run_at: v.last_run_at, next_run_at: v.next_run_at,
  };
}
function toValidateResult(v: unknown): ScheduleValidateAdvanceWindowResult {
  if (!isRec(v) || typeof v.valid !== "boolean") throw proto("bad schedule.validate_advance_window result shape");
  if (v.valid) {
    if (Object.keys(v).length !== 1) throw proto("bad schedule.validate_advance_window result shape");
    return { valid: true };
  }
  if (v.reason !== "invalid_advance_window" || Object.keys(v).length !== 2) {
    throw proto("bad schedule.validate_advance_window result shape");
  }
  return { valid: false, reason: "invalid_advance_window" };
}
function toAdvanceResult(v: unknown): ScheduleAdvanceFencedResult {
  if (!isRec(v) || typeof v.applied !== "boolean") throw proto("bad schedule.advance_fenced result shape");
  if (!v.applied) {
    if (Object.keys(v).length !== 1) throw proto("bad schedule.advance_fenced result shape");
    return { applied: false };
  }
  if (Object.keys(v).length !== 7 || !isUuid(v.id) || !isUuid(v.company_id) || !isUuid(v.agent_id)
    || !isTsOrNull(v.last_run_at) || !isTsOrNull(v.next_run_at) || !isTs(v.updated_at)) {
    throw proto("bad schedule.advance_fenced result shape");
  }
  return {
    applied: true, id: v.id, company_id: v.company_id, agent_id: v.agent_id,
    last_run_at: v.last_run_at, next_run_at: v.next_run_at, updated_at: v.updated_at,
  };
}
function toEnabledResult(v: unknown): ScheduleSetEnabledResult {
  if (!isRec(v) || typeof v.updated !== "boolean") throw proto("bad schedule.set_enabled result shape");
  if (!v.updated) {
    if (Object.keys(v).length !== 1) throw proto("bad schedule.set_enabled result shape");
    return { updated: false };
  }
  if (Object.keys(v).length !== 4 || !isUuid(v.id) || typeof v.enabled !== "boolean" || !isTs(v.updated_at)) {
    throw proto("bad schedule.set_enabled result shape");
  }
  return { updated: true, id: v.id, enabled: v.enabled, updated_at: v.updated_at };
}

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function validateScheduleAdvanceWindow(
  client: PaperworkEngineClient, params: ScheduleValidateAdvanceWindowParams, callOpts?: CallOpts,
): Promise<ScheduleValidateAdvanceWindowResult> {
  // The RPC itself reports next <= last as {valid:false}; only shape is gated here.
  const result = await client.call<unknown>("schedule.validate_advance_window", {
    last_run_at: checkTs(params.last_run_at, "last_run_at"),
    next_run_at: checkTs(params.next_run_at, "next_run_at"),
  }, callOpts);
  return toValidateResult(result);
}

export async function listDueSchedules(
  client: PaperworkEngineClient, params: ScheduleListDueParams, callOpts?: CallOpts,
): Promise<DueSchedule[]> {
  const { company_id, due_before, limit } = params;
  if (!Number.isSafeInteger(limit)) throw new RangeError("limit must be a safe integer");
  const result = await client.call<unknown>("schedule.list_due", {
    company_id: checkUuid(company_id, "company_id"),
    due_before: checkTs(due_before, "due_before"), limit,
  }, callOpts);
  if (!isRec(result) || Object.keys(result).length !== 1 || !Array.isArray(result.schedules)) {
    throw proto("bad schedule.list_due result shape");
  }
  return result.schedules.map(toDueSchedule);
}

export async function advanceScheduleFenced(
  client: PaperworkEngineClient, params: ScheduleAdvanceFencedParams, callOpts?: CallOpts,
): Promise<ScheduleAdvanceFencedResult> {
  const last = checkTs(params.last_run_at, "last_run_at");
  const next = checkTs(params.next_run_at, "next_run_at");
  const wire: Record<string, unknown> = {
    schedule_id: checkUuid(params.schedule_id, "schedule_id"),
    company_id: checkUuid(params.company_id, "company_id"),
    last_run_at: last, next_run_at: next,
  };
  const expected = params.expected_next_run_at;
  // serde Option<DateTime<Utc>>: undefined keeps the key off the wire, null -> None.
  if (expected === null) wire.expected_next_run_at = null;
  else if (expected !== undefined) wire.expected_next_run_at = checkTs(expected, "expected_next_run_at");
  checkAdvanceWindow(last, next);
  const result = await client.call<unknown>("schedule.advance_fenced", wire, callOpts);
  return toAdvanceResult(result);
}

export async function setScheduleEnabled(
  client: PaperworkEngineClient, params: ScheduleSetEnabledParams, callOpts?: CallOpts,
): Promise<ScheduleSetEnabledResult> {
  // Single-read snapshot: a getter-backed params.enabled must not be able to
  // flip or drop the value between the boolean check and the wire object.
  const enabled = params.enabled;
  if (typeof enabled !== "boolean") throw new RangeError("enabled must be a boolean");
  const result = await client.call<unknown>("schedule.set_enabled", {
    schedule_id: checkUuid(params.schedule_id, "schedule_id"),
    company_id: checkUuid(params.company_id, "company_id"),
    enabled,
  }, callOpts);
  return toEnabledResult(result);
}
