// [파일 목적] Wave 5 — budget.* 컷오버(record_cost_event/upsert_incident_fenced/
//   resolve_incident_fenced/sum_scope_spend/list_active_policies) 배선 + 구조화
//   텔레메트리 계층. PAPERWORK_ENGINE_BUDGET_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를
//   해석해 컷오버 어댑터(paperwork-engine-budget-cutover)에 위임하고, 그 외에는 TS
//   작성자/리더를 그대로 호출한다. indeterminate 쓰기 오류는 절대 TS 폴백 없이
//   BudgetCutoverIndeterminateError 로 전파하고, fence not-applied 결과
//   (recorded/upserted/resolved:false)는 폴백 없이 그대로 반환한다.
// [외부 연결] paperwork-engine-budget-cutover(어댑터), paperwork-engine-runtime(공유
//   클라이언트), logger. 호출부는 createBudgetCutoverHooks 로 env/getClient/timeoutMs/
//   onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  BudgetCutoverIndeterminateError, isBudgetEngineCutoverEnabled,
  listActivePoliciesWithCutover, recordCostEventWithCutover,
  resolveIncidentFencedWithCutover, sumScopeSpendWithCutover,
  upsertIncidentFencedWithCutover,
  type BudgetCutoverCallOpts, type BudgetCutoverOperation, type BudgetCutoverResult,
} from "./paperwork-engine-budget-cutover.js";
import type {
  BudgetPolicy, BudgetRecordCostEventParams, BudgetRecordCostEventResult,
  BudgetResolveIncidentFencedParams, BudgetResolveIncidentFencedResult,
  BudgetScopeParams, BudgetSumScopeSpendParams, BudgetSumScopeSpendResult,
  BudgetUpsertIncidentFencedParams, BudgetUpsertIncidentFencedResult,
} from "./paperwork-engine-budget.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { BudgetCutoverIndeterminateError };
export type { BudgetCutoverOperation, BudgetCutoverResult };

/** 텔레메트리가 다루는 컷오버 대상 — 어댑터의 쓰기 3종 + 읽기 2종 전부. */
export type BudgetWiredOperation =
  BudgetCutoverOperation | "sum_scope_spend" | "list_active_policies";

export type BudgetCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface BudgetCutoverTelemetryEvent {
  operation: BudgetWiredOperation;
  outcome: BudgetCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface BudgetCutoverOperationMetrics {
  rustSuccess: number;
  tsBypass: number;
  tsFallback: number;
  indeterminateError: number;
  tsError: number;
  fenceMismatch: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type BudgetCutoverMetricsSnapshot = Readonly<
  Record<BudgetWiredOperation, Readonly<BudgetCutoverOperationMetrics>>>;

export interface BudgetCutoverWiringOpts extends BudgetCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: BudgetCutoverTelemetryEvent) => void;
}

type Meter = Record<BudgetWiredOperation, BudgetCutoverOperationMetrics>;

const WIRED_OPS = [
  "record_cost_event", "upsert_incident_fenced", "resolve_incident_fenced",
  "sum_scope_spend", "list_active_policies",
] as const satisfies readonly BudgetWiredOperation[];

const emptyOperationMetrics = (): BudgetCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  WIRED_OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): BudgetCutoverMetricsSnapshot => Object.fromEntries(
  WIRED_OPS.map((op) => [op, { ...meter[op] }])) as BudgetCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: BudgetWiredOperation;
  call: (client: PaperworkEngineClient, callOpts: BudgetCutoverCallOpts) => Promise<BudgetCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: BudgetCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<BudgetCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: BudgetCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "budget cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "budget cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<BudgetCutoverResult<T>> => {
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
  if (!isBudgetEngineCutoverEnabled(env)) return runTsBypass();

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
    if (error instanceof BudgetCutoverIndeterminateError) {
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
  tsFallback: () => Promise<T>, callOpts: BudgetCutoverCallOpts,
) => Promise<BudgetCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: BudgetCutoverWiringOpts) => Promise<BudgetCutoverResult<T>>;

/** 엔진 fence/not-applied 결과 — 폴백 없이 반환하되 텔레메트리엔 fenceMismatch 로 집계. */
const costNotApplied = (v: BudgetRecordCostEventResult) => v.recorded === false;
const upsertNotApplied = (v: BudgetUpsertIncidentFencedResult) => v.upserted === false;
const resolveNotApplied = (v: BudgetResolveIncidentFencedResult) => v.resolved === false;
const neverNotApplied = () => false;

function makeWiredOp<P, T>(
  operation: BudgetWiredOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, meter: Meter, defaults?: BudgetCutoverWiringOpts,
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
export function getBudgetCutoverMetrics(): BudgetCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetBudgetCutoverMetricsForTests(): void {
  for (const op of WIRED_OPS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireRecordCostEventCutover =
  makeWiredOp("record_cost_event", recordCostEventWithCutover, costNotApplied, moduleMeter);
export const wireUpsertIncidentFencedCutover =
  makeWiredOp("upsert_incident_fenced", upsertIncidentFencedWithCutover, upsertNotApplied, moduleMeter);
export const wireResolveIncidentFencedCutover =
  makeWiredOp("resolve_incident_fenced", resolveIncidentFencedWithCutover, resolveNotApplied, moduleMeter);
export const wireSumScopeSpendCutover =
  makeWiredOp("sum_scope_spend", sumScopeSpendWithCutover, neverNotApplied, moduleMeter);
export const wireListActivePoliciesCutover =
  makeWiredOp("list_active_policies", listActivePoliciesWithCutover, neverNotApplied, moduleMeter);

export interface BudgetCutoverHooks {
  recordCostEvent: typeof wireRecordCostEventCutover;
  upsertIncidentFenced: typeof wireUpsertIncidentFencedCutover;
  resolveIncidentFenced: typeof wireResolveIncidentFencedCutover;
  sumScopeSpend: typeof wireSumScopeSpendCutover;
  listActivePolicies: typeof wireListActivePoliciesCutover;
  getMetrics: () => BudgetCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createBudgetCutoverHooks(defaultOpts: BudgetCutoverWiringOpts = {}): BudgetCutoverHooks {
  const meter = emptyMeter();
  return {
    recordCostEvent: makeWiredOp("record_cost_event", recordCostEventWithCutover, costNotApplied, meter, defaultOpts),
    upsertIncidentFenced: makeWiredOp("upsert_incident_fenced", upsertIncidentFencedWithCutover, upsertNotApplied, meter, defaultOpts),
    resolveIncidentFenced: makeWiredOp("resolve_incident_fenced", resolveIncidentFencedWithCutover, resolveNotApplied, meter, defaultOpts),
    sumScopeSpend: makeWiredOp("sum_scope_spend", sumScopeSpendWithCutover, neverNotApplied, meter, defaultOpts),
    listActivePolicies: makeWiredOp("list_active_policies", listActivePoliciesWithCutover, neverNotApplied, meter, defaultOpts),
    getMetrics: () => snapshotMeter(meter),
  };
}
