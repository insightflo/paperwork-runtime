// [파일 목적] paperwork-engine tool.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_TOOL_CUTOVER=1 이면 쓰기(claim_execution_receipt_idempotent)를
//   Rust RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS
//   작성자로 폴백하고, indeterminate 면 엔진이 receipt claim 을 커밋했을 수
//   있으므로 절대 TS 폴백을 호출하지 않고 ToolCutoverIndeterminateError 를
//   던진다(이중 claim 방지). 읽기(list_definitions/get_definition/list_skills/
//   list_execution_receipts)는 부작용이 없어 어떤 오류든 TS 폴백한다. 플래그
//   OFF·null 클라이언트는 RPC 없이 곧바로 TS 경로다. typed client 의 전송 전
//   RangeError 는 미전송이지만 미분류 입력이므로 issue/mission 컷오버와 같은
//   fail-closed 분류(indeterminate)를 따른다. agent/mission 과 달리 claim 응답은
//   fenced union arm 없이 항상 {outcome, receipt} 성공 형태다.
// [외부 연결] paperwork-engine-tool typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  claimToolExecutionReceiptIdempotent, classifyToolRpcError, getToolDefinition,
  listCompanySkills, listToolDefinitions, listToolExecutionReceipts,
  type ToolClaimExecutionReceiptIdempotentParams,
  type ToolClaimExecutionReceiptIdempotentResult,
  type ToolGetDefinitionParams, type ToolGetDefinitionResult,
  type ToolListDefinitionsParams, type ToolListDefinitionsResult,
  type ToolListExecutionReceiptsParams, type ToolListExecutionReceiptsResult,
  type ToolListSkillsParams, type ToolListSkillsResult,
  type ToolRpcErrorClassification,
} from "./paperwork-engine-tool.js";

export const TOOL_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const TOOL_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(TOOL_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : TOOL_CUTOVER_READ_TIMEOUT_MS;
}

export type ToolCutoverSource = "rust" | "ts";
export interface ToolCutoverResult<T> { source: ToolCutoverSource; value: T }
export type ToolCutoverOperation = "claim_execution_receipt_idempotent";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface ToolCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class ToolCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: ToolCutoverOperation,
    readonly classification: ToolRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`tool cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "ToolCutoverIndeterminateError";
  }
}

export function isToolEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_TOOL_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: ToolCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<ToolCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyToolRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine tool write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new ToolCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<ToolCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine tool read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function claimToolExecutionReceiptIdempotentWithCutover(
  client: PaperworkEngineClient | null,
  params: ToolClaimExecutionReceiptIdempotentParams,
  tsFallback: () => Promise<ToolClaimExecutionReceiptIdempotentResult>,
  opts: ToolCutoverCallOpts = {},
): Promise<ToolCutoverResult<ToolClaimExecutionReceiptIdempotentResult>> {
  if (client === null || !isToolEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("claim_execution_receipt_idempotent",
    () => claimToolExecutionReceiptIdempotent(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listToolDefinitionsWithCutover(
  client: PaperworkEngineClient | null,
  params: ToolListDefinitionsParams,
  tsFallback: () => Promise<ToolListDefinitionsResult>,
  opts: ToolCutoverCallOpts = {},
): Promise<ToolCutoverResult<ToolListDefinitionsResult>> {
  if (client === null || !isToolEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_definitions",
    () => listToolDefinitions(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getToolDefinitionWithCutover(
  client: PaperworkEngineClient | null,
  params: ToolGetDefinitionParams,
  tsFallback: () => Promise<ToolGetDefinitionResult>,
  opts: ToolCutoverCallOpts = {},
): Promise<ToolCutoverResult<ToolGetDefinitionResult>> {
  if (client === null || !isToolEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_definition",
    () => getToolDefinition(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listCompanySkillsWithCutover(
  client: PaperworkEngineClient | null,
  params: ToolListSkillsParams,
  tsFallback: () => Promise<ToolListSkillsResult>,
  opts: ToolCutoverCallOpts = {},
): Promise<ToolCutoverResult<ToolListSkillsResult>> {
  if (client === null || !isToolEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_skills",
    () => listCompanySkills(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listToolExecutionReceiptsWithCutover(
  client: PaperworkEngineClient | null,
  params: ToolListExecutionReceiptsParams,
  tsFallback: () => Promise<ToolListExecutionReceiptsResult>,
  opts: ToolCutoverCallOpts = {},
): Promise<ToolCutoverResult<ToolListExecutionReceiptsResult>> {
  if (client === null || !isToolEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_execution_receipts",
    () => listToolExecutionReceipts(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
