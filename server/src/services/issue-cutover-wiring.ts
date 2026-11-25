// [파일 목적] Phase 2G Wave 5 — issue.* 컷오버(checkout_fenced/
//   transition_status_fenced/release_checkout_fenced 쓰기 + get/list_by_company/
//   list_issue_work_products 읽기) 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_ISSUE_CUTOVER=1(기본 OFF)일 때만 공유 엔진 클라이언트를
//   해석해 컷오버 어댑터(issue-cutover)에 위임하고, 그 외에는 TS 경로를 그대로
//   호출한다. indeterminate 쓰기 오류는 절대 TS 폴백 없이
//   IssueCutoverIndeterminateError 로 전파하고, fence 미적용({applied:false})은
//   성공 결과로 집계만 하며 폴백하지 않는다.
// [외부 연결] issue-cutover(어댑터), paperwork-engine-issue(타입),
//   paperwork-engine-runtime(공유 클라이언트), logger. 호출부는
//   createIssueCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  checkoutIssueFencedWithCutover, getIssueWithCutover,
  IssueCutoverIndeterminateError, isIssueEngineCutoverEnabled,
  listIssueWorkProductsWithCutover, listIssuesByCompanyWithCutover,
  releaseIssueCheckoutFencedWithCutover, transitionIssueStatusFencedWithCutover,
  type IssueCutoverCallOpts, type IssueCutoverOperation, type IssueCutoverResult,
} from "./issue-cutover.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { IssueCutoverIndeterminateError };
export type { IssueCutoverCallOpts, IssueCutoverOperation, IssueCutoverResult };

/** 텔레메트리가 다루는 issue.* 컷오버 대상 — 어댑터의 쓰기 3종 + 읽기 3종 전부. */
export type IssueWiredOperation =
  IssueCutoverOperation | "get" | "list_by_company" | "list_issue_work_products";

export type IssueCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface IssueCutoverTelemetryEvent {
  operation: IssueWiredOperation;
  outcome: IssueCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface IssueCutoverOperationMetrics {
  rustSuccess: number;
  tsBypass: number;
  tsFallback: number;
  indeterminateError: number;
  tsError: number;
  fenceMismatch: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type IssueCutoverMetricsSnapshot = Readonly<
  Record<IssueWiredOperation, Readonly<IssueCutoverOperationMetrics>>>;

export interface IssueCutoverWiringOpts extends IssueCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: IssueCutoverTelemetryEvent) => void;
}

type Meter = Record<IssueWiredOperation, IssueCutoverOperationMetrics>;

const WIRED_OPS = [
  "checkout_fenced", "transition_status_fenced", "release_checkout_fenced",
  "get", "list_by_company", "list_issue_work_products",
] as const satisfies readonly IssueWiredOperation[];

const emptyOperationMetrics = (): IssueCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  WIRED_OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): IssueCutoverMetricsSnapshot => Object.fromEntries(
  WIRED_OPS.map((op) => [op, { ...meter[op] }])) as IssueCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: IssueWiredOperation;
  call: (client: PaperworkEngineClient, callOpts: IssueCutoverCallOpts) => Promise<IssueCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: IssueCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<IssueCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: IssueCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "issue cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "issue cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<IssueCutoverResult<T>> => {
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
  if (!isIssueEngineCutoverEnabled(env)) return runTsBypass();

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
    if (error instanceof IssueCutoverIndeterminateError) {
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
  tsFallback: () => Promise<T>, callOpts: IssueCutoverCallOpts,
) => Promise<IssueCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: IssueCutoverWiringOpts) => Promise<IssueCutoverResult<T>>;

/** 엔진 fence/not-applied 결과({applied:false,reason}) — 폴백 없이 반환하되 fenceMismatch 로 집계. */
const appliedFalse = (v: { applied: boolean }): boolean => v.applied === false;
const neverFenceMismatch = (): boolean => false;

function makeWiredOp<P, T>(
  operation: IssueWiredOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, meter: Meter, defaults?: IssueCutoverWiringOpts,
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
export function getIssueCutoverMetrics(): IssueCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetIssueCutoverMetricsForTests(): void {
  for (const op of WIRED_OPS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireIssueCheckoutFencedCutover =
  makeWiredOp("checkout_fenced", checkoutIssueFencedWithCutover, appliedFalse, moduleMeter);
export const wireIssueTransitionStatusFencedCutover =
  makeWiredOp("transition_status_fenced", transitionIssueStatusFencedWithCutover, appliedFalse, moduleMeter);
export const wireIssueReleaseCheckoutFencedCutover =
  makeWiredOp("release_checkout_fenced", releaseIssueCheckoutFencedWithCutover, appliedFalse, moduleMeter);
export const wireIssueGetCutover =
  makeWiredOp("get", getIssueWithCutover, neverFenceMismatch, moduleMeter);
export const wireIssueListByCompanyCutover =
  makeWiredOp("list_by_company", listIssuesByCompanyWithCutover, neverFenceMismatch, moduleMeter);
export const wireIssueListWorkProductsCutover =
  makeWiredOp("list_issue_work_products", listIssueWorkProductsWithCutover, neverFenceMismatch, moduleMeter);

export interface IssueCutoverHooks {
  checkoutFenced: typeof wireIssueCheckoutFencedCutover;
  transitionStatusFenced: typeof wireIssueTransitionStatusFencedCutover;
  releaseCheckoutFenced: typeof wireIssueReleaseCheckoutFencedCutover;
  get: typeof wireIssueGetCutover;
  listByCompany: typeof wireIssueListByCompanyCutover;
  listWorkProducts: typeof wireIssueListWorkProductsCutover;
  getMetrics: () => IssueCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createIssueCutoverHooks(defaultOpts: IssueCutoverWiringOpts = {}): IssueCutoverHooks {
  const meter = emptyMeter();
  return {
    checkoutFenced: makeWiredOp("checkout_fenced", checkoutIssueFencedWithCutover, appliedFalse, meter, defaultOpts),
    transitionStatusFenced: makeWiredOp("transition_status_fenced", transitionIssueStatusFencedWithCutover, appliedFalse, meter, defaultOpts),
    releaseCheckoutFenced: makeWiredOp("release_checkout_fenced", releaseIssueCheckoutFencedWithCutover, appliedFalse, meter, defaultOpts),
    get: makeWiredOp("get", getIssueWithCutover, neverFenceMismatch, meter, defaultOpts),
    listByCompany: makeWiredOp("list_by_company", listIssuesByCompanyWithCutover, neverFenceMismatch, meter, defaultOpts),
    listWorkProducts: makeWiredOp("list_issue_work_products", listIssueWorkProductsWithCutover, neverFenceMismatch, meter, defaultOpts),
    getMetrics: () => snapshotMeter(meter),
  };
}
