// [파일 목적] paperwork-engine agent.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_AGENT_CUTOVER=1 이면 쓰기(transition_status_fenced)를 Rust RPC
//   로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS 작성자로
//   폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을
//   호출하지 않고 AgentCutoverIndeterminateError 를 던진다(이중 적용 방지).
//   읽기(get/list_by_company/list_task_sessions/list_tool_grants)는 부작용이
//   없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null 클라이언트는 RPC 없이 곧바로
//   TS 경로다. typed client 의 전송 전 RangeError 는 미전송이지만 미분류
//   입력이므로 issue/mission 컷오버와 같은 fail-closed 분류(indeterminate)
//   를 따른다. fence 미적용 응답({applied:false,reason:"fenced"})은 성공
//   결과이므로 폴백 없이 그대로 반환한다.
// [외부 연결] paperwork-engine-agent typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyAgentRpcError, getAgent, listAgentsByCompany, listAgentTaskSessions,
  listAgentToolGrants, transitionAgentStatusFenced,
  type AgentGetParams, type AgentGetResult,
  type AgentListByCompanyParams, type AgentListByCompanyResult,
  type AgentListTaskSessionsParams, type AgentListTaskSessionsResult,
  type AgentListToolGrantsParams, type AgentListToolGrantsResult,
  type AgentRpcErrorClassification,
  type AgentTransitionStatusFencedParams, type AgentTransitionStatusFencedResult,
} from "./paperwork-engine-agent.js";

export const AGENT_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const AGENT_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(AGENT_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : AGENT_CUTOVER_READ_TIMEOUT_MS;
}

export type AgentCutoverSource = "rust" | "ts";
export interface AgentCutoverResult<T> { source: AgentCutoverSource; value: T }
export type AgentCutoverOperation = "transition_status_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface AgentCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class AgentCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: AgentCutoverOperation,
    readonly classification: AgentRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`agent cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "AgentCutoverIndeterminateError";
  }
}

export function isAgentEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_AGENT_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: AgentCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<AgentCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyAgentRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine agent write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new AgentCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<AgentCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine agent read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function transitionAgentStatusFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: AgentTransitionStatusFencedParams,
  tsFallback: () => Promise<AgentTransitionStatusFencedResult>,
  opts: AgentCutoverCallOpts = {},
): Promise<AgentCutoverResult<AgentTransitionStatusFencedResult>> {
  if (client === null || !isAgentEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("transition_status_fenced",
    () => transitionAgentStatusFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getAgentWithCutover(
  client: PaperworkEngineClient | null,
  params: AgentGetParams,
  tsFallback: () => Promise<AgentGetResult>,
  opts: AgentCutoverCallOpts = {},
): Promise<AgentCutoverResult<AgentGetResult>> {
  if (client === null || !isAgentEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get",
    () => getAgent(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listAgentsByCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: AgentListByCompanyParams,
  tsFallback: () => Promise<AgentListByCompanyResult>,
  opts: AgentCutoverCallOpts = {},
): Promise<AgentCutoverResult<AgentListByCompanyResult>> {
  if (client === null || !isAgentEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_by_company",
    () => listAgentsByCompany(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listAgentTaskSessionsWithCutover(
  client: PaperworkEngineClient | null,
  params: AgentListTaskSessionsParams,
  tsFallback: () => Promise<AgentListTaskSessionsResult>,
  opts: AgentCutoverCallOpts = {},
): Promise<AgentCutoverResult<AgentListTaskSessionsResult>> {
  if (client === null || !isAgentEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_task_sessions",
    () => listAgentTaskSessions(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listAgentToolGrantsWithCutover(
  client: PaperworkEngineClient | null,
  params: AgentListToolGrantsParams,
  tsFallback: () => Promise<AgentListToolGrantsResult>,
  opts: AgentCutoverCallOpts = {},
): Promise<AgentCutoverResult<AgentListToolGrantsResult>> {
  if (client === null || !isAgentEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_tool_grants",
    () => listAgentToolGrants(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
