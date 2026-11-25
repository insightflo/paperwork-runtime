// [파일 목적] Phase 2O Wave 5 — decision.* 컷오버(create/resolve/cancel/list/
//   get_by_id/get_by_request_key) 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_DECISION_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해
//   컷오버 어댑터(decision-cutover)에 위임하고, 그 외에는 TS 작성자/리더를 그대로
//   호출한다. indeterminate 쓰기 오류는 절대 TS 폴백 없이
//   DecisionCutoverIndeterminateError 로 전파한다.
// [외부 연결] decision-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createDecisionCutoverHooks 로 env/getClient/timeoutMs/onEvent 를
//   한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  cancelDecisionWithCutover,
  createDecisionWithCutover,
  DecisionCutoverIndeterminateError,
  getDecisionByIdWithCutover,
  getDecisionByRequestKeyWithCutover,
  isDecisionEngineCutoverEnabled,
  listDecisionsWithCutover,
  resolveDecisionWithCutover,
  type DecisionCutoverCallOpts,
  type DecisionCutoverOperation,
  type DecisionCutoverResult,
} from "./decision-cutover.js";
import type {
  DecisionCancelParams,
  DecisionCancelResult,
  DecisionCreateParams,
  DecisionCreateResult,
  DecisionGetByIdParams,
  DecisionGetByKeyParams,
  DecisionGetResult,
  DecisionListParams,
  DecisionResolveParams,
  DecisionResolveResult,
  DecisionRow,
} from "./paperwork-engine-decision.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { DecisionCutoverIndeterminateError };
export type { DecisionCutoverCallOpts, DecisionCutoverOperation, DecisionCutoverResult };

export const DECISION_WIRED_OPERATIONS = [
  "create", "resolve", "cancel", "list", "get_by_id", "get_by_request_key",
] as const;
export type DecisionWiredOperation = (typeof DECISION_WIRED_OPERATIONS)[number];

export type DecisionCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface DecisionCutoverTelemetryEvent {
  operation: DecisionWiredOperation;
  outcome: DecisionCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  error?: unknown;
}

export interface DecisionCutoverOperationMetrics {
  rustOk: number;
  fallback: number;
  indeterminate: number;
  tsBypass: number;
  tsError: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type DecisionCutoverMetricsSnapshot = Readonly<
  Record<DecisionWiredOperation, Readonly<DecisionCutoverOperationMetrics>>>;

export interface DecisionCutoverWiringOpts extends DecisionCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: DecisionCutoverTelemetryEvent) => void;
}

type Meter = Record<DecisionWiredOperation, DecisionCutoverOperationMetrics>;

const emptyOperationMetrics = (): DecisionCutoverOperationMetrics => ({
  rustOk: 0,
  fallback: 0,
  indeterminate: 0,
  tsBypass: 0,
  tsError: 0,
  totalCalls: 0,
  totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  DECISION_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): DecisionCutoverMetricsSnapshot => Object.fromEntries(
  DECISION_WIRED_OPERATIONS.map((op) => [op, { ...meter[op] }])) as DecisionCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: DecisionWiredOperation;
  call: (
    client: PaperworkEngineClient,
    callOpts: DecisionCutoverCallOpts,
  ) => Promise<DecisionCutoverResult<T>>;
  tsFallback: () => Promise<T>;
  opts: DecisionCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<DecisionCutoverResult<T>> {
  const { operation, call, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (
    outcome: DecisionCutoverOutcome,
    source: "rust" | "ts" | null,
    error?: unknown,
  ): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, error }))
        .catch((observerError) => safeWarn(
          { operation, err: observerError },
          "decision cutover onEvent observer rejected; ignoring",
        ));
    } catch (observerError) {
      safeWarn(
        { operation, err: observerError },
        "decision cutover onEvent observer threw; ignoring",
      );
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 ts_error 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<DecisionCutoverResult<T>> => {
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
  if (!isDecisionEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn(
      { operation, err: error },
      "paperwork-engine client resolution failed; bypassing to TS",
    );
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
    if (error instanceof DecisionCutoverIndeterminateError) {
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
  client: PaperworkEngineClient,
  params: P,
  tsFallback: () => Promise<T>,
  callOpts: DecisionCutoverCallOpts,
) => Promise<DecisionCutoverResult<T>>;
type WiredOp<P, T> = (
  params: P,
  tsFallback: () => Promise<T>,
  opts?: DecisionCutoverWiringOpts,
) => Promise<DecisionCutoverResult<T>>;

function makeWiredOp<P, T>(
  operation: DecisionWiredOperation,
  adapterCall: AdapterCall<P, T>,
  meter: Meter,
  defaults?: DecisionCutoverWiringOpts,
): WiredOp<P, T> {
  return (params, tsFallback, opts = {}) => executeCutover({
    operation,
    call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
    tsFallback,
    opts: defaults ? { ...defaults, ...opts } : opts,
    meter,
  });
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getDecisionCutoverMetrics(): DecisionCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetDecisionCutoverMetricsForTests(): void {
  for (const op of DECISION_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireCreateDecisionCutover =
  makeWiredOp("create", createDecisionWithCutover, moduleMeter);
export const wireResolveDecisionCutover =
  makeWiredOp("resolve", resolveDecisionWithCutover, moduleMeter);
export const wireCancelDecisionCutover =
  makeWiredOp("cancel", cancelDecisionWithCutover, moduleMeter);
export const wireListDecisionsCutover =
  makeWiredOp("list", listDecisionsWithCutover, moduleMeter);
export const wireGetDecisionByIdCutover =
  makeWiredOp("get_by_id", getDecisionByIdWithCutover, moduleMeter);
export const wireGetDecisionByRequestKeyCutover =
  makeWiredOp("get_by_request_key", getDecisionByRequestKeyWithCutover, moduleMeter);

export interface DecisionCutoverHooks {
  createDecision: typeof wireCreateDecisionCutover;
  resolveDecision: typeof wireResolveDecisionCutover;
  cancelDecision: typeof wireCancelDecisionCutover;
  listDecisions: typeof wireListDecisionsCutover;
  getDecisionById: typeof wireGetDecisionByIdCutover;
  getDecisionByRequestKey: typeof wireGetDecisionByRequestKeyCutover;
  getMetrics: () => DecisionCutoverMetricsSnapshot;
  snapshot: () => DecisionCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅 묶음별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createDecisionCutoverHooks(
  defaultOpts: DecisionCutoverWiringOpts = {},
): DecisionCutoverHooks {
  const meter = emptyMeter();
  const snapshot = () => snapshotMeter(meter);
  return {
    createDecision: makeWiredOp("create", createDecisionWithCutover, meter, defaultOpts),
    resolveDecision: makeWiredOp("resolve", resolveDecisionWithCutover, meter, defaultOpts),
    cancelDecision: makeWiredOp("cancel", cancelDecisionWithCutover, meter, defaultOpts),
    listDecisions: makeWiredOp("list", listDecisionsWithCutover, meter, defaultOpts),
    getDecisionById: makeWiredOp("get_by_id", getDecisionByIdWithCutover, meter, defaultOpts),
    getDecisionByRequestKey: makeWiredOp(
      "get_by_request_key", getDecisionByRequestKeyWithCutover, meter, defaultOpts),
    getMetrics: snapshot,
    snapshot,
  };
}
