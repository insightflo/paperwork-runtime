// [파일 목적] paperwork-engine cost.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_COST_CUTOVER=1 이면 쓰기(record_event)를 Rust RPC 로 먼저
//   시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS 작성자로 폴백하고,
//   indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을 호출하지 않고
//   CostCutoverIndeterminateError 를 던진다(이중 기록 방지). 읽기
//   (list_events/summarize_window/get_spend_snapshot)는 부작용이 없어 어떤
//   오류든 TS 폴백한다. {recorded:false} 는 소유권 가드가 삽입을 거절한 정상
//   결과이므로 폴백 없이 rust 결과로 반환한다. 플래그 OFF·null 클라이언트는
//   RPC 없이 곧바로 TS 경로다. typed client 의 전송 전 RangeError 는 미전송이지만
//   미분류 입력이므로 heartbeat 컷오버와 같은 fail-closed 분류(indeterminate)를
//   따른다.
// [외부 연결] paperwork-engine-cost typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyCostRpcError, getCostSpendSnapshot, listCostEvents, recordCostEvent,
  summarizeCostWindow, type CostListEventsParams, type CostListEventsResult,
  type CostRecordEventParams, type CostRecordEventResult,
  type CostRpcErrorClassification, type CostSpendSnapshotParams,
  type CostSpendSnapshotResult, type CostSummarizeWindowParams,
  type CostSummarizeWindowResult,
} from "./paperwork-engine-cost.js";

export const COST_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const COST_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(COST_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : COST_CUTOVER_READ_TIMEOUT_MS;
}

export type CostCutoverSource = "rust" | "ts";
export interface CostCutoverResult<T> { source: CostCutoverSource; value: T }
export type CostCutoverOperation = "record_event";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface CostCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class CostCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: CostCutoverOperation,
    readonly classification: CostRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`cost cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "CostCutoverIndeterminateError";
  }
}

export function isCostEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_COST_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: CostCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<CostCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyCostRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine cost write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new CostCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<CostCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine cost read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function recordCostEventWithCutover(
  client: PaperworkEngineClient | null,
  params: CostRecordEventParams,
  tsFallback: () => Promise<CostRecordEventResult>,
  opts: CostCutoverCallOpts = {},
): Promise<CostCutoverResult<CostRecordEventResult>> {
  if (client === null || !isCostEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("record_event",
    () => recordCostEvent(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listCostEventsWithCutover(
  client: PaperworkEngineClient | null,
  params: CostListEventsParams,
  tsFallback: () => Promise<CostListEventsResult>,
  opts: CostCutoverCallOpts = {},
): Promise<CostCutoverResult<CostListEventsResult>> {
  if (client === null || !isCostEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_events",
    () => listCostEvents(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function summarizeCostWindowWithCutover(
  client: PaperworkEngineClient | null,
  params: CostSummarizeWindowParams,
  tsFallback: () => Promise<CostSummarizeWindowResult>,
  opts: CostCutoverCallOpts = {},
): Promise<CostCutoverResult<CostSummarizeWindowResult>> {
  if (client === null || !isCostEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("summarize_window",
    () => summarizeCostWindow(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getCostSpendSnapshotWithCutover(
  client: PaperworkEngineClient | null,
  params: CostSpendSnapshotParams,
  tsFallback: () => Promise<CostSpendSnapshotResult>,
  opts: CostCutoverCallOpts = {},
): Promise<CostCutoverResult<CostSpendSnapshotResult>> {
  if (client === null || !isCostEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_spend_snapshot",
    () => getCostSpendSnapshot(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
