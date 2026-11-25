// [파일 목적] paperwork-engine worktree.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_WORKTREE_CUTOVER=1 이면 쓰기(create/update/toggle/delete)를
//   Rust RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존
//   TS 작성자로 폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대
//   TS 폴백을 호출하지 않고 WorktreeCutoverIndeterminateError 를 던진다
//   (이중 쓰기 방지). 읽기(list/get_by_id)는 부작용이 없어 어떤 오류든 TS
//   폴백한다. 플래그 OFF·null 클라이언트는 RPC 없이 곧바로 TS 경로다.
//   update/toggle 의 fenced miss({updated:false, reason:not_found|
//   version_conflict})와 delete 의 {deleted:false}는 오류가 아니라 엔진이
//   authoritative 하게 평가한 데이터 결과다. 이 경우 TS 폴백하면 legacy
//   unfenced 경로로 같은 쓰기를 재실행해 optimistic concurrency 를 무력화하므로
//   source "rust" 그대로 반환하고 tsFallback 을 호출하지 않는다.
// [외부 연결] paperwork-engine-worktree typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다(Wave 5 wiring).
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyWorktreeRpcError, createWorktreeRule, deleteWorktreeRule,
  getWorktreeRuleById, listWorktreeRules, toggleWorktreeRuleEnabled,
  updateWorktreeRule,
  type WorktreeCreateParams, type WorktreeCreateResult,
  type WorktreeDeleteParams, type WorktreeDeleteResult,
  type WorktreeGetByIdParams, type WorktreeGetResult,
  type WorktreeListParams, type WorktreeListResult,
  type WorktreeRpcErrorClassification,
  type WorktreeToggleEnabledParams, type WorktreeUpdateParams,
  type WorktreeUpdateResult,
} from "./paperwork-engine-worktree.js";

export const WORKTREE_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const WORKTREE_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 비유한 입력은 17s 기본값이다. */
export function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(WORKTREE_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
export function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : WORKTREE_CUTOVER_READ_TIMEOUT_MS;
}

export type WorktreeCutoverSource = "rust" | "ts";
export interface WorktreeCutoverResult<T> { source: WorktreeCutoverSource; value: T }
export type WorktreeCutoverOperation =
  "create_worktree_rule" | "update_worktree_rule" | "toggle_worktree_rule_enabled" | "delete_worktree_rule";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface WorktreeCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** indeterminate 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이 이중 쓰기가 된다.
 *  tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class WorktreeCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: WorktreeCutoverOperation,
    readonly classification: WorktreeRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`worktree cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "WorktreeCutoverIndeterminateError";
  }
}

export function isWorktreeEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_WORKTREE_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: WorktreeCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<WorktreeCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyWorktreeRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine worktree write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new WorktreeCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<WorktreeCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine worktree read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function createWorktreeRuleWithCutover(
  client: PaperworkEngineClient | null,
  params: WorktreeCreateParams,
  tsFallback: () => Promise<WorktreeCreateResult>,
  opts: WorktreeCutoverCallOpts = {},
): Promise<WorktreeCutoverResult<WorktreeCreateResult>> {
  if (client === null || !isWorktreeEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("create_worktree_rule",
    () => createWorktreeRule(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function updateWorktreeRuleWithCutover(
  client: PaperworkEngineClient | null,
  params: WorktreeUpdateParams,
  tsFallback: () => Promise<WorktreeUpdateResult>,
  opts: WorktreeCutoverCallOpts = {},
): Promise<WorktreeCutoverResult<WorktreeUpdateResult>> {
  if (client === null || !isWorktreeEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("update_worktree_rule",
    () => updateWorktreeRule(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function toggleWorktreeRuleEnabledWithCutover(
  client: PaperworkEngineClient | null,
  params: WorktreeToggleEnabledParams,
  tsFallback: () => Promise<WorktreeUpdateResult>,
  opts: WorktreeCutoverCallOpts = {},
): Promise<WorktreeCutoverResult<WorktreeUpdateResult>> {
  if (client === null || !isWorktreeEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("toggle_worktree_rule_enabled",
    () => toggleWorktreeRuleEnabled(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function deleteWorktreeRuleWithCutover(
  client: PaperworkEngineClient | null,
  params: WorktreeDeleteParams,
  tsFallback: () => Promise<WorktreeDeleteResult>,
  opts: WorktreeCutoverCallOpts = {},
): Promise<WorktreeCutoverResult<WorktreeDeleteResult>> {
  if (client === null || !isWorktreeEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("delete_worktree_rule",
    () => deleteWorktreeRule(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listWorktreeRulesWithCutover(
  client: PaperworkEngineClient | null,
  params: WorktreeListParams,
  tsFallback: () => Promise<WorktreeListResult>,
  opts: WorktreeCutoverCallOpts = {},
): Promise<WorktreeCutoverResult<WorktreeListResult>> {
  if (client === null || !isWorktreeEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_worktree_rules",
    () => listWorktreeRules(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getWorktreeRuleByIdWithCutover(
  client: PaperworkEngineClient | null,
  params: WorktreeGetByIdParams,
  tsFallback: () => Promise<WorktreeGetResult>,
  opts: WorktreeCutoverCallOpts = {},
): Promise<WorktreeCutoverResult<WorktreeGetResult>> {
  if (client === null || !isWorktreeEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_worktree_rule_by_id",
    () => getWorktreeRuleById(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
