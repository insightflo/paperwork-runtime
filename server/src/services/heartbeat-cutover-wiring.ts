// [파일 목적] Wave 5c — heartbeat 쓰기(claim_wakeup / transition_run_fenced) 컷오버
//   배선 + 구조화 텔레메트리 계층. PAPERWORK_ENGINE_HEARTBEAT_CUTOVER=1(기본 OFF)일 때만
//   엔진 클라이언트를 해석해 컷오버 어댑터(paperwork-engine-heartbeat-cutover)에 위임하고,
//   그 외에는 TS 작성자를 그대로 호출한다. indeterminate 는 절대 TS 폴백 없이 전파하고,
//   fence mismatch(applied:false)는 폴백 없이 그대로 반환한다.
// [외부 연결] paperwork-engine-heartbeat-cutover(어댑터), paperwork-engine-runtime(공유
//   클라이언트), logger. 호출부(heartbeat.ts/heartbeat-queue-lifecycle.ts 후속 PR)는
//   createHeartbeatCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  claimWakeupWithCutover,
  HeartbeatCutoverIndeterminateError,
  isHeartbeatEngineCutoverEnabled,
  transitionRunFencedWithCutover,
  type HeartbeatCutoverCallOpts,
  type HeartbeatCutoverOperation,
  type HeartbeatCutoverResult,
  type HeartbeatTransitionRunFencedCutoverParams,
} from "./paperwork-engine-heartbeat-cutover.js";
import type {
  HeartbeatClaimWakeupParams,
  HeartbeatClaimedWakeup,
  HeartbeatTransitionRunFencedResult,
} from "./paperwork-engine-heartbeat.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { HeartbeatCutoverIndeterminateError };
export type {
  HeartbeatCutoverOperation,
  HeartbeatCutoverResult,
  HeartbeatTransitionRunFencedCutoverParams,
};

export type HeartbeatCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface HeartbeatCutoverTelemetryEvent {
  operation: HeartbeatCutoverOperation;
  outcome: HeartbeatCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface HeartbeatCutoverOperationMetrics {
  rustSuccess: number;
  tsBypass: number;
  tsFallback: number;
  indeterminateError: number;
  tsError: number;
  fenceMismatch: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type HeartbeatCutoverMetricsSnapshot = Readonly<
  Record<HeartbeatCutoverOperation, Readonly<HeartbeatCutoverOperationMetrics>>>;

export interface HeartbeatCutoverWiringOpts extends HeartbeatCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: HeartbeatCutoverTelemetryEvent) => void;
}

type Meter = Record<HeartbeatCutoverOperation, HeartbeatCutoverOperationMetrics>;

const emptyOperationMetrics = (): HeartbeatCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => ({
  claim_wakeup: emptyOperationMetrics(),
  transition_run_fenced: emptyOperationMetrics(),
});
const snapshotMeter = (meter: Meter): HeartbeatCutoverMetricsSnapshot => ({
  claim_wakeup: { ...meter.claim_wakeup },
  transition_run_fenced: { ...meter.transition_run_fenced },
});

interface CutoverJob<T> {
  operation: HeartbeatCutoverOperation;
  call: (
    client: PaperworkEngineClient, callOpts: HeartbeatCutoverCallOpts,
  ) => Promise<HeartbeatCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: HeartbeatCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<HeartbeatCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (
    outcome: HeartbeatCutoverOutcome,
    source: "rust" | "ts" | null,
    fenceMismatch: boolean,
    error?: unknown,
  ): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error });
    } catch (observerError) {
      logger.warn({ operation, err: observerError },
        "heartbeat cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 작성자를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<HeartbeatCutoverResult<T>> => {
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
  if (!isHeartbeatEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    logger.warn({ operation, err: error },
      "paperwork-engine client resolution failed; bypassing to TS");
    client = null;
  }
  if (client === null) return runTsBypass();

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
    if (error instanceof HeartbeatCutoverIndeterminateError) {
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
export function getHeartbeatCutoverMetrics(): HeartbeatCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetHeartbeatCutoverMetricsForTests(): void {
  moduleMeter.claim_wakeup = emptyOperationMetrics();
  moduleMeter.transition_run_fenced = emptyOperationMetrics();
}

export function wireClaimWakeupCutover(
  params: HeartbeatClaimWakeupParams,
  tsFallback: () => Promise<HeartbeatClaimedWakeup | null>,
  opts: HeartbeatCutoverWiringOpts = {},
): Promise<HeartbeatCutoverResult<HeartbeatClaimedWakeup | null>> {
  return executeCutover({
    operation: "claim_wakeup",
    call: (client, callOpts) => claimWakeupWithCutover(client, params, tsFallback, callOpts),
    isFenceMismatch: () => false,
    tsFallback, opts, meter: moduleMeter,
  });
}

export function wireTransitionRunFencedCutover(
  params: HeartbeatTransitionRunFencedCutoverParams,
  tsFallback: () => Promise<HeartbeatTransitionRunFencedResult>,
  opts: HeartbeatCutoverWiringOpts = {},
): Promise<HeartbeatCutoverResult<HeartbeatTransitionRunFencedResult>> {
  return executeCutover({
    operation: "transition_run_fenced",
    call: (client, callOpts) => transitionRunFencedWithCutover(client, params, tsFallback, callOpts),
    isFenceMismatch: (value) => value.applied === false,
    tsFallback, opts, meter: moduleMeter,
  });
}

export interface HeartbeatCutoverHooks {
  claimWakeup: typeof wireClaimWakeupCutover;
  transitionRunFenced: typeof wireTransitionRunFencedCutover;
  getMetrics: () => HeartbeatCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createHeartbeatCutoverHooks(
  defaultOpts: HeartbeatCutoverWiringOpts = {},
): HeartbeatCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: HeartbeatCutoverWiringOpts): HeartbeatCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  return {
    claimWakeup: (params, tsFallback, opts = {}) => executeCutover({
      operation: "claim_wakeup",
      call: (client, callOpts) => claimWakeupWithCutover(client, params, tsFallback, callOpts),
      isFenceMismatch: () => false,
      tsFallback, opts: merged(opts), meter,
    }),
    transitionRunFenced: (params, tsFallback, opts = {}) => executeCutover({
      operation: "transition_run_fenced",
      call: (client, callOpts) => transitionRunFencedWithCutover(client, params, tsFallback, callOpts),
      isFenceMismatch: (value) => value.applied === false,
      tsFallback, opts: merged(opts), meter,
    }),
    getMetrics: () => snapshotMeter(meter),
  };
}
