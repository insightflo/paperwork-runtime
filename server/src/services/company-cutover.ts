// [파일 목적] paperwork-engine company.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_COMPANY_CUTOVER=1 이면 쓰기(create/update/pause/resume/
//   next_issue_counter)를 Rust RPC 로 먼저 시도한다. 응답이 not_committed 로
//   분류되면 경고 후 기존 TS 작성자로 폴백하고, indeterminate 면 커밋 여부를
//   알 수 없으므로 절대 TS 폴백을 호출하지 않고 CompanyCutoverIndeterminateError
//   를 던진다(이중 쓰기·카운터 이중 증가 방지). 읽기(list/get)는 부작용이
//   없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null 클라이언트는 RPC 없이 곧바로
//   TS 경로다. pause/resume/update/next_issue_counter 의 fenced miss(null
//   company 또는 false flag)는 오류가 아니라 엔진의 authoritative 데이터 결과다.
//   이 경우 legacy unfenced TS 재쓰기는 fence 를 무력화하므로 source "rust"
//   그대로 반환하고 tsFallback 을 호출하지 않는다.
// [외부 연결] paperwork-engine-company typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다(Wave 5 wiring).
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyCompanyRpcError, createCompany, getCompanyById,
  getCompanyByIssuePrefix, listCompanies, nextCompanyIssueCounter,
  pauseCompany, resumeCompany, updateCompany,
  type CompanyCreateParams, type CompanyCreateResult,
  type CompanyGetByIdParams, type CompanyGetByPrefixParams,
  type CompanyGetResult, type CompanyListParams, type CompanyListResult,
  type CompanyNextCounterParams, type CompanyNextCounterResult,
  type CompanyPauseParams, type CompanyPauseResult,
  type CompanyResumeParams, type CompanyResumeResult,
  type CompanyUpdateParams, type CompanyUpdateResult,
} from "./paperwork-engine-company.js";

export type {
  CompanyCreateParams, CompanyCreateResult, CompanyGetByIdParams,
  CompanyGetByPrefixParams, CompanyGetResult, CompanyListParams,
  CompanyListResult, CompanyNextCounterParams, CompanyNextCounterResult,
  CompanyPauseParams, CompanyPauseResult, CompanyResumeParams,
  CompanyResumeResult, CompanyUpdateParams, CompanyUpdateResult,
  EngineCompany,
} from "./paperwork-engine-company.js";

export const COMPANY_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const COMPANY_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 비유한 입력은 17s 기본값이다. */
export function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(COMPANY_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 비유한 입력과 0(미지정)은 10s, 그 외 유한 입력은 정수로 잘라 [1, 600s] 로 클램프한다. */
export function cutoverReadTimeoutMs(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return COMPANY_CUTOVER_READ_TIMEOUT_MS;
  const truncated = Math.trunc(requested);
  if (truncated === 0) return COMPANY_CUTOVER_READ_TIMEOUT_MS;
  return Math.min(600_000, Math.max(1, truncated));
}

export type CompanyCutoverSource = "rust" | "ts";
export interface CompanyCutoverResult<T> { source: CompanyCutoverSource; value: T }
export type CompanyCutoverOperation =
  "create_company" | "update_company" | "pause_company" | "resume_company" | "next_company_issue_counter";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface CompanyCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }
type CompanyRpcErrorClassification = ReturnType<typeof classifyCompanyRpcError>;

/** indeterminate 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이 이중 쓰기가 된다.
 *  tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class CompanyCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: CompanyCutoverOperation,
    readonly classification: CompanyRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`company cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "CompanyCutoverIndeterminateError";
  }
}

export function isCompanyEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_COMPANY_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: CompanyCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<CompanyCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyCompanyRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine company write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new CompanyCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<CompanyCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine company read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function createCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyCreateParams,
  tsFallback: () => Promise<CompanyCreateResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyCreateResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("create_company",
    () => createCompany(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function updateCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyUpdateParams,
  tsFallback: () => Promise<CompanyUpdateResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyUpdateResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("update_company",
    () => updateCompany(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function pauseCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyPauseParams,
  tsFallback: () => Promise<CompanyPauseResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyPauseResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("pause_company",
    () => pauseCompany(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function resumeCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyResumeParams,
  tsFallback: () => Promise<CompanyResumeResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyResumeResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("resume_company",
    () => resumeCompany(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function nextCompanyIssueCounterWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyNextCounterParams,
  tsFallback: () => Promise<CompanyNextCounterResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyNextCounterResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("next_company_issue_counter",
    () => nextCompanyIssueCounter(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listCompaniesWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyListParams,
  tsFallback: () => Promise<CompanyListResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyListResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_companies",
    () => listCompanies(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getCompanyByIdWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyGetByIdParams,
  tsFallback: () => Promise<CompanyGetResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyGetResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_company_by_id",
    () => getCompanyById(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getCompanyByIssuePrefixWithCutover(
  client: PaperworkEngineClient | null,
  params: CompanyGetByPrefixParams,
  tsFallback: () => Promise<CompanyGetResult>,
  opts: CompanyCutoverCallOpts = {},
): Promise<CompanyCutoverResult<CompanyGetResult>> {
  if (client === null || !isCompanyEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_company_by_issue_prefix",
    () => getCompanyByIssuePrefix(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
