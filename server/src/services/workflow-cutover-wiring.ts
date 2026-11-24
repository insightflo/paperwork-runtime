// [파일 목적] Wave 5 — workflow 컷오버 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_ENGINE_WORKFLOW_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해
//   컷오버 어댑터(paperwork-engine-workflow-cutover)에 쓰기(transition_run_fenced/
//   transition_step_fenced)·읽기(list_pending_runs/list_step_runs)를 위임하고,
//   그 외에는 TS 작성자/리더를 그대로 호출한다. indeterminate 는 절대 TS 폴백 없이
//   전파하고, fence mismatch(applied:false)는 폴백 없이 그대로 반환한다.
// [외부 연결] paperwork-engine-workflow-cutover(어댑터), paperwork-engine-runtime(공유
//   클라이언트), logger. 호출부는 createWorkflowCutoverHooks 로 env/getClient/
//   timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  isWorkflowEngineCutoverEnabled,
  listPendingWorkflowRunsWithCutover,
  listWorkflowStepRunsWithCutover,
  transitionWorkflowRunFencedWithCutover,
  transitionWorkflowStepFencedWithCutover,
  WorkflowCutoverIndeterminateError,
  type WorkflowCutoverCallOpts,
  type WorkflowCutoverOperation,
  type WorkflowCutoverResult,
} from "./paperwork-engine-workflow-cutover.js";
import type {
  PendingWorkflowRun,
  WorkflowListPendingRunsParams,
  WorkflowListStepRunsParams,
  WorkflowStepRunRow,
  WorkflowTransitionRunFencedParams,
  WorkflowTransitionRunFencedResult,
  WorkflowTransitionStepFencedParams,
  WorkflowTransitionStepFencedResult,
} from "./paperwork-engine-workflow.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { WorkflowCutoverIndeterminateError };
export type { WorkflowCutoverOperation, WorkflowCutoverResult };

/** 배선이 다루는 4개 오퍼레이션 — 어댑터의 쓰기 2개에 부작용 없는 읽기 2개를 더한 합집합. */
export type WorkflowCutoverWiringOperation =
  | WorkflowCutoverOperation
  | "list_pending_runs"
  | "list_step_runs";

export type WorkflowCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface WorkflowCutoverTelemetryEvent {
  operation: WorkflowCutoverWiringOperation;
  outcome: WorkflowCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface WorkflowCutoverOperationMetrics {
  rustSuccess: number; tsBypass: number; tsFallback: number; indeterminateError: number;
  tsError: number; fenceMismatch: number; totalCalls: number; totalDurationMs: number;
}

export type WorkflowCutoverMetricsSnapshot = Readonly<
  Record<WorkflowCutoverWiringOperation, Readonly<WorkflowCutoverOperationMetrics>>>;

export interface WorkflowCutoverWiringOpts extends WorkflowCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: WorkflowCutoverTelemetryEvent) => void;
}

type Meter = Record<WorkflowCutoverWiringOperation, WorkflowCutoverOperationMetrics>;

const OPS: readonly WorkflowCutoverWiringOperation[] = [
  "transition_run_fenced", "transition_step_fenced", "list_pending_runs", "list_step_runs",
];
const emptyOperationMetrics = (): WorkflowCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter =>
  Object.fromEntries(OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): WorkflowCutoverMetricsSnapshot =>
  Object.fromEntries(OPS.map((op) => [op, { ...meter[op] }])) as WorkflowCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: WorkflowCutoverWiringOperation;
  call: (client: PaperworkEngineClient, callOpts: WorkflowCutoverCallOpts) => Promise<WorkflowCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: WorkflowCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<WorkflowCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: WorkflowCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "workflow cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "workflow cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터 없이 TS 를 호출한다. tsFallback 이
  // 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<WorkflowCutoverResult<T>> => {
    metrics.tsBypass += 1;
    try {
      const value = await tsFallback();
      const fenceMismatch = isFenceMismatch(value);
      if (fenceMismatch) metrics.fenceMismatch += 1;
      emit("ts_bypass", "ts", fenceMismatch);
      return { source: "ts", value };
    } catch (error) {
      metrics.tsError += 1;
      emit("ts_error", "ts", false, error);
      throw error;
    }
  };

  const env = opts.env ?? process.env;
  if (!isWorkflowEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine client resolution failed; bypassing to TS");
    return runTsBypass();
  }
  if (client === null) {
    safeWarn({ operation },
      "paperwork-engine client unavailable; bypassing to TS");
    return runTsBypass();
  }

  try {
    const result = await call(client, { timeoutMs: opts.timeoutMs, env });
    const fenceMismatch = isFenceMismatch(result.value);
    if (fenceMismatch) metrics.fenceMismatch += 1;
    if (result.source === "rust") {
      metrics.rustSuccess += 1;
      emit("rust_success", "rust", fenceMismatch);
    } else {
      metrics.tsFallback += 1;
      emit("ts_fallback", "ts", fenceMismatch);
    }
    return result;
  } catch (error) {
    if (error instanceof WorkflowCutoverIndeterminateError) {
      metrics.indeterminateError += 1;
      emit("indeterminate_error", null, false, error);
    } else {
      // 어댑터가 던지는 비-indeterminate 오류는 tsFallback 자체의 실패다.
      metrics.tsError += 1;
      emit("ts_error", null, false, error);
    }
    throw error;
  }
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getWorkflowCutoverMetrics(): WorkflowCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetWorkflowCutoverMetricsForTests(): void {
  for (const op of OPS) moduleMeter[op] = emptyOperationMetrics();
}

type AdapterCall<P, T> = (
  client: PaperworkEngineClient, params: P,
  tsFallback: () => Promise<T>, callOpts: WorkflowCutoverCallOpts,
) => Promise<WorkflowCutoverResult<T>>;
type OptsMerger = (opts: WorkflowCutoverWiringOpts) => WorkflowCutoverWiringOpts;

const bindWire = <P, T>(
  operation: WorkflowCutoverWiringOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, meter: Meter, merge: OptsMerger,
) => (params: P, tsFallback: () => Promise<T>, opts: WorkflowCutoverWiringOpts = {})
    : Promise<WorkflowCutoverResult<T>> =>
  executeCutover({
    operation, isFenceMismatch, tsFallback, meter, opts: merge(opts),
    call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
  });

const identity: OptsMerger = (opts) => opts;
const runFence = (v: WorkflowTransitionRunFencedResult) => v.applied === false;
const stepFence = (v: WorkflowTransitionStepFencedResult) => v.applied === false;
const noFence = () => false;

export const wireTransitionRunFencedCutover = bindWire(
  "transition_run_fenced", transitionWorkflowRunFencedWithCutover, runFence, moduleMeter, identity);
export const wireTransitionStepFencedCutover = bindWire(
  "transition_step_fenced", transitionWorkflowStepFencedWithCutover, stepFence, moduleMeter, identity);
export const wireListPendingRunsCutover = bindWire(
  "list_pending_runs", listPendingWorkflowRunsWithCutover, noFence, moduleMeter, identity);
export const wireListStepRunsCutover = bindWire(
  "list_step_runs", listWorkflowStepRunsWithCutover, noFence, moduleMeter, identity);

export interface WorkflowCutoverHooks {
  transitionRunFenced: typeof wireTransitionRunFencedCutover;
  transitionStepFenced: typeof wireTransitionStepFencedCutover;
  listPendingRuns: typeof wireListPendingRunsCutover;
  listStepRuns: typeof wireListStepRunsCutover;
  getMetrics: () => WorkflowCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createWorkflowCutoverHooks(
  defaultOpts: WorkflowCutoverWiringOpts = {},
): WorkflowCutoverHooks {
  const meter = emptyMeter();
  const merge: OptsMerger = (opts) => ({ ...defaultOpts, ...opts });
  return {
    transitionRunFenced: bindWire("transition_run_fenced", transitionWorkflowRunFencedWithCutover, runFence, meter, merge),
    transitionStepFenced: bindWire("transition_step_fenced", transitionWorkflowStepFencedWithCutover, stepFence, meter, merge),
    listPendingRuns: bindWire("list_pending_runs", listPendingWorkflowRunsWithCutover, noFence, meter, merge),
    listStepRuns: bindWire("list_step_runs", listWorkflowStepRunsWithCutover, noFence, meter, merge),
    getMetrics: () => snapshotMeter(meter),
  };
}
