// [파일 목적] Wave 5 — schedule 쓰기(advance_fenced / set_enabled)·읽기(list_due) 컷오버 배선
//   + 구조화 텔레메트리 계층. PAPERWORK_ENGINE_SCHEDULE_CUTOVER=1(기본 OFF)일 때만 엔진
//   클라이언트를 해석해 컷오버 어댑터(paperwork-engine-schedule-cutover)에 위임하고, 그 외에는
//   TS 작성자/리더를 그대로 호출한다. indeterminate 는 절대 TS 폴백 없이 전파하고,
//   미적용(advance_fenced applied:false, set_enabled updated:false)은 폴백 없이 그대로
//   반환하면서 fenceMismatch 카운터로 집계한다. list_due 는 읽기라 indeterminate 가 없다.
// [외부 연결] paperwork-engine-schedule-cutover(어댑터), paperwork-engine-runtime(공유
//   클라이언트), logger. 호출부는 createScheduleCutoverHooks 로 opts 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  advanceFencedWithCutover, isScheduleEngineCutoverEnabled, listDueWithCutover,
  ScheduleCutoverIndeterminateError, setEnabledWithCutover,
  type ScheduleCutoverCallOpts, type ScheduleCutoverResult,
} from "./paperwork-engine-schedule-cutover.js";
import type {
  DueSchedule, ScheduleAdvanceFencedParams, ScheduleAdvanceFencedResult,
  ScheduleListDueParams, ScheduleSetEnabledParams, ScheduleSetEnabledResult,
} from "./paperwork-engine-schedule.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { ScheduleCutoverIndeterminateError };
export type { ScheduleCutoverResult };

/** 어댑터의 ScheduleCutoverOperation(쓰기 2종 — indeterminate 가능 작업)과 달리
 *  텔레메트리는 배선되는 3작업 전부를 키로 쓴다 — list_due 도 outcome 을 낸다. */
export type ScheduleCutoverOperation = "advance_fenced" | "set_enabled" | "list_due";

export type ScheduleCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface ScheduleCutoverTelemetryEvent {
  operation: ScheduleCutoverOperation;
  outcome: ScheduleCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface ScheduleCutoverOperationMetrics {
  rustSuccess: number; tsBypass: number; tsFallback: number; indeterminateError: number;
  tsError: number; fenceMismatch: number; totalCalls: number; totalDurationMs: number;
}

export type ScheduleCutoverMetricsSnapshot = Readonly<
  Record<ScheduleCutoverOperation, Readonly<ScheduleCutoverOperationMetrics>>>;

export interface ScheduleCutoverWiringOpts extends ScheduleCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: ScheduleCutoverTelemetryEvent) => void;
}

type Meter = Record<ScheduleCutoverOperation, ScheduleCutoverOperationMetrics>;
const OPERATIONS = ["advance_fenced", "set_enabled", "list_due"] as const;

const emptyOperationMetrics = (): ScheduleCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter =>
  Object.fromEntries(OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): ScheduleCutoverMetricsSnapshot =>
  Object.fromEntries(OPERATIONS.map((op) => [op, { ...meter[op] }])) as ScheduleCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function executeCutover<T>(job: {
  operation: ScheduleCutoverOperation;
  call: (
    client: PaperworkEngineClient, callOpts: ScheduleCutoverCallOpts,
  ) => Promise<ScheduleCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: ScheduleCutoverWiringOpts;
  meter: Meter;
}): Promise<ScheduleCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: ScheduleCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "schedule cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "schedule cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 작성자를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<ScheduleCutoverResult<T>> => {
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
  if (!isScheduleEngineCutoverEnabled(env)) return runTsBypass();

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
      "paperwork-engine client unavailable; bypassing to TS writer");
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
    if (error instanceof ScheduleCutoverIndeterminateError) {
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

/** 어댑터 함수 + 미적용 판정을 한 곳에 모은 작업 스펙 — wire* 와 훅이 같은 정의를 공유한다. */
interface OpSpec<P, T> {
  operation: ScheduleCutoverOperation;
  call: (client: PaperworkEngineClient, params: P, tsFallback: () => Promise<T>,
    callOpts: ScheduleCutoverCallOpts) => Promise<ScheduleCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
}

const advanceSpec: OpSpec<ScheduleAdvanceFencedParams, ScheduleAdvanceFencedResult> = {
  operation: "advance_fenced", call: advanceFencedWithCutover,
  isFenceMismatch: (value) => value.applied === false,
};
const enabledSpec: OpSpec<ScheduleSetEnabledParams, ScheduleSetEnabledResult> = {
  operation: "set_enabled", call: setEnabledWithCutover,
  isFenceMismatch: (value) => value.updated === false,
};
const dueSpec: OpSpec<ScheduleListDueParams, DueSchedule[]> = {
  operation: "list_due", call: listDueWithCutover, isFenceMismatch: () => false,
};

function runSpec<P, T>(
  spec: OpSpec<P, T>, params: P, tsFallback: () => Promise<T>,
  opts: ScheduleCutoverWiringOpts, meter: Meter,
): Promise<ScheduleCutoverResult<T>> {
  return executeCutover({
    operation: spec.operation,
    call: (client, callOpts) => spec.call(client, params, tsFallback, callOpts),
    isFenceMismatch: spec.isFenceMismatch,
    tsFallback, opts, meter,
  });
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getScheduleCutoverMetrics(): ScheduleCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetScheduleCutoverMetricsForTests(): void {
  for (const op of OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

export function wireAdvanceFencedCutover(
  params: ScheduleAdvanceFencedParams, tsFallback: () => Promise<ScheduleAdvanceFencedResult>,
  opts: ScheduleCutoverWiringOpts = {},
): Promise<ScheduleCutoverResult<ScheduleAdvanceFencedResult>> {
  return runSpec(advanceSpec, params, tsFallback, opts, moduleMeter);
}

export function wireSetEnabledCutover(
  params: ScheduleSetEnabledParams, tsFallback: () => Promise<ScheduleSetEnabledResult>,
  opts: ScheduleCutoverWiringOpts = {},
): Promise<ScheduleCutoverResult<ScheduleSetEnabledResult>> {
  return runSpec(enabledSpec, params, tsFallback, opts, moduleMeter);
}

export function wireListDueCutover(
  params: ScheduleListDueParams, tsFallback: () => Promise<DueSchedule[]>,
  opts: ScheduleCutoverWiringOpts = {},
): Promise<ScheduleCutoverResult<DueSchedule[]>> {
  return runSpec(dueSpec, params, tsFallback, opts, moduleMeter);
}

export interface ScheduleCutoverHooks {
  advanceFenced: typeof wireAdvanceFencedCutover;
  setEnabled: typeof wireSetEnabledCutover;
  listDue: typeof wireListDueCutover;
  getMetrics: () => ScheduleCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createScheduleCutoverHooks(
  defaultOpts: ScheduleCutoverWiringOpts = {},
): ScheduleCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: ScheduleCutoverWiringOpts): ScheduleCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  return {
    advanceFenced: (params, tsFallback, opts = {}) =>
      runSpec(advanceSpec, params, tsFallback, merged(opts), meter),
    setEnabled: (params, tsFallback, opts = {}) =>
      runSpec(enabledSpec, params, tsFallback, merged(opts), meter),
    listDue: (params, tsFallback, opts = {}) =>
      runSpec(dueSpec, params, tsFallback, merged(opts), meter),
    getMetrics: () => snapshotMeter(meter),
  };
}
