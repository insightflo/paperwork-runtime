// [파일 목적] resident paperwork-engine `heartbeat.*` typed RPC client — Rust
//   crates/paperwork-engine/src/heartbeat.rs·engine-heartbeat/lib.rs 와 필드명·
//   에러 코드·RunStatus union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   engine-heartbeat RunStatus/SQL_*, heartbeat supervisor 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";

export const HEARTBEAT_RUN_STATUSES = [
  "queued", "running", "succeeded", "failed", "cancelled", "timed_out",
] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export interface HeartbeatValidateTransitionParams {
  expected_statuses: HeartbeatRunStatus[]; next_status: HeartbeatRunStatus;
}
export type HeartbeatValidateTransitionResult =
  | { valid: true; sets_started_at: boolean; sets_finished_at: boolean }
  | { valid: false; reason: "illegal_transition"; from: HeartbeatRunStatus; to: HeartbeatRunStatus };

export interface HeartbeatClaimWakeupParams { company_id: string; agent_id: string }
export interface HeartbeatClaimedWakeup {
  id: string; company_id: string; agent_id: string; source: string;
  reason: string | null; idempotency_key: string | null; payload: unknown;
  requested_at: string; claimed_at: string | null;
}

export interface HeartbeatTransitionRunFencedParams {
  run_id: string; company_id: string;
  expected_statuses: HeartbeatRunStatus[]; next_status: HeartbeatRunStatus;
  error?: string; error_code?: string;
}
export type HeartbeatTransitionRunFencedResult =
  | { applied: true; run_id: string; status: HeartbeatRunStatus; started_at: string | null; finished_at: string | null }
  | { applied: false };

export interface HeartbeatListStaleRunsParams { company_id: string; stale_before: string | Date; limit: number }
export interface HeartbeatStaleRun {
  id: string; company_id: string; agent_id: string;
  process_pid: number | null; process_loss_retry_count: number; updated_at: string;
}

export type HeartbeatRpcErrorKind =
  | "timeout" | "commit_indeterminate" | "unconfigured" | "busy" | "db_error" | "invalid_params" | "unknown";
export type HeartbeatCommitOutcome = "not_committed" | "indeterminate";
export interface HeartbeatRpcErrorClassification {
  kind: HeartbeatRpcErrorKind; outcome: HeartbeatCommitOutcome; retryable: boolean;
}

const RUN_STATUS_SET: ReadonlySet<string> = new Set(HEARTBEAT_RUN_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is HeartbeatRunStatus =>
  typeof v === "string" && RUN_STATUS_SET.has(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isTs = (v: unknown): v is string =>
  typeof v === "string" && RFC3339_RE.test(v) && !Number.isNaN(Date.parse(v));
const isTsOrNull = (v: unknown): v is string | null => v === null || isTs(v);

// Mirrors engine-heartbeat RunStatus::is_legal_transition (queued ->
// running|cancelled|failed; running -> any terminal; terminal -> none) so the
// fence never ships an input the engine would reject with -32602.
const LEGAL_NEXT: Readonly<Record<HeartbeatRunStatus, ReadonlySet<HeartbeatRunStatus>>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["succeeded", "failed", "cancelled", "timed_out"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), timed_out: new Set(),
};

function proto(msg: string): PaperworkEngineError {
  return new PaperworkEngineError("protocol_error", msg);
}
function checkStatus(v: unknown, name: string): HeartbeatRunStatus {
  if (!isStatus(v)) throw new RangeError(`${name} must be a valid heartbeat run status`);
  return v;
}
function checkUuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new RangeError(`${name} must be a UUID string`);
  return v;
}
function checkStatuses(v: unknown, name: string): HeartbeatRunStatus[] {
  if (!Array.isArray(v) || v.length === 0) throw new RangeError(`${name} must be a non-empty status array`);
  return v.map((s, i) => checkStatus(s, `${name}[${i}]`));
}
function checkOptStr(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new RangeError(`${name} must be a string`);
  return v;
}
function checkLegalTransition(expected: HeartbeatRunStatus[], next: HeartbeatRunStatus): void {
  for (const from of expected) {
    if (!LEGAL_NEXT[from].has(next)) {
      throw new RangeError(`illegal run status transition: ${from} -> ${next}`);
    }
  }
}
function checkStaleBefore(v: unknown, name: string): string {
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) return v.toISOString();
  } else if (isTs(v)) {
    return v;
  }
  throw new RangeError(`${name} must be a valid Date or RFC3339 timestamp`);
}

// --- error classification (Rust Fail tuples: code -> outcome/retryable) -----
const RPC_ERROR_TABLE: Readonly<Record<number, HeartbeatRpcErrorClassification>> = {
  [-32001]: { kind: "timeout", outcome: "not_committed", retryable: true },
  [-32002]: { kind: "unconfigured", outcome: "not_committed", retryable: false },
  [-32003]: { kind: "busy", outcome: "not_committed", retryable: true },
  [-32004]: { kind: "db_error", outcome: "not_committed", retryable: false },
  [-32005]: { kind: "commit_indeterminate", outcome: "indeterminate", retryable: false },
  [-32602]: { kind: "invalid_params", outcome: "not_committed", retryable: false },
};
const UNKNOWN_CLASSIFICATION: HeartbeatRpcErrorClassification = {
  kind: "unknown", outcome: "indeterminate", retryable: false, // fail-closed
};

/** Maps a rejected heartbeat.* call to its commit contract. Transport/local
 *  errors (client timeout, process exit, closed) and unrecognized RPC codes are
 *  indeterminate/never-retry — a retry could double-apply a committed write. */
export function classifyHeartbeatRpcError(error: unknown): HeartbeatRpcErrorClassification {
  if (error instanceof PaperworkEngineError && error.code === "rpc_error"
    && typeof error.rpcCode === "number" && Number.isInteger(error.rpcCode)) {
    return RPC_ERROR_TABLE[error.rpcCode] ?? UNKNOWN_CLASSIFICATION;
  }
  return UNKNOWN_CLASSIFICATION;
}

// --- response validators -----------------------------------------------------
function toWakeup(v: unknown): HeartbeatClaimedWakeup {
  if (!isRec(v) || !isUuid(v.id) || !isUuid(v.company_id)
    || !isUuid(v.agent_id) || typeof v.source !== "string"
    || !isStrOrNull(v.reason) || !isStrOrNull(v.idempotency_key)
    || !isTs(v.requested_at) || !isTsOrNull(v.claimed_at)
    || !("payload" in v) || v.payload === undefined) {
    throw proto("bad heartbeat.claim_wakeup claimed shape");
  }
  return {
    id: v.id, company_id: v.company_id, agent_id: v.agent_id, source: v.source,
    reason: v.reason, idempotency_key: v.idempotency_key, payload: v.payload,
    requested_at: v.requested_at, claimed_at: v.claimed_at,
  };
}
function toValidateResult(v: unknown): HeartbeatValidateTransitionResult {
  if (!isRec(v) || typeof v.valid !== "boolean") throw proto("bad heartbeat.validate_transition result shape");
  if (v.valid) {
    if (typeof v.sets_started_at !== "boolean" || typeof v.sets_finished_at !== "boolean") {
      throw proto("bad heartbeat.validate_transition result shape");
    }
    return { valid: true, sets_started_at: v.sets_started_at, sets_finished_at: v.sets_finished_at };
  }
  if (v.reason !== "illegal_transition" || !isStatus(v.from) || !isStatus(v.to)) {
    throw proto("bad heartbeat.validate_transition result shape");
  }
  return { valid: false, reason: "illegal_transition", from: v.from, to: v.to };
}
function toTransitionResult(v: unknown): HeartbeatTransitionRunFencedResult {
  if (!isRec(v) || typeof v.applied !== "boolean") throw proto("bad heartbeat.transition_run_fenced result shape");
  if (!v.applied) return { applied: false };
  if (!isUuid(v.run_id) || !isStatus(v.status)
    || !isTsOrNull(v.started_at) || !isTsOrNull(v.finished_at)) {
    throw proto("bad heartbeat.transition_run_fenced result shape");
  }
  return {
    applied: true, run_id: v.run_id, status: v.status,
    started_at: v.started_at, finished_at: v.finished_at,
  };
}
function toStaleRun(v: unknown): HeartbeatStaleRun {
  if (!isRec(v) || !isUuid(v.id) || !isUuid(v.company_id)
    || !isUuid(v.agent_id)
    || !(v.process_pid === null || Number.isInteger(v.process_pid))
    || !Number.isInteger(v.process_loss_retry_count)
    || !isTs(v.updated_at)) throw proto("bad heartbeat.list_stale_runs run shape");
  return {
    id: v.id, company_id: v.company_id, agent_id: v.agent_id,
    process_pid: v.process_pid as number | null,
    process_loss_retry_count: v.process_loss_retry_count as number, updated_at: v.updated_at,
  };
}

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function validateHeartbeatTransition(
  client: PaperworkEngineClient, params: HeartbeatValidateTransitionParams, callOpts?: CallOpts,
): Promise<HeartbeatValidateTransitionResult> {
  const result = await client.call<unknown>("heartbeat.validate_transition", {
    expected_statuses: checkStatuses(params.expected_statuses, "expected_statuses"),
    next_status: checkStatus(params.next_status, "next_status"),
  }, callOpts);
  return toValidateResult(result);
}

export async function claimHeartbeatWakeup(
  client: PaperworkEngineClient, params: HeartbeatClaimWakeupParams, callOpts?: CallOpts,
): Promise<HeartbeatClaimedWakeup | null> {
  const result = await client.call<unknown>("heartbeat.claim_wakeup", {
    company_id: checkUuid(params.company_id, "company_id"),
    agent_id: checkUuid(params.agent_id, "agent_id"),
  }, callOpts);
  if (!isRec(result) || !(result.claimed === null || isRec(result.claimed))) {
    throw proto("bad heartbeat.claim_wakeup result shape");
  }
  return result.claimed === null ? null : toWakeup(result.claimed);
}

export async function transitionHeartbeatRunFenced(
  client: PaperworkEngineClient, params: HeartbeatTransitionRunFencedParams, callOpts?: CallOpts,
): Promise<HeartbeatTransitionRunFencedResult> {
  const expected = checkStatuses(params.expected_statuses, "expected_statuses");
  const next = checkStatus(params.next_status, "next_status");
  checkLegalTransition(expected, next);
  const wire: Record<string, unknown> = {
    run_id: checkUuid(params.run_id, "run_id"),
    company_id: checkUuid(params.company_id, "company_id"),
    expected_statuses: expected, next_status: next,
  };
  const error = checkOptStr(params.error, "error");
  const errorCode = checkOptStr(params.error_code, "error_code");
  // serde Option<String> accepts null, but omitting keeps the payload minimal.
  if (error !== undefined) wire.error = error;
  if (errorCode !== undefined) wire.error_code = errorCode;
  const result = await client.call<unknown>("heartbeat.transition_run_fenced", wire, callOpts);
  return toTransitionResult(result);
}

export async function listStaleHeartbeatRuns(
  client: PaperworkEngineClient, params: HeartbeatListStaleRunsParams, callOpts?: CallOpts,
): Promise<HeartbeatStaleRun[]> {
  const { company_id, stale_before, limit } = params;
  if (!Number.isSafeInteger(limit)) throw new RangeError("limit must be a safe integer");
  const result = await client.call<unknown>("heartbeat.list_stale_runs", {
    company_id: checkUuid(company_id, "company_id"),
    stale_before: checkStaleBefore(stale_before, "stale_before"), limit,
  }, callOpts);
  if (!isRec(result) || !Array.isArray(result.runs)) throw proto("bad heartbeat.list_stale_runs result shape");
  return result.runs.map(toStaleRun);
}
