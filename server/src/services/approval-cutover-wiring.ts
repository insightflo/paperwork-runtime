// [파일 목적] Phase 2E Wave 5 — approval.* 컷오버 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_ENGINE_APPROVAL_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해
//   컷오버 어댑터(paperwork-engine-approval-cutover)에 위임하고, 그 외에는 TS 경로를
//   그대로 호출한다. 쓰기 indeterminate 는 절대 TS 폴백 없이 전파하고, 커밋되지 않은
//   결과(created:false · updated:false · not_found_or_conflict)는 fenceMismatch 로 집계한다.
// [외부 연결] paperwork-engine-approval-cutover(어댑터), paperwork-engine-runtime(공유
//   클라이언트), logger. 호출부는 createApprovalCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  ApprovalCutoverIndeterminateError, cancelApprovalFencedWithCutover,
  createApprovalWithCutover, getApprovalWithCutover, isApprovalEngineCutoverEnabled,
  listApprovalsWithCutover, requestApprovalRevisionFencedWithCutover,
  resubmitApprovalFencedWithCutover, resolveApprovalFencedWithCutover,
  type ApprovalCutoverCallOpts, type ApprovalCutoverOperation, type ApprovalCutoverResult,
} from "./paperwork-engine-approval-cutover.js";
import type {
  Approval, ApprovalCreateParams, ApprovalCreateResult, ApprovalListParams,
  ApprovalResolveParams, ApprovalResolveResult, ApprovalResubmitParams,
  ApprovalRevisionParams, ApprovalScopedParams, ApprovalUpdatedResult,
} from "./paperwork-engine-approval.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { ApprovalCutoverIndeterminateError, type ApprovalCutoverOperation, type ApprovalCutoverResult };

/** 배선이 추적하는 전체 연산 — 어댑터 쓰기 5종 + 읽기(get/list) 2종. */
export type ApprovalCutoverWiringOperation = ApprovalCutoverOperation | "get" | "list";

export type ApprovalCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface ApprovalCutoverTelemetryEvent {
  operation: ApprovalCutoverWiringOperation;
  outcome: ApprovalCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface ApprovalCutoverOperationMetrics {
  rustSuccess: number; tsBypass: number; tsFallback: number; indeterminateError: number;
  tsError: number; fenceMismatch: number; totalCalls: number; totalDurationMs: number;
}

export type ApprovalCutoverMetricsSnapshot = Readonly<
  Record<ApprovalCutoverWiringOperation, Readonly<ApprovalCutoverOperationMetrics>>>;

export interface ApprovalCutoverWiringOpts extends ApprovalCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: ApprovalCutoverTelemetryEvent) => void;
}

type Meter = Record<ApprovalCutoverWiringOperation, ApprovalCutoverOperationMetrics>;
const OPS: readonly ApprovalCutoverWiringOperation[] = [
  "create", "resolve_fenced", "request_revision_fenced", "resubmit_fenced", "cancel_fenced", "get", "list",
];
const emptyOperationMetrics = (): ApprovalCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter =>
  Object.fromEntries(OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): ApprovalCutoverMetricsSnapshot =>
  Object.fromEntries(OPS.map((op) => [op, { ...meter[op] }])) as ApprovalCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try { logger.warn(context, message); } catch {
    // Best-effort logging: hostile Error getters must never mask cutover outcomes.
  }
}

async function executeCutover<T>(job: {
  operation: ApprovalCutoverWiringOperation;
  call: (client: PaperworkEngineClient, callOpts: ApprovalCutoverCallOpts)
    => Promise<ApprovalCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: ApprovalCutoverWiringOpts;
  meter: Meter;
}): Promise<ApprovalCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: ApprovalCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((e) => safeWarn({ operation, err: e }, "approval cutover onEvent rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError }, "approval cutover onEvent threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<ApprovalCutoverResult<T>> => {
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
  if (!isApprovalEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ operation, err: error }, "client resolution failed; bypassing to TS");
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
    if (error instanceof ApprovalCutoverIndeterminateError) {
      metrics.indeterminateError += 1;
      emit("indeterminate_error", null, false, error);
    } else { // 비-indeterminate 오류는 tsFallback 자체의 실패다.
      metrics.tsError += 1;
      emit("ts_error", null, false, error);
    }
    throw error;
  }
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getApprovalCutoverMetrics(): ApprovalCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetApprovalCutoverMetricsForTests(): void {
  for (const op of OPS) moduleMeter[op] = emptyOperationMetrics();
}

type AdapterCall<P, T> = (
  client: PaperworkEngineClient, params: P,
  tsFallback: () => Promise<T>, callOpts: ApprovalCutoverCallOpts,
) => Promise<ApprovalCutoverResult<T>>;
const job = <P, T>(
  operation: ApprovalCutoverWiringOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, params: P,
  tsFallback: () => Promise<T>, opts: ApprovalCutoverWiringOpts, meter: Meter,
): Promise<ApprovalCutoverResult<T>> => executeCutover({
  operation, isFenceMismatch, tsFallback, opts, meter,
  call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
});

export function wireCreateApprovalCutover(
  params: ApprovalCreateParams, tsFallback: () => Promise<ApprovalCreateResult>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<ApprovalCreateResult>> {
  return job("create", createApprovalWithCutover,
    (v) => v.created === false, params, tsFallback, opts, moduleMeter);
}
export function wireResolveApprovalFencedCutover(
  params: ApprovalResolveParams, tsFallback: () => Promise<ApprovalResolveResult>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<ApprovalResolveResult>> {
  return job("resolve_fenced", resolveApprovalFencedWithCutover,
    (v) => v.outcome === "not_found_or_conflict", params, tsFallback, opts, moduleMeter);
}
export function wireRequestApprovalRevisionFencedCutover(
  params: ApprovalRevisionParams, tsFallback: () => Promise<ApprovalUpdatedResult>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<ApprovalUpdatedResult>> {
  return job("request_revision_fenced", requestApprovalRevisionFencedWithCutover,
    (v) => v.updated === false, params, tsFallback, opts, moduleMeter);
}
export function wireResubmitApprovalFencedCutover(
  params: ApprovalResubmitParams, tsFallback: () => Promise<ApprovalUpdatedResult>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<ApprovalUpdatedResult>> {
  return job("resubmit_fenced", resubmitApprovalFencedWithCutover,
    (v) => v.updated === false, params, tsFallback, opts, moduleMeter);
}
export function wireCancelApprovalFencedCutover(
  params: ApprovalScopedParams, tsFallback: () => Promise<ApprovalUpdatedResult>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<ApprovalUpdatedResult>> {
  return job("cancel_fenced", cancelApprovalFencedWithCutover,
    (v) => v.updated === false, params, tsFallback, opts, moduleMeter);
}
export function wireGetApprovalCutover(
  params: ApprovalScopedParams, tsFallback: () => Promise<Approval | null>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<Approval | null>> {
  return job("get", getApprovalWithCutover, () => false, params, tsFallback, opts, moduleMeter);
}
export function wireListApprovalsCutover(
  params: ApprovalListParams, tsFallback: () => Promise<Approval[]>,
  opts: ApprovalCutoverWiringOpts = {},
): Promise<ApprovalCutoverResult<Approval[]>> {
  return job("list", listApprovalsWithCutover, () => false, params, tsFallback, opts, moduleMeter);
}

export interface ApprovalCutoverHooks {
  create: typeof wireCreateApprovalCutover;
  resolveFenced: typeof wireResolveApprovalFencedCutover;
  requestRevisionFenced: typeof wireRequestApprovalRevisionFencedCutover;
  resubmitFenced: typeof wireResubmitApprovalFencedCutover;
  cancelFenced: typeof wireCancelApprovalFencedCutover;
  get: typeof wireGetApprovalCutover;
  list: typeof wireListApprovalsCutover;
  getMetrics: () => ApprovalCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createApprovalCutoverHooks(
  defaultOpts: ApprovalCutoverWiringOpts = {},
): ApprovalCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: ApprovalCutoverWiringOpts): ApprovalCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  return {
    create: (params, tsFallback, opts = {}) =>
      job("create", createApprovalWithCutover, (v) => v.created === false,
        params, tsFallback, merged(opts), meter),
    resolveFenced: (params, tsFallback, opts = {}) =>
      job("resolve_fenced", resolveApprovalFencedWithCutover,
        (v) => v.outcome === "not_found_or_conflict", params, tsFallback, merged(opts), meter),
    requestRevisionFenced: (params, tsFallback, opts = {}) =>
      job("request_revision_fenced", requestApprovalRevisionFencedWithCutover,
        (v) => v.updated === false, params, tsFallback, merged(opts), meter),
    resubmitFenced: (params, tsFallback, opts = {}) =>
      job("resubmit_fenced", resubmitApprovalFencedWithCutover,
        (v) => v.updated === false, params, tsFallback, merged(opts), meter),
    cancelFenced: (params, tsFallback, opts = {}) =>
      job("cancel_fenced", cancelApprovalFencedWithCutover,
        (v) => v.updated === false, params, tsFallback, merged(opts), meter),
    get: (params, tsFallback, opts = {}) =>
      job("get", getApprovalWithCutover, () => false, params, tsFallback, merged(opts), meter),
    list: (params, tsFallback, opts = {}) =>
      job("list", listApprovalsWithCutover, () => false, params, tsFallback, merged(opts), meter),
    getMetrics: () => snapshotMeter(meter),
  };
}
