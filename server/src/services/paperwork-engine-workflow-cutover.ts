// [파일 목적] paperwork-engine workflow.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_ENGINE_WORKFLOW_CUTOVER=1 이면 쓰기(transition_run_fenced/
//   transition_step_fenced)를 Rust RPC 로 먼저 시도한다. 응답이 not_committed 로
//   분류되면 경고 후 기존 TS 작성자로 폴백하고, indeterminate 면 커밋 여부를 알 수
//   없으므로 절대 TS 폴백을 호출하지 않고 WorkflowCutoverIndeterminateError 를
//   던진다(이중 적용 방지). 읽기(list_pending_runs/list_step_runs)는 부작용이
//   없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null 클라이언트·엔진 표현 불가
//   입력은 RPC 없이 곧바로 TS 경로다.
// [외부 연결] paperwork-engine-workflow typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  WORKFLOW_RUN_STATUSES, WORKFLOW_STEP_STATUSES, classifyWorkflowRpcError,
  listPendingWorkflowRuns, listWorkflowStepRuns,
  transitionWorkflowRunFenced, transitionWorkflowStepFenced,
  type PendingWorkflowRun, type WorkflowListPendingRunsParams,
  type WorkflowListStepRunsParams, type WorkflowRpcErrorClassification,
  type WorkflowRunStatus, type WorkflowStepRunRow, type WorkflowStepStatus,
  type WorkflowTransitionRunFencedParams, type WorkflowTransitionRunFencedResult,
  type WorkflowTransitionStepFencedParams, type WorkflowTransitionStepFencedResult,
} from "./paperwork-engine-workflow.js";

export const WORKFLOW_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const WORKFLOW_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(WORKFLOW_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : WORKFLOW_CUTOVER_READ_TIMEOUT_MS;
}

export type WorkflowCutoverSource = "rust" | "ts";
export interface WorkflowCutoverResult<T> { source: WorkflowCutoverSource; value: T }
export type WorkflowCutoverOperation = "transition_run_fenced" | "transition_step_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface WorkflowCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class WorkflowCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: WorkflowCutoverOperation,
    readonly classification: WorkflowRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`workflow cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "WorkflowCutoverIndeterminateError";
  }
}

export function isWorkflowEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_ENGINE_WORKFLOW_CUTOVER === "1";
}

const RUN_SET: ReadonlySet<string> = new Set(WORKFLOW_RUN_STATUSES);
const STEP_SET: ReadonlySet<string> = new Set(WORKFLOW_STEP_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const I32_MIN = -2_147_483_648, I32_MAX = 2_147_483_647;
const isRunStatus = (v: unknown): v is WorkflowRunStatus =>
  typeof v === "string" && RUN_SET.has(v);
const isStepStatus = (v: unknown): v is WorkflowStepStatus =>
  typeof v === "string" && STEP_SET.has(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX;

// Mirrors LEGAL_RUN_NEXT/LEGAL_STEP_NEXT in paperwork-engine-workflow.ts
// (engine-workflow is_legal_transition). A transition the typed client rejects
// pre-send with RangeError must reach TS, not classify indeterminate after the fact.
const LEGAL_RUN_NEXT: Readonly<Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>> = {
  pending: new Set(["running", "cancelled", "failed"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
};
const LEGAL_STEP_NEXT: Readonly<Record<WorkflowStepStatus, ReadonlySet<WorkflowStepStatus>>> = {
  pending: new Set(["running", "skipped", "cancelled", "failed"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(), failed: new Set(), skipped: new Set(), cancelled: new Set(),
};

// Index loop, not .every(): sparse arrays (Array(1)) skip holes in .every and
// would read eligible, then throw a RangeError the engine never saw.
function legalFromAll<S extends string>(
  legal: Readonly<Record<S, ReadonlySet<S>>>, isStatus: (v: unknown) => v is S,
  expected: readonly unknown[], next: S,
): boolean {
  for (let i = 0; i < expected.length; i++) {
    const from = expected[i];
    if (!isStatus(from) || !legal[from].has(next)) return false;
  }
  return true;
}

/** typed client 가 전송 전 RangeError 를 던질 모든 입력을 eligibility 로 미리
 *  걸러 TS 경로(오늘의 동작)를 유지한다 — 플래그 ON 이 새 실패 모드를 만들지 않게. */
function isRunTransitionEngineEligible(params: WorkflowTransitionRunFencedParams): boolean {
  if (!isUuid(params.run_id) || !isUuid(params.company_id)) return false;
  const { expected_statuses, next_status } = params;
  if (!isRunStatus(next_status) || !Array.isArray(expected_statuses) || expected_statuses.length === 0) {
    return false;
  }
  return legalFromAll(LEGAL_RUN_NEXT, isRunStatus, expected_statuses, next_status);
}

function isStepTransitionEngineEligible(params: WorkflowTransitionStepFencedParams): boolean {
  if (!isUuid(params.step_run_id) || !isUuid(params.workflow_run_id) || !isUuid(params.company_id)
    || !isI32(params.expected_transition_version)) return false;
  const { expected_statuses, next_status } = params;
  if (!isStepStatus(next_status) || !Array.isArray(expected_statuses) || expected_statuses.length === 0) {
    return false;
  }
  return legalFromAll(LEGAL_STEP_NEXT, isStepStatus, expected_statuses, next_status);
}

/** logger 경고는 best-effort — transport 예외가 컷오버 판단을 바꾸면 안 된다. */
function warnBestEffort(fields: Record<string, unknown>, message: string): void {
  try { logger.warn(fields, message); } catch { /* logging must never block cutover */ }
}

async function writeWithCutover<T>(
  operation: WorkflowCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<WorkflowCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyWorkflowRpcError(error);
    if (classification.outcome === "not_committed") {
      warnBestEffort({ operation, kind: classification.kind, err: error },
        "paperwork-engine workflow write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new WorkflowCutoverIndeterminateError(operation, classification, error);
  }
}

export async function transitionWorkflowRunFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: WorkflowTransitionRunFencedParams,
  tsFallback: () => Promise<WorkflowTransitionRunFencedResult>,
  opts: WorkflowCutoverCallOpts = {},
): Promise<WorkflowCutoverResult<WorkflowTransitionRunFencedResult>> {
  if (client === null || !isWorkflowEngineCutoverEnabled(opts.env)
    || !isRunTransitionEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("transition_run_fenced",
    () => transitionWorkflowRunFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function transitionWorkflowStepFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: WorkflowTransitionStepFencedParams,
  tsFallback: () => Promise<WorkflowTransitionStepFencedResult>,
  opts: WorkflowCutoverCallOpts = {},
): Promise<WorkflowCutoverResult<WorkflowTransitionStepFencedResult>> {
  if (client === null || !isWorkflowEngineCutoverEnabled(opts.env)
    || !isStepTransitionEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("transition_step_fenced",
    () => transitionWorkflowStepFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

async function readWithCutover<T>(
  operation: "list_pending_runs" | "list_step_runs",
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<WorkflowCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    warnBestEffort({ operation, err: error },
      "paperwork-engine workflow read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function listPendingWorkflowRunsWithCutover(
  client: PaperworkEngineClient | null,
  params: WorkflowListPendingRunsParams,
  tsFallback: () => Promise<PendingWorkflowRun[]>,
  opts: WorkflowCutoverCallOpts = {},
): Promise<WorkflowCutoverResult<PendingWorkflowRun[]>> {
  if (client === null || !isWorkflowEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_pending_runs",
    () => listPendingWorkflowRuns(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listWorkflowStepRunsWithCutover(
  client: PaperworkEngineClient | null,
  params: WorkflowListStepRunsParams,
  tsFallback: () => Promise<WorkflowStepRunRow[]>,
  opts: WorkflowCutoverCallOpts = {},
): Promise<WorkflowCutoverResult<WorkflowStepRunRow[]>> {
  if (client === null || !isWorkflowEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_step_runs",
    () => listWorkflowStepRuns(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
