// [파일 목적] paperwork-engine issue.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_ISSUE_CUTOVER=1 이면 쓰기(checkout_fenced/
//   transition_status_fenced/release_checkout_fenced)를 Rust RPC 로 먼저
//   시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS 작성자로
//   폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을
//   호출하지 않고 IssueCutoverIndeterminateError 를 던진다(이중 적용 방지).
//   읽기(get/list_by_company/list_issue_work_products)는 부작용이 없어
//   어떤 오류든 TS 폴백한다. 플래그 OFF·null 클라이언트는 RPC 없이 곧바로
//   TS 경로다. typed client 의 전송 전 RangeError 는 미전송이지만 미분류
//   입력이므로 mission/budget 컷오버와 같은 fail-closed 분류(indeterminate)
//   를 따른다. fence 미적용 응답({applied:false,reason})은 성공 결과이므로
//   폴백 없이 그대로 반환한다.
// [외부 연결] paperwork-engine-issue typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  checkoutIssueFenced, classifyIssueRpcError, getIssue,
  listIssueWorkProducts, listIssuesByCompany, releaseIssueCheckoutFenced,
  transitionIssueStatusFenced,
  type IssueCheckoutFencedParams, type IssueCheckoutFencedResult,
  type IssueGetParams, type IssueGetResult,
  type IssueListByCompanyParams, type IssueListByCompanyResult,
  type IssueListWorkProductsParams, type IssueListWorkProductsResult,
  type IssueReleaseCheckoutFencedParams, type IssueReleaseCheckoutFencedResult,
  type IssueRpcErrorClassification,
  type IssueTransitionStatusFencedParams, type IssueTransitionStatusFencedResult,
} from "./paperwork-engine-issue.js";

export const ISSUE_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const ISSUE_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(ISSUE_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : ISSUE_CUTOVER_READ_TIMEOUT_MS;
}

export type IssueCutoverSource = "rust" | "ts";
export interface IssueCutoverResult<T> { source: IssueCutoverSource; value: T }
export type IssueCutoverOperation =
  "checkout_fenced" | "transition_status_fenced" | "release_checkout_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface IssueCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class IssueCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: IssueCutoverOperation,
    readonly classification: IssueRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`issue cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "IssueCutoverIndeterminateError";
  }
}

export function isIssueEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_ISSUE_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: IssueCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<IssueCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyIssueRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine issue write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new IssueCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<IssueCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine issue read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function checkoutIssueFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: IssueCheckoutFencedParams,
  tsFallback: () => Promise<IssueCheckoutFencedResult>,
  opts: IssueCutoverCallOpts = {},
): Promise<IssueCutoverResult<IssueCheckoutFencedResult>> {
  if (client === null || !isIssueEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("checkout_fenced",
    () => checkoutIssueFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function transitionIssueStatusFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: IssueTransitionStatusFencedParams,
  tsFallback: () => Promise<IssueTransitionStatusFencedResult>,
  opts: IssueCutoverCallOpts = {},
): Promise<IssueCutoverResult<IssueTransitionStatusFencedResult>> {
  if (client === null || !isIssueEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("transition_status_fenced",
    () => transitionIssueStatusFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function releaseIssueCheckoutFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: IssueReleaseCheckoutFencedParams,
  tsFallback: () => Promise<IssueReleaseCheckoutFencedResult>,
  opts: IssueCutoverCallOpts = {},
): Promise<IssueCutoverResult<IssueReleaseCheckoutFencedResult>> {
  if (client === null || !isIssueEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("release_checkout_fenced",
    () => releaseIssueCheckoutFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getIssueWithCutover(
  client: PaperworkEngineClient | null,
  params: IssueGetParams,
  tsFallback: () => Promise<IssueGetResult>,
  opts: IssueCutoverCallOpts = {},
): Promise<IssueCutoverResult<IssueGetResult>> {
  if (client === null || !isIssueEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get",
    () => getIssue(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listIssuesByCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: IssueListByCompanyParams,
  tsFallback: () => Promise<IssueListByCompanyResult>,
  opts: IssueCutoverCallOpts = {},
): Promise<IssueCutoverResult<IssueListByCompanyResult>> {
  if (client === null || !isIssueEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_by_company",
    () => listIssuesByCompany(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listIssueWorkProductsWithCutover(
  client: PaperworkEngineClient | null,
  params: IssueListWorkProductsParams,
  tsFallback: () => Promise<IssueListWorkProductsResult>,
  opts: IssueCutoverCallOpts = {},
): Promise<IssueCutoverResult<IssueListWorkProductsResult>> {
  if (client === null || !isIssueEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_issue_work_products",
    () => listIssueWorkProducts(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
