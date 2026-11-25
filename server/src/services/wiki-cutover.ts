// [파일 목적] paperwork-engine wiki.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_WIKI_CUTOVER=1 이면 쓰기(record_failure/mark_resolved/close)를
//   Rust RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS
//   작성자로 폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을
//   호출하지 않고 WikiCutoverIndeterminateError 를 던진다(이중 적용 방지). 읽기
//   (search_relevant/list)는 부작용이 없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null
//   클라이언트는 RPC 없이 곧바로 TS 경로다. typed client 의 전송 전 RangeError 는
//   미전송이지만 미분류 입력이므로 fail-closed 분류(indeterminate)를 따른다.
//   audience/status/now/limit 등 주입 게이트 입력은 어댑터가 변경하지 않고 typed
//   client 에 그대로 전달한다. 실행 권한은 엔진 SQL 의 status='active' AND
//   audience='agent' 조건과 TS 리더의 동등 필터에 남는다.
// [외부 연결] paperwork-engine-wiki typed client(파라미터 snake_case·에러 분류
//   1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존 TS
//   작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyWikiRpcError, closeWikiEntry, listWikiEntries, markWikiEntryResolved,
  recordWikiFailure, searchRelevantWiki,
  type WikiCloseResult, type WikiEntryIdParams, type WikiListParams, type WikiListResult,
  type WikiMarkResolvedResult, type WikiRecordFailureParams, type WikiRecordFailureResult,
  type WikiSearchRelevantParams, type WikiSearchRelevantResult,
} from "./paperwork-engine-wiki.js";

export const WIKI_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const WIKI_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(WIKI_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : WIKI_CUTOVER_READ_TIMEOUT_MS;
}

export type WikiCutoverSource = "rust" | "ts";
export interface WikiCutoverResult<T> { source: WikiCutoverSource; value: T }
export type WikiCutoverOperation = "record_failure" | "mark_resolved" | "close";
export type WikiRpcErrorClassification = ReturnType<typeof classifyWikiRpcError>;
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface WikiCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class WikiCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: WikiCutoverOperation,
    readonly classification: WikiRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`wiki cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "WikiCutoverIndeterminateError";
  }
}

export function isWikiEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_WIKI_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: WikiCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<WikiCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyWikiRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine wiki write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new WikiCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<WikiCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine wiki read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function recordFailureWithCutover(
  client: PaperworkEngineClient | null,
  params: WikiRecordFailureParams,
  tsFallback: () => Promise<WikiRecordFailureResult>,
  opts: WikiCutoverCallOpts = {},
): Promise<WikiCutoverResult<WikiRecordFailureResult>> {
  if (client === null || !isWikiEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("record_failure",
    () => recordWikiFailure(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function markResolvedWithCutover(
  client: PaperworkEngineClient | null,
  params: WikiEntryIdParams,
  tsFallback: () => Promise<WikiMarkResolvedResult>,
  opts: WikiCutoverCallOpts = {},
): Promise<WikiCutoverResult<WikiMarkResolvedResult>> {
  if (client === null || !isWikiEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("mark_resolved",
    () => markWikiEntryResolved(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function closeEntryWithCutover(
  client: PaperworkEngineClient | null,
  params: WikiEntryIdParams,
  tsFallback: () => Promise<WikiCloseResult>,
  opts: WikiCutoverCallOpts = {},
): Promise<WikiCutoverResult<WikiCloseResult>> {
  if (client === null || !isWikiEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("close",
    () => closeWikiEntry(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function searchRelevantWithCutover(
  client: PaperworkEngineClient | null,
  params: WikiSearchRelevantParams,
  tsFallback: () => Promise<WikiSearchRelevantResult>,
  opts: WikiCutoverCallOpts = {},
): Promise<WikiCutoverResult<WikiSearchRelevantResult>> {
  if (client === null || !isWikiEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("search_relevant",
    () => searchRelevantWiki(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listWikiEntriesWithCutover(
  client: PaperworkEngineClient | null,
  params: WikiListParams,
  tsFallback: () => Promise<WikiListResult>,
  opts: WikiCutoverCallOpts = {},
): Promise<WikiCutoverResult<WikiListResult>> {
  if (client === null || !isWikiEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list",
    () => listWikiEntries(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
