// [파일 목적] Phase 2P Wave 5 — wiki.* 컷오버(record_failure/search_relevant/
//   list/mark_resolved/close) 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_WIKI_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해
//   Wave 4 컷오버 어댑터(wiki-cutover)에 위임하고, 그 외에는 TS 작성자/리더를
//   그대로 호출한다. indeterminate 쓰기 오류는 절대 TS 폴백 없이
//   WikiCutoverIndeterminateError 로 전파한다.
// [외부 연결] wiki-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createWikiCutoverHooks 로 env/getClient/timeoutMs/onEvent 를
//   한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  closeEntryWithCutover,
  isWikiEngineCutoverEnabled,
  listWikiEntriesWithCutover,
  markResolvedWithCutover,
  recordFailureWithCutover,
  searchRelevantWithCutover,
  WikiCutoverIndeterminateError,
  type WikiCutoverCallOpts,
  type WikiCutoverOperation,
  type WikiCutoverResult,
} from "./wiki-cutover.js";
import type {
  WikiCloseResult,
  WikiEntryIdParams,
  WikiListParams,
  WikiListResult,
  WikiMarkResolvedResult,
  WikiRecordFailureParams,
  WikiRecordFailureResult,
  WikiSearchRelevantParams,
  WikiSearchRelevantResult,
} from "./paperwork-engine-wiki.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { WikiCutoverIndeterminateError };
export type { WikiCutoverCallOpts, WikiCutoverOperation, WikiCutoverResult };

/** 텔레메트리가 다루는 wiki.* 컷오버 대상 — RPC 메서드 접미사와 1:1 대응. */
export const WIKI_WIRED_OPERATIONS = [
  "record_failure", "search_relevant", "list", "mark_resolved", "close",
] as const;
export type WikiWiredOperation = (typeof WIKI_WIRED_OPERATIONS)[number];

export type WikiCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface WikiCutoverTelemetryEvent {
  operation: WikiWiredOperation;
  outcome: WikiCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  error?: unknown;
}

export interface WikiCutoverOperationMetrics {
  rustOk: number;
  fallback: number;
  indeterminate: number;
  tsBypass: number;
  tsError: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type WikiCutoverMetricsSnapshot = Readonly<
  Record<WikiWiredOperation, Readonly<WikiCutoverOperationMetrics>>>;

export interface WikiCutoverWiringOpts extends WikiCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: WikiCutoverTelemetryEvent) => void;
}

type Meter = Record<WikiWiredOperation, WikiCutoverOperationMetrics>;

const emptyOperationMetrics = (): WikiCutoverOperationMetrics => ({
  rustOk: 0,
  fallback: 0,
  indeterminate: 0,
  tsBypass: 0,
  tsError: 0,
  totalCalls: 0,
  totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  WIKI_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): WikiCutoverMetricsSnapshot => Object.fromEntries(
  WIKI_WIRED_OPERATIONS.map((op) => [op, { ...meter[op] }])) as WikiCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: WikiWiredOperation;
  call: (
    client: PaperworkEngineClient,
    callOpts: WikiCutoverCallOpts,
  ) => Promise<WikiCutoverResult<T>>;
  tsFallback: () => Promise<T>;
  opts: WikiCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<WikiCutoverResult<T>> {
  const { operation, call, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (
    outcome: WikiCutoverOutcome,
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
          "wiki cutover onEvent observer rejected; ignoring",
        ));
    } catch (observerError) {
      safeWarn(
        { operation, err: observerError },
        "wiki cutover onEvent observer threw; ignoring",
      );
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 ts_error 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<WikiCutoverResult<T>> => {
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
  if (!isWikiEngineCutoverEnabled(env)) return runTsBypass();

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
    if (error instanceof WikiCutoverIndeterminateError) {
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
  callOpts: WikiCutoverCallOpts,
) => Promise<WikiCutoverResult<T>>;
type WiredOp<P, T> = (
  params: P,
  tsFallback: () => Promise<T>,
  opts?: WikiCutoverWiringOpts,
) => Promise<WikiCutoverResult<T>>;

function makeWiredOp<P, T>(
  operation: WikiWiredOperation,
  adapterCall: AdapterCall<P, T>,
  meter: Meter,
  defaults?: WikiCutoverWiringOpts,
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
export function getWikiCutoverMetrics(): WikiCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetWikiCutoverMetricsForTests(): void {
  for (const op of WIKI_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireRecordFailureCutover =
  makeWiredOp("record_failure", recordFailureWithCutover, moduleMeter);
export const wireSearchRelevantCutover =
  makeWiredOp("search_relevant", searchRelevantWithCutover, moduleMeter);
export const wireListWikiEntriesCutover =
  makeWiredOp("list", listWikiEntriesWithCutover, moduleMeter);
export const wireMarkResolvedCutover =
  makeWiredOp("mark_resolved", markResolvedWithCutover, moduleMeter);
export const wireCloseEntryCutover =
  makeWiredOp("close", closeEntryWithCutover, moduleMeter);

export interface WikiCutoverHooks {
  recordFailure: typeof wireRecordFailureCutover;
  searchRelevant: typeof wireSearchRelevantCutover;
  listWikiEntries: typeof wireListWikiEntriesCutover;
  markResolved: typeof wireMarkResolvedCutover;
  closeEntry: typeof wireCloseEntryCutover;
  getMetrics: () => WikiCutoverMetricsSnapshot;
  snapshot: () => WikiCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅 묶음별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createWikiCutoverHooks(
  defaultOpts: WikiCutoverWiringOpts = {},
): WikiCutoverHooks {
  const meter = emptyMeter();
  const snapshot = () => snapshotMeter(meter);
  return {
    recordFailure: makeWiredOp("record_failure", recordFailureWithCutover, meter, defaultOpts),
    searchRelevant: makeWiredOp("search_relevant", searchRelevantWithCutover, meter, defaultOpts),
    listWikiEntries: makeWiredOp("list", listWikiEntriesWithCutover, meter, defaultOpts),
    markResolved: makeWiredOp("mark_resolved", markResolvedWithCutover, meter, defaultOpts),
    closeEntry: makeWiredOp("close", closeEntryWithCutover, meter, defaultOpts),
    getMetrics: snapshot,
    snapshot,
  };
}
