// [파일 목적] Phase 2K Wave 5 — activity.* 컷오버(append_event/
//   resolve_operator_decision_fenced 쓰기 + list_events/list_operator_decisions
//   읽기) 배선 + 구조화 텔레메트리 계층. PAPERWORK_RUST_ACTIVITY_CUTOVER=1
//   (기본 OFF)일 때만 엔진 클라이언트를 해석해 컷오버 어댑터(activity-cutover)에
//   위임하고, 그 외에는 TS 작성자/리더를 그대로 호출한다. indeterminate 쓰기
//   오류는 절대 TS 폴백 없이 ActivityCutoverIndeterminateError 로 전파하고,
//   fence 미적용 결과({updated:false})는 폴백 없이 그대로 반환한다.
// [외부 연결] activity-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createActivityCutoverHooks 로 env/getClient/timeoutMs/
//   onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  ActivityCutoverIndeterminateError, appendActivityEventWithCutover,
  isActivityEngineCutoverEnabled, listActivityEventsWithCutover,
  listOperatorDecisionsWithCutover, resolveOperatorDecisionFencedWithCutover,
  type ActivityCutoverCallOpts, type ActivityCutoverOperation, type ActivityCutoverResult,
} from "./activity-cutover.js";
import type {
  ActivityAppendEventParams, ActivityAppendEventResult,
  ActivityListEventsParams, ActivityListEventsResult,
  ActivityListOperatorDecisionsParams, ActivityListOperatorDecisionsResult,
  ActivityResolveOperatorDecisionFencedParams, ActivityResolveOperatorDecisionFencedResult,
} from "./paperwork-engine-activity.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { ActivityCutoverIndeterminateError };
export type { ActivityCutoverOperation, ActivityCutoverResult };

/** 텔레메트리가 다루는 컷오버 대상 — 어댑터의 쓰기 2종 + 읽기 2종 전부. */
export type ActivityWiredOperation =
  ActivityCutoverOperation | "list_events" | "list_operator_decisions";

export type ActivityCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface ActivityCutoverTelemetryEvent {
  operation: ActivityWiredOperation;
  outcome: ActivityCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface ActivityCutoverOperationMetrics {
  rustSuccess: number;
  tsBypass: number;
  tsFallback: number;
  indeterminateError: number;
  tsError: number;
  fenceMismatch: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type ActivityCutoverMetricsSnapshot = Readonly<
  Record<ActivityWiredOperation, Readonly<ActivityCutoverOperationMetrics>>>;

export interface ActivityCutoverWiringOpts extends ActivityCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: ActivityCutoverTelemetryEvent) => void;
}

type Meter = Record<ActivityWiredOperation, ActivityCutoverOperationMetrics>;

const WIRED_OPS = [
  "append_event", "resolve_operator_decision_fenced",
  "list_events", "list_operator_decisions",
] as const satisfies readonly ActivityWiredOperation[];

const emptyOperationMetrics = (): ActivityCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  WIRED_OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): ActivityCutoverMetricsSnapshot => Object.fromEntries(
  WIRED_OPS.map((op) => [op, { ...meter[op] }])) as ActivityCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: ActivityWiredOperation;
  call: (client: PaperworkEngineClient, callOpts: ActivityCutoverCallOpts) => Promise<ActivityCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: ActivityCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<ActivityCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: ActivityCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "activity cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "activity cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<ActivityCutoverResult<T>> => {
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
  if (!isActivityEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine client resolution failed; bypassing to TS");
    return runTsBypass();
  }
  if (client === null) {
    safeWarn({ operation }, "paperwork-engine client unavailable; bypassing to TS");
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
    if (error instanceof ActivityCutoverIndeterminateError) {
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

type AdapterCall<P, T> = (
  client: PaperworkEngineClient, params: P,
  tsFallback: () => Promise<T>, callOpts: ActivityCutoverCallOpts,
) => Promise<ActivityCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: ActivityCutoverWiringOpts) => Promise<ActivityCutoverResult<T>>;

/** 엔진 fence/not-applied 결과 — 폴백 없이 반환하되 텔레메트리엔 fenceMismatch 로 집계. */
const resolveNotApplied = (v: ActivityResolveOperatorDecisionFencedResult) => v.updated === false;
const neverNotApplied = () => false;

function makeWiredOp<P, T>(
  operation: ActivityWiredOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, meter: Meter, defaults?: ActivityCutoverWiringOpts,
): WiredOp<P, T> {
  return (params, tsFallback, opts = {}) => executeCutover({
    operation,
    call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
    isFenceMismatch, tsFallback,
    opts: defaults ? { ...defaults, ...opts } : opts, meter,
  });
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getActivityCutoverMetrics(): ActivityCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetActivityCutoverMetricsForTests(): void {
  for (const op of WIRED_OPS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireAppendActivityEventCutover =
  makeWiredOp("append_event", appendActivityEventWithCutover, neverNotApplied, moduleMeter);
export const wireResolveOperatorDecisionFencedCutover =
  makeWiredOp("resolve_operator_decision_fenced", resolveOperatorDecisionFencedWithCutover, resolveNotApplied, moduleMeter);
export const wireListActivityEventsCutover =
  makeWiredOp("list_events", listActivityEventsWithCutover, neverNotApplied, moduleMeter);
export const wireListOperatorDecisionsCutover =
  makeWiredOp("list_operator_decisions", listOperatorDecisionsWithCutover, neverNotApplied, moduleMeter);

export interface ActivityCutoverHooks {
  appendEvent: typeof wireAppendActivityEventCutover;
  resolveOperatorDecisionFenced: typeof wireResolveOperatorDecisionFencedCutover;
  listEvents: typeof wireListActivityEventsCutover;
  listOperatorDecisions: typeof wireListOperatorDecisionsCutover;
  getMetrics: () => ActivityCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createActivityCutoverHooks(defaultOpts: ActivityCutoverWiringOpts = {}): ActivityCutoverHooks {
  const meter = emptyMeter();
  return {
    appendEvent: makeWiredOp("append_event", appendActivityEventWithCutover, neverNotApplied, meter, defaultOpts),
    resolveOperatorDecisionFenced: makeWiredOp("resolve_operator_decision_fenced", resolveOperatorDecisionFencedWithCutover, resolveNotApplied, meter, defaultOpts),
    listEvents: makeWiredOp("list_events", listActivityEventsWithCutover, neverNotApplied, meter, defaultOpts),
    listOperatorDecisions: makeWiredOp("list_operator_decisions", listOperatorDecisionsWithCutover, neverNotApplied, meter, defaultOpts),
    getMetrics: () => snapshotMeter(meter),
  };
}
