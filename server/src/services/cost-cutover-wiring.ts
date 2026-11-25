// [파일 목적] Phase 2M Wave 5 — cost.* 컷오버(record_event/list_events/
//   summarize_window/get_spend_snapshot) 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_COST_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해
//   Wave 4 컷오버 어댑터(cost-cutover)에 위임하고, 그 외에는 TS 작성자/리더를
//   그대로 호출한다. indeterminate 쓰기 오류는 절대 TS 폴백 없이
//   CostCutoverIndeterminateError 로 전파한다.
// [외부 연결] cost-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createCostCutoverHooks 로 env/getClient/timeoutMs/onEvent 를
//   한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import {
  CostCutoverIndeterminateError, getCostSpendSnapshotWithCutover,
  isCostEngineCutoverEnabled, listCostEventsWithCutover,
  recordCostEventWithCutover, summarizeCostWindowWithCutover,
  type CostCutoverCallOpts, type CostCutoverResult,
} from "./cost-cutover.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { CostCutoverIndeterminateError };
export type { CostCutoverCallOpts, CostCutoverResult };

/** 텔레메트리가 다루는 컷오버 대상 — 어댑터의 쓰기 1종 + 읽기 3종 전부. */
export const COST_WIRED_OPERATIONS = [
  "record_event", "list_events", "summarize_window", "get_spend_snapshot",
] as const;
export type CostWiredOperation = (typeof COST_WIRED_OPERATIONS)[number];

export type CostCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface CostCutoverTelemetryEvent {
  operation: CostWiredOperation;
  outcome: CostCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  error?: unknown;
}

export interface CostCutoverOperationMetrics {
  rustOk: number;
  fallback: number;
  indeterminate: number;
  tsBypass: number;
  tsError: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type CostCutoverMetricsSnapshot = Readonly<
  Record<CostWiredOperation, Readonly<CostCutoverOperationMetrics>>>;

/** 공유 엔진 클라이언트 타입은 런타임 해석기의 반환 타입에서 파생한다. */
type SharedEngineClient = NonNullable<ReturnType<typeof getSharedPaperworkEngineClient>>;

export interface CostCutoverWiringOpts extends CostCutoverCallOpts {
  getClient?: () => SharedEngineClient | null;
  onEvent?: (event: CostCutoverTelemetryEvent) => void;
}

type Meter = Record<CostWiredOperation, CostCutoverOperationMetrics>;

const emptyOperationMetrics = (): CostCutoverOperationMetrics => ({
  rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0,
  tsError: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  COST_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): CostCutoverMetricsSnapshot => Object.fromEntries(
  COST_WIRED_OPERATIONS.map((op) => [op, { ...meter[op] }])) as CostCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: CostWiredOperation;
  call: (
    client: SharedEngineClient, callOpts: CostCutoverCallOpts,
  ) => Promise<CostCutoverResult<T>>;
  tsFallback: () => Promise<T>;
  opts: CostCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<CostCutoverResult<T>> {
  const { operation, call, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: CostCutoverOutcome, source: "rust" | "ts" | null,
    error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "cost cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "cost cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<CostCutoverResult<T>> => {
    metrics.tsBypass += 1;
    try {
      const value = await tsFallback();
      emit("ts_bypass", "ts");
      return { source: "ts", value };
    } catch (error) {
      metrics.tsError += 1;
      emit("ts_error", "ts", error);
      throw error;
    }
  };

  const env = opts.env ?? process.env;
  if (!isCostEngineCutoverEnabled(env)) return runTsBypass();

  let client: SharedEngineClient | null;
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
    if (result.source === "rust") {
      metrics.rustOk += 1;
      emit("rust_ok", "rust");
    } else {
      metrics.fallback += 1;
      emit("fallback", "ts");
    }
    return result;
  } catch (error) {
    if (error instanceof CostCutoverIndeterminateError) {
      metrics.indeterminate += 1;
      emit("indeterminate", null, error);
    } else {
      // 어댑터가 던지는 비-indeterminate 오류는 tsFallback 자체의 실패다.
      metrics.tsError += 1;
      emit("ts_error", null, error);
    }
    throw error;
  }
}

type AdapterCall<P, T> = (
  client: SharedEngineClient, params: P,
  tsFallback: () => Promise<T>, callOpts: CostCutoverCallOpts,
) => Promise<CostCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: CostCutoverWiringOpts) => Promise<CostCutoverResult<T>>;

function makeWiredOp<P, T>(
  operation: CostWiredOperation, adapterCall: AdapterCall<P, T>,
  meter: Meter, defaults?: CostCutoverWiringOpts,
): WiredOp<P, T> {
  return (params, tsFallback, opts = {}) => executeCutover({
    operation,
    call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
    tsFallback,
    opts: defaults ? { ...defaults, ...opts } : opts, meter,
  });
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getCostCutoverMetrics(): CostCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetCostCutoverMetricsForTests(): void {
  for (const op of COST_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireRecordCostEventCutover =
  makeWiredOp("record_event", recordCostEventWithCutover, moduleMeter);
export const wireListCostEventsCutover =
  makeWiredOp("list_events", listCostEventsWithCutover, moduleMeter);
export const wireSummarizeCostWindowCutover =
  makeWiredOp("summarize_window", summarizeCostWindowWithCutover, moduleMeter);
export const wireGetCostSpendSnapshotCutover =
  makeWiredOp("get_spend_snapshot", getCostSpendSnapshotWithCutover, moduleMeter);

export interface CostCutoverHooks {
  recordCostEvent: typeof wireRecordCostEventCutover;
  listCostEvents: typeof wireListCostEventsCutover;
  summarizeCostWindow: typeof wireSummarizeCostWindowCutover;
  getCostSpendSnapshot: typeof wireGetCostSpendSnapshotCutover;
  getMetrics: () => CostCutoverMetricsSnapshot;
  snapshot: () => CostCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createCostCutoverHooks(
  defaultOpts: CostCutoverWiringOpts = {},
): CostCutoverHooks {
  const meter = emptyMeter();
  const snapshot = () => snapshotMeter(meter);
  return {
    recordCostEvent: makeWiredOp("record_event", recordCostEventWithCutover, meter, defaultOpts),
    listCostEvents: makeWiredOp("list_events", listCostEventsWithCutover, meter, defaultOpts),
    summarizeCostWindow: makeWiredOp("summarize_window", summarizeCostWindowWithCutover, meter, defaultOpts),
    getCostSpendSnapshot: makeWiredOp("get_spend_snapshot", getCostSpendSnapshotWithCutover, meter, defaultOpts),
    getMetrics: snapshot,
    snapshot,
  };
}
