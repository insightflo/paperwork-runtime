// [파일 목적] paperwork-engine budget.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_ENGINE_BUDGET_CUTOVER=1 이면 쓰기(record_cost_event/
//   upsert_incident_fenced/resolve_incident_fenced)를 Rust RPC 로 먼저 시도한다.
//   응답이 not_committed 로 분류되면 경고 후 기존 TS 작성자로 폴백하고,
//   indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을 호출하지 않고
//   BudgetCutoverIndeterminateError 를 던진다(이중 적용 방지). 읽기
//   (sum_scope_spend/list_active_policies)는 부작용이 없어 어떤 오류든 TS
//   폴백한다. 플래그 OFF·null 클라이언트는 RPC 없이 곧바로 TS 경로다.
//   typed client 의 전송 전 RangeError 는 미전송이지만 미분류 입력이므로
//   heartbeat 컷오버와 같은 fail-closed 분류(indeterminate)를 따른다.
// [외부 연결] paperwork-engine-budget typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyBudgetRpcError, listActiveBudgetPolicies, recordBudgetCostEvent,
  resolveBudgetIncidentFenced, sumBudgetScopeSpend, upsertBudgetIncidentFenced,
  type BudgetPolicy, type BudgetRecordCostEventParams, type BudgetRecordCostEventResult,
  type BudgetResolveIncidentFencedParams, type BudgetResolveIncidentFencedResult,
  type BudgetRpcErrorClassification, type BudgetScopeParams,
  type BudgetSumScopeSpendParams, type BudgetSumScopeSpendResult,
  type BudgetUpsertIncidentFencedParams, type BudgetUpsertIncidentFencedResult,
} from "./paperwork-engine-budget.js";

export const BUDGET_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const BUDGET_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(BUDGET_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : BUDGET_CUTOVER_READ_TIMEOUT_MS;
}

export type BudgetCutoverSource = "rust" | "ts";
export interface BudgetCutoverResult<T> { source: BudgetCutoverSource; value: T }
export type BudgetCutoverOperation =
  "record_cost_event" | "upsert_incident_fenced" | "resolve_incident_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface BudgetCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class BudgetCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: BudgetCutoverOperation,
    readonly classification: BudgetRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`budget cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "BudgetCutoverIndeterminateError";
  }
}

export function isBudgetEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_ENGINE_BUDGET_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: BudgetCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<BudgetCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyBudgetRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine budget write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new BudgetCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<BudgetCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine budget read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function recordCostEventWithCutover(
  client: PaperworkEngineClient | null,
  params: BudgetRecordCostEventParams,
  tsFallback: () => Promise<BudgetRecordCostEventResult>,
  opts: BudgetCutoverCallOpts = {},
): Promise<BudgetCutoverResult<BudgetRecordCostEventResult>> {
  if (client === null || !isBudgetEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("record_cost_event",
    () => recordBudgetCostEvent(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function upsertIncidentFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: BudgetUpsertIncidentFencedParams,
  tsFallback: () => Promise<BudgetUpsertIncidentFencedResult>,
  opts: BudgetCutoverCallOpts = {},
): Promise<BudgetCutoverResult<BudgetUpsertIncidentFencedResult>> {
  if (client === null || !isBudgetEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("upsert_incident_fenced",
    () => upsertBudgetIncidentFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function resolveIncidentFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: BudgetResolveIncidentFencedParams,
  tsFallback: () => Promise<BudgetResolveIncidentFencedResult>,
  opts: BudgetCutoverCallOpts = {},
): Promise<BudgetCutoverResult<BudgetResolveIncidentFencedResult>> {
  if (client === null || !isBudgetEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("resolve_incident_fenced",
    () => resolveBudgetIncidentFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function sumScopeSpendWithCutover(
  client: PaperworkEngineClient | null,
  params: BudgetSumScopeSpendParams,
  tsFallback: () => Promise<BudgetSumScopeSpendResult>,
  opts: BudgetCutoverCallOpts = {},
): Promise<BudgetCutoverResult<BudgetSumScopeSpendResult>> {
  if (client === null || !isBudgetEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("sum_scope_spend",
    () => sumBudgetScopeSpend(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listActivePoliciesWithCutover(
  client: PaperworkEngineClient | null,
  params: BudgetScopeParams,
  tsFallback: () => Promise<BudgetPolicy[]>,
  opts: BudgetCutoverCallOpts = {},
): Promise<BudgetCutoverResult<BudgetPolicy[]>> {
  if (client === null || !isBudgetEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_active_policies",
    () => listActiveBudgetPolicies(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
