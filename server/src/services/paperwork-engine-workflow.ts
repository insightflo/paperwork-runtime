// [파일 목적] resident paperwork-engine `workflow.*` typed RPC client — Rust
//   crates/paperwork-engine/src/workflow.rs·engine-workflow/lib.rs 와 필드명·
//   에러 코드·status union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError, workflow supervisor 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const WORKFLOW_RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export const WORKFLOW_STEP_STATUSES = ["pending", "running", "completed", "failed", "skipped", "cancelled"] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

export interface WorkflowValidateRunTransitionParams {
  expected_statuses: readonly WorkflowRunStatus[]; next_status: WorkflowRunStatus;
}
export interface WorkflowValidateStepTransitionParams {
  expected_statuses: readonly WorkflowStepStatus[]; next_status: WorkflowStepStatus;
}
type WorkflowValidateResult<S extends string, R extends string> =
  | { valid: true; sets_started_at: boolean; sets_completed_at: boolean }
  | { valid: false; reason: R; from: S; to: S };
export type WorkflowValidateRunTransitionResult = WorkflowValidateResult<WorkflowRunStatus, "illegal_run_transition">;
export type WorkflowValidateStepTransitionResult = WorkflowValidateResult<WorkflowStepStatus, "illegal_step_transition">;

export interface WorkflowListPendingRunsParams { company_id: string; limit: number }
export interface PendingWorkflowRun {
  id: string; workflow_id: string; company_id: string; mission_id: string | null; triggered_by: string; created_at: string;
}

export interface WorkflowTransitionRunFencedParams {
  run_id: string; company_id: string; expected_statuses: readonly WorkflowRunStatus[]; next_status: WorkflowRunStatus;
}
export type WorkflowTransitionRunFencedResult =
  | { applied: true; run_id: string; status: WorkflowRunStatus; started_at: string | null; completed_at: string | null }
  | { applied: false };

export interface WorkflowTransitionStepFencedParams {
  step_run_id: string; workflow_run_id: string; company_id: string;
  expected_statuses: readonly WorkflowStepStatus[]; next_status: WorkflowStepStatus; expected_transition_version: number;
}
export type WorkflowTransitionStepFencedResult =
  | { applied: true; step_run_id: string; status: WorkflowStepStatus; status_transition_version: number; started_at: string | null; completed_at: string | null }
  | { applied: false };

export interface WorkflowListStepRunsParams { company_id: string; workflow_run_id: string }
export interface WorkflowStepRunRow {
  id: string; workflow_run_id: string; step_id: string; status: WorkflowStepStatus; retry_count: number;
  status_transition_version: number; execution_generation: number; started_at: string | null; completed_at: string | null;
}

// workflow.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type WorkflowRpcErrorKind = HeartbeatRpcErrorKind;
export type WorkflowCommitOutcome = HeartbeatCommitOutcome;
export type WorkflowRpcErrorClassification = HeartbeatRpcErrorClassification;

const RUN_STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_RUN_STATUSES);
const STEP_STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_STEP_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const I32_MIN = -2_147_483_648, I32_MAX = 2_147_483_647;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRunStatus = (v: unknown): v is WorkflowRunStatus => typeof v === "string" && RUN_STATUS_SET.has(v);
const isStepStatus = (v: unknown): v is WorkflowStepStatus => typeof v === "string" && STEP_STATUS_SET.has(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isUuidOrNull = (v: unknown): v is string | null => v === null || isUuid(v);
const isI32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX;
const isTs = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const m = RFC3339_RE.exec(v); // g1-3: hh:mm:ss; g5-6: offset hh:mm (g4=sign) when not Z
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59
    || (m[5] !== undefined && (Number(m[5]) > 23 || Number(m[6]) > 59)) || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d] = v.slice(0, 10).split("-").map(Number);
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
  return dt.toISOString().slice(0, 10) === v.slice(0, 10);
};
const isTsOrNull = (v: unknown): v is string | null => v === null || isTs(v);

// Mirrors engine-workflow is_legal_transition for both matrices so a fenced
// call never ships an input the engine would reject with -32602.
const LEGAL_RUN_NEXT: Readonly<Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>> = {
  pending: new Set(["running", "cancelled", "failed"]), running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
};
const LEGAL_STEP_NEXT: Readonly<Record<WorkflowStepStatus, ReadonlySet<WorkflowStepStatus>>> = {
  pending: new Set(["running", "skipped", "cancelled", "failed"]), running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(), failed: new Set(), skipped: new Set(), cancelled: new Set(),
};

const proto = (msg: string) => new PaperworkEngineError("protocol_error", msg);
function checkUuid(v: unknown, name: string): string {
  if (!isUuid(v)) throw new RangeError(`${name} must be a UUID string`);
  return v;
}
function checkI32(v: unknown, name: string): number {
  if (!isI32(v)) throw new RangeError(`${name} must be a 32-bit signed integer`);
  return v;
}
function checkStatus<S extends string>(set: ReadonlySet<string>, v: unknown, name: string, label: string): S {
  if (typeof v !== "string" || !set.has(v)) throw new RangeError(`${name} must be a valid workflow ${label} status`);
  return v as S;
}
function checkStatuses<S extends string>(set: ReadonlySet<string>, v: unknown, name: string, label: string): S[] {
  if (!Array.isArray(v) || v.length === 0) throw new RangeError(`${name} must be a non-empty status array`);
  const out: S[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!Object.hasOwn(v, i)) throw new RangeError(`${name}[${i}] must be a valid workflow ${label} status`);
    out.push(checkStatus<S>(set, v[i], `${name}[${i}]`, label));
  }
  return out;
}
function checkLegal<S extends string>(legal: Readonly<Record<S, ReadonlySet<S>>>, expected: readonly S[], next: S, label: string): void {
  for (const from of expected) {
    if (!legal[from].has(next)) throw new RangeError(`illegal ${label} status transition: ${from} -> ${next}`);
  }
}

/** Maps a rejected workflow.* call to the shared commit contract: unrecognized
 *  codes and transport errors stay indeterminate/never-retry (fail-closed). */
export function classifyWorkflowRpcError(error: unknown): WorkflowRpcErrorClassification {
  return classifyHeartbeatRpcError(error);
}

// --- response validators -----------------------------------------------------
function toValidateResult<S extends string, R extends string>(
  v: unknown, method: string, reason: R, isStatus: (x: unknown) => x is S,
): WorkflowValidateResult<S, R> {
  const bad = () => proto(`bad ${method} result shape`);
  if (!isRec(v) || typeof v.valid !== "boolean") throw bad();
  if (v.valid) {
    if (Object.keys(v).length !== 3 || typeof v.sets_started_at !== "boolean" || typeof v.sets_completed_at !== "boolean") throw bad();
    return { valid: true, sets_started_at: v.sets_started_at, sets_completed_at: v.sets_completed_at };
  }
  if (Object.keys(v).length !== 4 || v.reason !== reason || !isStatus(v.from) || !isStatus(v.to)) throw bad();
  return { valid: false, reason, from: v.from, to: v.to };
}
function checkApplied(v: unknown, method: string, appliedKeys: number): Record<string, unknown> {
  if (!isRec(v) || typeof v.applied !== "boolean" || Object.keys(v).length !== (v.applied ? appliedKeys : 1)) {
    throw proto(`bad ${method} result shape`);
  }
  return v;
}
function toPendingRun(v: unknown): PendingWorkflowRun {
  if (!isRec(v) || Object.keys(v).length !== 6 || !isUuid(v.id) || !isUuid(v.workflow_id)
    || !isUuid(v.company_id) || !isUuidOrNull(v.mission_id) || typeof v.triggered_by !== "string" || !isTs(v.created_at)) {
    throw proto("bad workflow.list_pending_runs run shape");
  }
  return {
    id: v.id, workflow_id: v.workflow_id, company_id: v.company_id, mission_id: v.mission_id,
    triggered_by: v.triggered_by, created_at: v.created_at,
  };
}
function toRunTransitionResult(v: unknown): WorkflowTransitionRunFencedResult {
  const o = checkApplied(v, "workflow.transition_run_fenced", 5);
  if (!o.applied) return { applied: false };
  if (!isUuid(o.run_id) || !isRunStatus(o.status) || !isTsOrNull(o.started_at) || !isTsOrNull(o.completed_at)) {
    throw proto("bad workflow.transition_run_fenced result shape");
  }
  return { applied: true, run_id: o.run_id, status: o.status, started_at: o.started_at, completed_at: o.completed_at };
}
function toStepTransitionResult(v: unknown): WorkflowTransitionStepFencedResult {
  const o = checkApplied(v, "workflow.transition_step_fenced", 6);
  if (!o.applied) return { applied: false };
  if (!isUuid(o.step_run_id) || !isStepStatus(o.status) || !isI32(o.status_transition_version)
    || !isTsOrNull(o.started_at) || !isTsOrNull(o.completed_at)) {
    throw proto("bad workflow.transition_step_fenced result shape");
  }
  return {
    applied: true, step_run_id: o.step_run_id, status: o.status, status_transition_version: o.status_transition_version,
    started_at: o.started_at, completed_at: o.completed_at,
  };
}
function toStepRunRow(v: unknown): WorkflowStepRunRow {
  if (!isRec(v) || !isUuid(v.id) || !isUuid(v.workflow_run_id) || typeof v.step_id !== "string"
    || !isStepStatus(v.status) || !isI32(v.retry_count) || !isI32(v.status_transition_version)
    || !isI32(v.execution_generation) || !isTsOrNull(v.started_at) || !isTsOrNull(v.completed_at) || Object.keys(v).length !== 9) {
    throw proto("bad workflow.list_step_runs step shape");
  }
  return {
    id: v.id, workflow_run_id: v.workflow_run_id, step_id: v.step_id, status: v.status, retry_count: v.retry_count,
    status_transition_version: v.status_transition_version, execution_generation: v.execution_generation,
    started_at: v.started_at, completed_at: v.completed_at,
  };
}

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function validateWorkflowRunTransition(
  client: PaperworkEngineClient, params: WorkflowValidateRunTransitionParams, callOpts?: CallOpts,
): Promise<WorkflowValidateRunTransitionResult> {
  const result = await client.call<unknown>("workflow.validate_run_transition", {
    expected_statuses: checkStatuses<WorkflowRunStatus>(RUN_STATUS_SET, params.expected_statuses, "expected_statuses", "run"),
    next_status: checkStatus<WorkflowRunStatus>(RUN_STATUS_SET, params.next_status, "next_status", "run"),
  }, callOpts);
  return toValidateResult(result, "workflow.validate_run_transition", "illegal_run_transition", isRunStatus);
}

export async function validateWorkflowStepTransition(
  client: PaperworkEngineClient, params: WorkflowValidateStepTransitionParams, callOpts?: CallOpts,
): Promise<WorkflowValidateStepTransitionResult> {
  const result = await client.call<unknown>("workflow.validate_step_transition", {
    expected_statuses: checkStatuses<WorkflowStepStatus>(STEP_STATUS_SET, params.expected_statuses, "expected_statuses", "step"),
    next_status: checkStatus<WorkflowStepStatus>(STEP_STATUS_SET, params.next_status, "next_status", "step"),
  }, callOpts);
  return toValidateResult(result, "workflow.validate_step_transition", "illegal_step_transition", isStepStatus);
}

export async function listPendingWorkflowRuns(
  client: PaperworkEngineClient, params: WorkflowListPendingRunsParams, callOpts?: CallOpts,
): Promise<PendingWorkflowRun[]> {
  const { company_id, limit } = params;
  if (!Number.isSafeInteger(limit)) throw new RangeError("limit must be a safe integer");
  const result = await client.call<unknown>("workflow.list_pending_runs",
    { company_id: checkUuid(company_id, "company_id"), limit }, callOpts);
  if (!isRec(result) || Object.keys(result).length !== 1 || !Array.isArray(result.runs)) throw proto("bad workflow.list_pending_runs result shape");
  return result.runs.map(toPendingRun);
}

export async function transitionWorkflowRunFenced(
  client: PaperworkEngineClient, params: WorkflowTransitionRunFencedParams, callOpts?: CallOpts,
): Promise<WorkflowTransitionRunFencedResult> {
  const expected = checkStatuses<WorkflowRunStatus>(RUN_STATUS_SET, params.expected_statuses, "expected_statuses", "run");
  const next = checkStatus<WorkflowRunStatus>(RUN_STATUS_SET, params.next_status, "next_status", "run");
  checkLegal(LEGAL_RUN_NEXT, expected, next, "run");
  const result = await client.call<unknown>("workflow.transition_run_fenced", {
    run_id: checkUuid(params.run_id, "run_id"), company_id: checkUuid(params.company_id, "company_id"),
    expected_statuses: expected, next_status: next,
  }, callOpts);
  return toRunTransitionResult(result);
}

export async function transitionWorkflowStepFenced(
  client: PaperworkEngineClient, params: WorkflowTransitionStepFencedParams, callOpts?: CallOpts,
): Promise<WorkflowTransitionStepFencedResult> {
  const expected = checkStatuses<WorkflowStepStatus>(STEP_STATUS_SET, params.expected_statuses, "expected_statuses", "step");
  const next = checkStatus<WorkflowStepStatus>(STEP_STATUS_SET, params.next_status, "next_status", "step");
  checkLegal(LEGAL_STEP_NEXT, expected, next, "step");
  const result = await client.call<unknown>("workflow.transition_step_fenced", {
    step_run_id: checkUuid(params.step_run_id, "step_run_id"),
    workflow_run_id: checkUuid(params.workflow_run_id, "workflow_run_id"),
    company_id: checkUuid(params.company_id, "company_id"), expected_statuses: expected, next_status: next,
    expected_transition_version: checkI32(params.expected_transition_version, "expected_transition_version"),
  }, callOpts);
  return toStepTransitionResult(result);
}

export async function listWorkflowStepRuns(
  client: PaperworkEngineClient, params: WorkflowListStepRunsParams, callOpts?: CallOpts,
): Promise<WorkflowStepRunRow[]> {
  const result = await client.call<unknown>("workflow.list_step_runs", {
    company_id: checkUuid(params.company_id, "company_id"), workflow_run_id: checkUuid(params.workflow_run_id, "workflow_run_id"),
  }, callOpts);
  if (!isRec(result) || Object.keys(result).length !== 1 || !Array.isArray(result.steps)) throw proto("bad workflow.list_step_runs result shape");
  return result.steps.map(toStepRunRow);
}
