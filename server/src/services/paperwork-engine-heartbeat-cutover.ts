// [파일 목적] paperwork-engine heartbeat.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_ENGINE_HEARTBEAT_CUTOVER=1 이면 쓰기(claim_wakeup/transition_run_fenced)를
//   Rust RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS
//   작성자로 폴백하고, indeterminate 면 커밋 여부를 알 수 없으므로 절대 TS 폴백을
//   호출하지 않고 HeartbeatCutoverIndeterminateError 를 던진다(이중 적용 방지).
//   읽기(list_stale_runs)는 부작용이 없어 어떤 오류든 TS 폴백한다. 플래그 OFF·
//   null 클라이언트·엔진 표현 불가 입력은 RPC 없이 곧바로 TS 경로다.
// [외부 연결] paperwork-engine-heartbeat typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  HEARTBEAT_RUN_STATUSES, claimHeartbeatWakeup, classifyHeartbeatRpcError,
  listStaleHeartbeatRuns, transitionHeartbeatRunFenced,
  type HeartbeatClaimWakeupParams, type HeartbeatClaimedWakeup,
  type HeartbeatListStaleRunsParams, type HeartbeatRpcErrorClassification,
  type HeartbeatRunStatus, type HeartbeatStaleRun,
  type HeartbeatTransitionRunFencedParams, type HeartbeatTransitionRunFencedResult,
} from "./paperwork-engine-heartbeat.js";

export const HEARTBEAT_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const HEARTBEAT_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(HEARTBEAT_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : HEARTBEAT_CUTOVER_READ_TIMEOUT_MS;
}

export type HeartbeatCutoverSource = "rust" | "ts";
export interface HeartbeatCutoverResult<T> { source: HeartbeatCutoverSource; value: T }
export type HeartbeatCutoverOperation = "claim_wakeup" | "transition_run_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface HeartbeatCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class HeartbeatCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: HeartbeatCutoverOperation,
    readonly classification: HeartbeatRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`heartbeat cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "HeartbeatCutoverIndeterminateError";
  }
}

export function isHeartbeatEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_ENGINE_HEARTBEAT_CUTOVER === "1";
}

/** transition 의 TS 전용 입력 — 엔진은 status·error·error_code·파생
 *  타임스탬프만 쓰므로 나머지는 엔진 표현 불가로 TS 경로를 탄다. */
export interface HeartbeatTransitionRunFencedCutoverParams extends HeartbeatTransitionRunFencedParams {
  /** TS 작성자가 함께 적용하는 추가 컬럼(patch). 하나라도 있으면 엔진 표현 불가. */
  extra_patch?: Readonly<Record<string, unknown>> | null;
  /** expectedRun 실행자/행 정체 fence — 엔진은 run_id+company_id 만 본다. */
  expected_run?: unknown;
}

export function hasExtraPatchFields(
  params: Pick<HeartbeatTransitionRunFencedCutoverParams, "extra_patch">,
): boolean {
  return params.extra_patch != null && Object.keys(params.extra_patch).length > 0;
}
export function hasExpectedRunIdentityFence(
  params: Pick<HeartbeatTransitionRunFencedCutoverParams, "expected_run">,
): boolean {
  return params.expected_run != null;
}

const STATUS_SET: ReadonlySet<string> = new Set(HEARTBEAT_RUN_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStatus = (v: unknown): v is HeartbeatRunStatus =>
  typeof v === "string" && STATUS_SET.has(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// Mirrors LEGAL_NEXT in paperwork-engine-heartbeat.ts (engine-heartbeat
// RunStatus::is_legal_transition). A transition the engine rejects pre-send
// with RangeError must reach TS, not classify indeterminate after the fact.
const LEGAL_NEXT: Readonly<Record<HeartbeatRunStatus, ReadonlySet<HeartbeatRunStatus>>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["succeeded", "failed", "cancelled", "timed_out"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), timed_out: new Set(),
};

/** typed client 가 전송 전 RangeError 를 던질 모든 입력을 eligibility 로 미리
 *  걸러 TS 경로(오늘의 동작)를 유지한다 — 플래그 ON 이 새 실패 모드를 만들지 않게. */
function isTransitionEngineEligible(params: HeartbeatTransitionRunFencedCutoverParams): boolean {
  if (hasExpectedRunIdentityFence(params) || hasExtraPatchFields(params)) return false;
  if (!isUuid(params.run_id) || !isUuid(params.company_id)) return false;
  const { expected_statuses, next_status } = params;
  if (!isStatus(next_status) || !Array.isArray(expected_statuses) || expected_statuses.length === 0) {
    return false;
  }
  if ((params.error !== undefined && typeof params.error !== "string")
    || (params.error_code !== undefined && typeof params.error_code !== "string")) return false;
  // Index loop, not .every(): sparse arrays (Array(1)) skip holes in .every and
  // would read eligible, then throw a RangeError the engine never saw.
  for (let i = 0; i < expected_statuses.length; i++) {
    const from = expected_statuses[i];
    if (!isStatus(from) || !LEGAL_NEXT[from].has(next_status)) return false;
  }
  return true;
}

async function writeWithCutover<T>(
  operation: HeartbeatCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<HeartbeatCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyHeartbeatRpcError(error);
    if (classification.outcome === "not_committed") {
      logger.warn({ operation, kind: classification.kind, err: error },
        "paperwork-engine heartbeat write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new HeartbeatCutoverIndeterminateError(operation, classification, error);
  }
}

export async function claimWakeupWithCutover(
  client: PaperworkEngineClient | null,
  params: HeartbeatClaimWakeupParams,
  tsFallback: () => Promise<HeartbeatClaimedWakeup | null>,
  opts: HeartbeatCutoverCallOpts = {},
): Promise<HeartbeatCutoverResult<HeartbeatClaimedWakeup | null>> {
  if (client === null || !isHeartbeatEngineCutoverEnabled(opts.env)
    || !isUuid(params.company_id) || !isUuid(params.agent_id)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("claim_wakeup",
    () => claimHeartbeatWakeup(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function transitionRunFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: HeartbeatTransitionRunFencedCutoverParams,
  tsFallback: () => Promise<HeartbeatTransitionRunFencedResult>,
  opts: HeartbeatCutoverCallOpts = {},
): Promise<HeartbeatCutoverResult<HeartbeatTransitionRunFencedResult>> {
  if (client === null || !isHeartbeatEngineCutoverEnabled(opts.env)
    || !isTransitionEngineEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("transition_run_fenced",
    () => transitionHeartbeatRunFenced(client, params, { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listStaleRunsWithCutover(
  client: PaperworkEngineClient | null,
  params: HeartbeatListStaleRunsParams,
  tsFallback: () => Promise<HeartbeatStaleRun[]>,
  opts: HeartbeatCutoverCallOpts = {},
): Promise<HeartbeatCutoverResult<HeartbeatStaleRun[]>> {
  if (client === null || !isHeartbeatEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  try {
    return {
      source: "rust",
      value: await listStaleHeartbeatRuns(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    };
  } catch (error) {
    logger.warn({ operation: "list_stale_runs", err: error },
      "paperwork-engine heartbeat read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}
