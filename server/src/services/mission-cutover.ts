// [파일 목적] paperwork-engine mission.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_MISSION_CUTOVER=1 이면 쓰기(transition_status_fenced/
//   bump_rolling_state_fenced)를 Rust RPC 로 먼저 시도한다. 응답이 not_committed
//   로 분류되면 경고 후 기존 TS 작성자로 폴백하고, indeterminate 면 커밋 여부를
//   알 수 없으므로 절대 TS 폴백을 호출하지 않고 MissionCutoverIndeterminateError
//   를 던진다(이중 적용 방지). 읽기(get/list_by_company/get_rolling_state/
//   list_sessions)는 부작용이 없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null
//   클라이언트는 RPC 없이 곧바로 TS 경로다. typed client 의 전송 전 RangeError
//   는 미전송이지만 미분류 입력이므로 budget 컷오버와 같은 fail-closed 분류
//   (indeterminate)를 따른다. fence 미적용 응답({applied:false})은 성공
//   결과이므로 폴백 없이 그대로 반환한다.
// [외부 연결] paperwork-engine-mission typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  bumpMissionRollingStateFenced, classifyMissionRpcError, getMission,
  getMissionRollingState, listMissionSessions, listMissionsByCompany,
  transitionMissionStatusFenced,
  type MissionBumpRollingStateFencedParams, type MissionBumpRollingStateFencedResult,
  type MissionGetParams, type MissionGetResult, type MissionGetRollingStateParams,
  type MissionGetRollingStateResult, type MissionListByCompanyParams,
  type MissionListByCompanyResult, type MissionListSessionsParams,
  type MissionListSessionsResult, type MissionRpcErrorClassification,
  type MissionTransitionStatusFencedParams, type MissionTransitionStatusFencedResult,
} from "./paperwork-engine-mission.js";

export const MISSION_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const MISSION_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(MISSION_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : MISSION_CUTOVER_READ_TIMEOUT_MS;
}

export type MissionCutoverSource = "rust" | "ts";
export interface MissionCutoverResult<T> { source: MissionCutoverSource; value: T }
export type MissionCutoverOperation = "transition_status_fenced" | "bump_rolling_state_fenced";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface MissionCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class MissionCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: MissionCutoverOperation,
    readonly classification: MissionRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`mission cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "MissionCutoverIndeterminateError";
  }
}

export function isMissionEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_MISSION_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: MissionCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<MissionCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifyMissionRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine mission write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new MissionCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: string,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<MissionCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine mission read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function transitionMissionStatusFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: MissionTransitionStatusFencedParams,
  tsFallback: () => Promise<MissionTransitionStatusFencedResult>,
  opts: MissionCutoverCallOpts = {},
): Promise<MissionCutoverResult<MissionTransitionStatusFencedResult>> {
  if (client === null || !isMissionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("transition_status_fenced",
    () => transitionMissionStatusFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function bumpMissionRollingStateFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: MissionBumpRollingStateFencedParams,
  tsFallback: () => Promise<MissionBumpRollingStateFencedResult>,
  opts: MissionCutoverCallOpts = {},
): Promise<MissionCutoverResult<MissionBumpRollingStateFencedResult>> {
  if (client === null || !isMissionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("bump_rolling_state_fenced",
    () => bumpMissionRollingStateFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getMissionWithCutover(
  client: PaperworkEngineClient | null,
  params: MissionGetParams,
  tsFallback: () => Promise<MissionGetResult>,
  opts: MissionCutoverCallOpts = {},
): Promise<MissionCutoverResult<MissionGetResult>> {
  if (client === null || !isMissionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get",
    () => getMission(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listMissionsByCompanyWithCutover(
  client: PaperworkEngineClient | null,
  params: MissionListByCompanyParams,
  tsFallback: () => Promise<MissionListByCompanyResult>,
  opts: MissionCutoverCallOpts = {},
): Promise<MissionCutoverResult<MissionListByCompanyResult>> {
  if (client === null || !isMissionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_by_company",
    () => listMissionsByCompany(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getMissionRollingStateWithCutover(
  client: PaperworkEngineClient | null,
  params: MissionGetRollingStateParams,
  tsFallback: () => Promise<MissionGetRollingStateResult>,
  opts: MissionCutoverCallOpts = {},
): Promise<MissionCutoverResult<MissionGetRollingStateResult>> {
  if (client === null || !isMissionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_rolling_state",
    () => getMissionRollingState(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listMissionSessionsWithCutover(
  client: PaperworkEngineClient | null,
  params: MissionListSessionsParams,
  tsFallback: () => Promise<MissionListSessionsResult>,
  opts: MissionCutoverCallOpts = {},
): Promise<MissionCutoverResult<MissionListSessionsResult>> {
  if (client === null || !isMissionEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_sessions",
    () => listMissionSessions(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
