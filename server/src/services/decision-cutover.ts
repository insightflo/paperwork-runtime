// [파일 목적] paperwork-engine decision.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_DECISION_CUTOVER=1 이면 쓰기(create/resolve/cancel)를 Rust
//   RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS
//   작성자로 폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS
//   폴백을 호출하지 않고 DecisionCutoverIndeterminateError 를 던진다(이중
//   적용 방지). 읽기(list/get_by_id/get_by_request_key)는 부작용이 없어 어떤
//   오류든 TS 폴백한다. 정상 부정 결과(created:false, resolved:false,
//   cancelled:false)는 오류가 아니므로 rust 결과로 그대로 통과한다. 플래그
//   OFF·null 클라이언트는 RPC 없이 곧바로 TS 경로다. typed client 의 전송 전
//   RangeError 는 미전송이지만 미분류 입력이므로 fail-closed indeterminate 다.
// [외부 연결] paperwork-engine-decision typed client(에러 분류 1:1 재사용),
//   PaperworkEngineClient, middleware logger. 호출부는 기존 TS 작성자/리더
//   호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  cancelDecision, classifyDecisionRpcError, createDecision, getDecisionById,
  getDecisionByRequestKey, listDecisions, resolveDecision,
  type DecisionCancelParams, type DecisionCancelResult, type DecisionCreateParams,
  type DecisionCreateResult, type DecisionGetByIdParams, type DecisionGetByKeyParams,
  type DecisionGetResult, type DecisionListParams, type DecisionResolveParams,
  type DecisionResolveResult, type DecisionRow,
} from "./paperwork-engine-decision.js";

export const DECISION_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const DECISION_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(DECISION_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : DECISION_CUTOVER_READ_TIMEOUT_MS;
}

export type DecisionCutoverSource = "rust" | "ts";
export interface DecisionCutoverResult<T> { source: DecisionCutoverSource; value: T }
export type DecisionCutoverOperation = "create" | "resolve" | "cancel";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface DecisionCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }
export type DecisionRpcErrorClassification = ReturnType<typeof classifyDecisionRpcError>;

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class DecisionCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: DecisionCutoverOperation,
    readonly classification: DecisionRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`decision cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "DecisionCutoverIndeterminateError";
  }
}

export function isDecisionEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_DECISION_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: DecisionCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<DecisionCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyDecisionRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine decision write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new DecisionCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<DecisionCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine decision read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function createDecisionWithCutover(
  client: PaperworkEngineClient | null,
  params: DecisionCreateParams,
  tsFallback: () => Promise<DecisionCreateResult>,
  opts: DecisionCutoverCallOpts = {},
): Promise<DecisionCutoverResult<DecisionCreateResult>> {
  if (client === null || !isDecisionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("create",
    () => createDecision(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function resolveDecisionWithCutover(
  client: PaperworkEngineClient | null,
  params: DecisionResolveParams,
  tsFallback: () => Promise<DecisionResolveResult>,
  opts: DecisionCutoverCallOpts = {},
): Promise<DecisionCutoverResult<DecisionResolveResult>> {
  if (client === null || !isDecisionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("resolve",
    () => resolveDecision(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function cancelDecisionWithCutover(
  client: PaperworkEngineClient | null,
  params: DecisionCancelParams,
  tsFallback: () => Promise<DecisionCancelResult>,
  opts: DecisionCutoverCallOpts = {},
): Promise<DecisionCutoverResult<DecisionCancelResult>> {
  if (client === null || !isDecisionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("cancel",
    () => cancelDecision(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listDecisionsWithCutover(
  client: PaperworkEngineClient | null,
  params: DecisionListParams,
  tsFallback: () => Promise<DecisionRow[]>,
  opts: DecisionCutoverCallOpts = {},
): Promise<DecisionCutoverResult<DecisionRow[]>> {
  if (client === null || !isDecisionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list",
    () => listDecisions(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getDecisionByIdWithCutover(
  client: PaperworkEngineClient | null,
  params: DecisionGetByIdParams,
  tsFallback: () => Promise<DecisionGetResult>,
  opts: DecisionCutoverCallOpts = {},
): Promise<DecisionCutoverResult<DecisionGetResult>> {
  if (client === null || !isDecisionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_by_id",
    () => getDecisionById(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getDecisionByRequestKeyWithCutover(
  client: PaperworkEngineClient | null,
  params: DecisionGetByKeyParams,
  tsFallback: () => Promise<DecisionGetResult>,
  opts: DecisionCutoverCallOpts = {},
): Promise<DecisionCutoverResult<DecisionGetResult>> {
  if (client === null || !isDecisionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_by_request_key",
    () => getDecisionByRequestKey(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
