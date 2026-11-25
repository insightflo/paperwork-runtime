// [파일 목적] paperwork-engine approval.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_ENGINE_APPROVAL_CUTOVER=1 이면 쓰기(create/resolve_fenced/
//   request_revision_fenced/resubmit_fenced/cancel_fenced)를 Rust RPC 로 먼저
//   시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS 작성자로 폴백하고,
//   indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을 호출하지 않고
//   ApprovalCutoverIndeterminateError 를 던진다(이중 적용 방지). 읽기(get/list)는
//   부작용이 없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null 클라이언트·엔진 표현
//   불가 입력은 RPC 없이 곧바로 TS 경로다.
// [외부 연결] paperwork-engine-approval typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  APPROVAL_RESOLVE_TARGETS, cancelApprovalFenced, classifyApprovalRpcError,
  createApproval, getApproval, listApprovals, requestApprovalRevisionFenced,
  resubmitApprovalFenced, resolveApprovalFenced,
  type Approval, type ApprovalCreateParams, type ApprovalCreateResult,
  type ApprovalListParams, type ApprovalResolveParams, type ApprovalResolveResult,
  type ApprovalResubmitParams, type ApprovalRevisionParams,
  type ApprovalRpcErrorClassification, type ApprovalScopedParams,
  type ApprovalUpdatedResult,
} from "./paperwork-engine-approval.js";

export const APPROVAL_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const APPROVAL_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(APPROVAL_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : APPROVAL_CUTOVER_READ_TIMEOUT_MS;
}

export type ApprovalCutoverSource = "rust" | "ts";
export interface ApprovalCutoverResult<T> { source: ApprovalCutoverSource; value: T }
export type ApprovalCutoverOperation =
  "create" | "resolve_fenced" | "request_revision_fenced" | "resubmit_fenced" | "cancel_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface ApprovalCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class ApprovalCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: ApprovalCutoverOperation,
    readonly classification: ApprovalRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`approval cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "ApprovalCutoverIndeterminateError";
  }
}

export function isApprovalEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_ENGINE_APPROVAL_CUTOVER === "1";
}

const RESOLVE_TARGET_SET: ReadonlySet<string> = new Set(APPROVAL_RESOLVE_TARGETS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isOptUuid = (v: unknown): boolean => v === undefined || isUuid(v);
const isOptStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const isActor = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isScopedEngineEligible = (p: ApprovalScopedParams): boolean =>
  isUuid(p.approval_id) && isUuid(p.company_id);

/** typed client 가 전송 전 RangeError 를 던질 모든 입력을 eligibility 로 미리
 *  걸러 TS 경로(오늘의 동작)를 유지한다 — 플래그 ON 이 새 실패 모드를 만들지 않게.
 *  (approval.* RangeError 는 분류상 indeterminate 라 걸러내지 않으면 TS 도달 전
 *  IndeterminateError 가 된다.) */
const isCreateEngineEligible = (p: ApprovalCreateParams): boolean =>
  isUuid(p.company_id) && typeof p.approval_type === "string" && p.approval_type.length > 0
  && p.payload !== undefined && isOptUuid(p.requested_by_agent_id)
  && isOptStr(p.requested_by_user_id) && isOptStr(p.requested_by_plugin_id);
const isResolveEngineEligible = (p: ApprovalResolveParams): boolean =>
  isScopedEngineEligible(p) && typeof p.target_status === "string"
  && RESOLVE_TARGET_SET.has(p.target_status) && isActor(p.decided_by_user_id)
  && isOptStr(p.decision_note);
const isRevisionEngineEligible = (p: ApprovalRevisionParams): boolean =>
  isScopedEngineEligible(p) && isActor(p.decided_by_user_id) && isOptStr(p.decision_note);

/** logger 경고는 best-effort — transport 예외가 컷오버 판단을 바꾸면 안 된다. */
function warnBestEffort(fields: Record<string, unknown>, message: string): void {
  try { logger.warn(fields, message); } catch { /* logging must never block cutover */ }
}

async function writeWithCutover<T>(
  operation: ApprovalCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<ApprovalCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyApprovalRpcError(error);
    if (classification.outcome === "not_committed") {
      warnBestEffort({ operation, kind: classification.kind, err: error },
        "paperwork-engine approval write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new ApprovalCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: "get" | "list",
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<ApprovalCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    warnBestEffort({ operation, err: error },
      "paperwork-engine approval read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function createApprovalWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalCreateParams,
  tsFallback: () => Promise<ApprovalCreateResult>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<ApprovalCreateResult>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env) || !isCreateEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("create",
    () => createApproval(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function resolveApprovalFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalResolveParams,
  tsFallback: () => Promise<ApprovalResolveResult>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<ApprovalResolveResult>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env) || !isResolveEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("resolve_fenced",
    () => resolveApprovalFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function requestApprovalRevisionFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalRevisionParams,
  tsFallback: () => Promise<ApprovalUpdatedResult>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<ApprovalUpdatedResult>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env) || !isRevisionEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("request_revision_fenced",
    () => requestApprovalRevisionFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function resubmitApprovalFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalResubmitParams,
  tsFallback: () => Promise<ApprovalUpdatedResult>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<ApprovalUpdatedResult>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env) || !isScopedEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("resubmit_fenced",
    () => resubmitApprovalFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function cancelApprovalFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalScopedParams,
  tsFallback: () => Promise<ApprovalUpdatedResult>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<ApprovalUpdatedResult>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env) || !isScopedEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("cancel_fenced",
    () => cancelApprovalFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getApprovalWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalScopedParams,
  tsFallback: () => Promise<Approval | null>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<Approval | null>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get",
    () => getApproval(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listApprovalsWithCutover(
  client: PaperworkEngineClient | null,
  params: ApprovalListParams,
  tsFallback: () => Promise<Approval[]>,
  opts: ApprovalCutoverCallOpts = {},
): Promise<ApprovalCutoverResult<Approval[]>> {
  if (client === null || !isApprovalEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list",
    () => listApprovals(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
