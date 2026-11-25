// [파일 목적] Wave 5 — company.* 컷오버(create/update/pause/resume/
//   next_issue_counter/list/get_by_id/get_by_issue_prefix) 배선 + 구조화
//   텔레메트리 계층. PAPERWORK_RUST_COMPANY_CUTOVER=1(기본 OFF)일 때만 공유
//   엔진 클라이언트를 지연 해석해 컷오버 어댑터(company-cutover)에 위임하고,
//   그 외에는 TS 작성자/리더를 그대로 호출한다. indeterminate 쓰기 오류는 절대
//   TS 폴백 없이 CompanyCutoverIndeterminateError 로 전파하고, fence/not-applied
//   결과(paused/resumed:false 또는 company:null)는 폴백 없이 그대로 반환한다.
// [외부 연결] company-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createCompanyCutoverHooks 로 env/getClient/timeoutMs/onEvent 를
//   한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  CompanyCutoverIndeterminateError, createCompanyWithCutover,
  getCompanyByIdWithCutover, getCompanyByIssuePrefixWithCutover,
  isCompanyEngineCutoverEnabled, listCompaniesWithCutover,
  nextCompanyIssueCounterWithCutover, pauseCompanyWithCutover,
  resumeCompanyWithCutover, updateCompanyWithCutover,
  type CompanyCutoverCallOpts, type CompanyCutoverOperation, type CompanyCutoverResult,
} from "./company-cutover.js";
import type {
  CompanyCreateParams, CompanyCreateResult, CompanyGetByIdParams,
  CompanyGetByPrefixParams, CompanyGetResult, CompanyListParams,
  CompanyListResult, CompanyNextCounterParams, CompanyNextCounterResult,
  CompanyPauseParams, CompanyPauseResult, CompanyResumeParams,
  CompanyResumeResult, CompanyUpdateParams, CompanyUpdateResult,
} from "./paperwork-engine-company.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { CompanyCutoverIndeterminateError };
export type { CompanyCutoverOperation, CompanyCutoverResult };

/** 텔레메트리가 다루는 컷오버 대상 — 어댑터의 쓰기 5종 + 읽기 3종 전부. */
export type CompanyWiredOperation =
  CompanyCutoverOperation | "list_companies" | "get_company_by_id" | "get_company_by_issue_prefix";

export type CompanyCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface CompanyCutoverTelemetryEvent {
  operation: CompanyWiredOperation;
  outcome: CompanyCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface CompanyCutoverOperationMetrics {
  rustSuccess: number;
  tsBypass: number;
  tsFallback: number;
  indeterminateError: number;
  tsError: number;
  fenceMismatch: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type CompanyCutoverMetricsSnapshot = Readonly<
  Record<CompanyWiredOperation, Readonly<CompanyCutoverOperationMetrics>>>;

export interface CompanyCutoverWiringOpts extends CompanyCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: CompanyCutoverTelemetryEvent) => void;
}

type Meter = Record<CompanyWiredOperation, CompanyCutoverOperationMetrics>;

const WIRED_OPS = [
  "create_company", "update_company", "pause_company", "resume_company",
  "next_company_issue_counter", "list_companies", "get_company_by_id", "get_company_by_issue_prefix",
] as const satisfies readonly CompanyWiredOperation[];

const emptyOperationMetrics = (): CompanyCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  WIRED_OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): CompanyCutoverMetricsSnapshot => Object.fromEntries(
  WIRED_OPS.map((op) => [op, { ...meter[op] }])) as CompanyCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: CompanyWiredOperation;
  call: (client: PaperworkEngineClient, callOpts: CompanyCutoverCallOpts) => Promise<CompanyCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: CompanyCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<CompanyCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: CompanyCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "company cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "company cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<CompanyCutoverResult<T>> => {
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
  if (!isCompanyEngineCutoverEnabled(env)) return runTsBypass();

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
    if (error instanceof CompanyCutoverIndeterminateError) {
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
  tsFallback: () => Promise<T>, callOpts: CompanyCutoverCallOpts,
) => Promise<CompanyCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: CompanyCutoverWiringOpts) => Promise<CompanyCutoverResult<T>>;

/** 엔진 fence/not-applied 결과 — 폴백 없이 반환하되 텔레메트리엔 fenceMismatch 로 집계. */
const pauseNotApplied = (v: CompanyPauseResult) => v.paused === false;
const resumeNotApplied = (v: CompanyResumeResult) => v.resumed === false;
const updateNotApplied = (v: CompanyUpdateResult) => v.company === null;
const counterNotApplied = (v: CompanyNextCounterResult) => v.company === null;
const neverNotApplied = () => false;

function makeWiredOp<P, T>(
  operation: CompanyWiredOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, meter: Meter, defaults?: CompanyCutoverWiringOpts,
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
export function getCompanyCutoverMetrics(): CompanyCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetCompanyCutoverMetricsForTests(): void {
  for (const op of WIRED_OPS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireCreateCompanyCutover =
  makeWiredOp("create_company", createCompanyWithCutover, neverNotApplied, moduleMeter);
export const wireUpdateCompanyCutover =
  makeWiredOp("update_company", updateCompanyWithCutover, updateNotApplied, moduleMeter);
export const wirePauseCompanyCutover =
  makeWiredOp("pause_company", pauseCompanyWithCutover, pauseNotApplied, moduleMeter);
export const wireResumeCompanyCutover =
  makeWiredOp("resume_company", resumeCompanyWithCutover, resumeNotApplied, moduleMeter);
export const wireNextCompanyIssueCounterCutover =
  makeWiredOp("next_company_issue_counter", nextCompanyIssueCounterWithCutover, counterNotApplied, moduleMeter);
export const wireListCompaniesCutover =
  makeWiredOp("list_companies", listCompaniesWithCutover, neverNotApplied, moduleMeter);
export const wireGetCompanyByIdCutover =
  makeWiredOp("get_company_by_id", getCompanyByIdWithCutover, neverNotApplied, moduleMeter);
export const wireGetCompanyByIssuePrefixCutover =
  makeWiredOp("get_company_by_issue_prefix", getCompanyByIssuePrefixWithCutover, neverNotApplied, moduleMeter);

export interface CompanyCutoverHooks {
  createCompany: typeof wireCreateCompanyCutover;
  updateCompany: typeof wireUpdateCompanyCutover;
  pauseCompany: typeof wirePauseCompanyCutover;
  resumeCompany: typeof wireResumeCompanyCutover;
  nextCompanyIssueCounter: typeof wireNextCompanyIssueCounterCutover;
  listCompanies: typeof wireListCompaniesCutover;
  getCompanyById: typeof wireGetCompanyByIdCutover;
  getCompanyByIssuePrefix: typeof wireGetCompanyByIssuePrefixCutover;
  getMetrics: () => CompanyCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createCompanyCutoverHooks(defaultOpts: CompanyCutoverWiringOpts = {}): CompanyCutoverHooks {
  const meter = emptyMeter();
  return {
    createCompany: makeWiredOp("create_company", createCompanyWithCutover, neverNotApplied, meter, defaultOpts),
    updateCompany: makeWiredOp("update_company", updateCompanyWithCutover, updateNotApplied, meter, defaultOpts),
    pauseCompany: makeWiredOp("pause_company", pauseCompanyWithCutover, pauseNotApplied, meter, defaultOpts),
    resumeCompany: makeWiredOp("resume_company", resumeCompanyWithCutover, resumeNotApplied, meter, defaultOpts),
    nextCompanyIssueCounter: makeWiredOp("next_company_issue_counter", nextCompanyIssueCounterWithCutover, counterNotApplied, meter, defaultOpts),
    listCompanies: makeWiredOp("list_companies", listCompaniesWithCutover, neverNotApplied, meter, defaultOpts),
    getCompanyById: makeWiredOp("get_company_by_id", getCompanyByIdWithCutover, neverNotApplied, meter, defaultOpts),
    getCompanyByIssuePrefix: makeWiredOp("get_company_by_issue_prefix", getCompanyByIssuePrefixWithCutover, neverNotApplied, meter, defaultOpts),
    getMetrics: () => snapshotMeter(meter),
  };
}
