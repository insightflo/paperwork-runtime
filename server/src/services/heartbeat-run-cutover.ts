// [파일 목적] paperwork-engine `heartbeat.run_agent` 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER=1(기본 OFF)이면 에이전트 스폰을 Rust RPC 로
//   먼저 시도한다. not_committed 로 분류된 오류만 TS 러너로 폴백하고, indeterminate
//   (전송 타임아웃·protocol_error·미분류)는 엔진이 이미 자식을 띄웠을 수 있어 TS
//   폴백 없이 HeartbeatRunCutoverIndeterminateError 를 던진다 — 폴백은 자식을
//   이중 스폰한다. unreaped_pid/reap_handoff_pending 성공 결과는 호출부가 wait/reap
//   을 독점 소유하므로 그대로 반환한다(재실행·폴백·시그널 금지).
// [외부 연결] paperwork-engine-heartbeat-run typed client(runHeartbeatAgent,
//   사전 RangeError 규칙 1:1 미러), paperwork-engine-heartbeat 의
//   classifyHeartbeatRpcError, middleware logger. 플래그 OFF·null 클라이언트·
//   allowlist 밖 어댑터·엔진 표현 불가 파라미터는 RPC 없이 곧바로 TS 경로다.
import path from "node:path";
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError,
  type HeartbeatRpcErrorClassification,
} from "./paperwork-engine-heartbeat.js";
import {
  HEARTBEAT_AGENT_ADAPTERS, HEARTBEAT_RUN_AGENT_MAX_GRACE_MS,
  HEARTBEAT_RUN_AGENT_MAX_TIMEOUT_MS, hasUnreapedChild, runHeartbeatAgent,
  type HeartbeatRunAgentParams, type HeartbeatRunAgentResult,
} from "./paperwork-engine-heartbeat-run.js";

/** RPC 로 보낼 수 있는 로컬 프로세스 어댑터 allowlist — typed client 의 엔진 지원 집합과 동일. */
export const HEARTBEAT_RUN_CUTOVER_ADAPTERS = HEARTBEAT_AGENT_ADAPTERS;

export type HeartbeatRunCutoverSource = "rust" | "ts";
export interface HeartbeatRunCutoverResult<T> { source: HeartbeatRunCutoverSource; value: T }
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface HeartbeatRunCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 이면 엔진이 자식을 이미 스폰했을 수 있어 TS 재실행이
 *  이중 스폰이 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class HeartbeatRunCutoverIndeterminateError extends Error {
  readonly operation = "run_agent" as const;
  constructor(
    readonly classification: HeartbeatRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super("heartbeat.run_agent cutover outcome is indeterminate; refusing TS fallback");
    this.name = "HeartbeatRunCutoverIndeterminateError";
  }
}

export function isHeartbeatRunCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER === "1";
}

const ADAPTER_SET: ReadonlySet<string> = new Set(HEARTBEAT_RUN_CUTOVER_ADAPTERS);
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isEngineAbsPath = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !v.includes("\0") && path.posix.isAbsolute(v);
const isIntInRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

// Index loop + own-key gate: a sparse hole — even one backed by an inherited
// string index — reads eligible under .every but throws RangeError client-side.
function areArgsEngineEligible(args: readonly string[] | undefined): boolean {
  if (args === undefined) return true;
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i++) {
    if (!Object.hasOwn(args, i)) return false;
    const a = args[i];
    if (typeof a !== "string" || a.includes("\0")) return false;
  }
  return true;
}

function isEnvEngineEligible(env: Readonly<Record<string, string>> | undefined): boolean {
  if (env === undefined) return true;
  if (!isRec(env)) return false;
  const proto = Object.getPrototypeOf(env);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(env)) {
    if (key === "" || key.includes("=") || key.includes("\0")) return false;
    const val = env[key];
    if (typeof val !== "string" || val.includes("\0")) return false;
  }
  return true;
}

/** runHeartbeatAgent 가 전송 전 던지는 모든 RangeError 조건을 미리 재현한다.
 *  엔진 표현 불가 입력은 TS 경로(오늘의 동작)를 유지해, 플래그 ON 이 새 실패
 *  모드를 만들지 않게 한다 — 사전 RangeError 는 어떤 바이트도 보내지 않으므로
 *  TS 폴백이 안전하다. */
export function isHeartbeatRunAgentParamsEligible(params: HeartbeatRunAgentParams): boolean {
  if (typeof params.adapter !== "string" || !ADAPTER_SET.has(params.adapter)) return false;
  if (!isEngineAbsPath(params.executable) || !isEngineAbsPath(params.cwd)) return false;
  if (!isIntInRange(params.timeout_ms, 1, HEARTBEAT_RUN_AGENT_MAX_TIMEOUT_MS)) return false;
  if (params.grace_ms !== undefined
    && !isIntInRange(params.grace_ms, 0, HEARTBEAT_RUN_AGENT_MAX_GRACE_MS)) return false;
  return areArgsEngineEligible(params.args) && isEnvEngineEligible(params.env);
}

/** opts.timeoutMs 를 클라이언트가 요구하는 정수 [1, 600_000] 으로 클램프한다.
 *  부재·비유한 입력은 undefined — typed client 가 timeout_ms+grace_ms+5s 파생
 *  transport deadline 을 그대로 쓴다. */
function cutoverTimeoutMs(requested: number | undefined): number | undefined {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return undefined;
  return Math.min(600_000, Math.max(1, Math.trunc(requested)));
}

/** Best-effort warn — logger 직렬화 실패가 컷오버 결과를 가리면 안 된다. */
function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Logging must never mask the primary cutover outcome.
  }
}

export async function runHeartbeatAgentWithCutover(
  client: PaperworkEngineClient | null,
  params: HeartbeatRunAgentParams,
  tsFallback: () => Promise<HeartbeatRunAgentResult>,
  opts: HeartbeatRunCutoverCallOpts = {},
): Promise<HeartbeatRunCutoverResult<HeartbeatRunAgentResult>> {
  if (client === null || !isHeartbeatRunCutoverEnabled(opts.env)
    || !isHeartbeatRunAgentParamsEligible(params)) {
    return { source: "ts", value: await tsFallback() };
  }
  const timeoutMs = cutoverTimeoutMs(opts.timeoutMs);
  try {
    const value = await runHeartbeatAgent(
      client, params, timeoutMs === undefined ? undefined : { timeoutMs });
    if (hasUnreapedChild(value)) {
      // unreaped_pid / reap_handoff_pending: the engine handed exclusive
      // wait/reap ownership of a live child to the caller. Return the result
      // AS-IS — never re-run, never fall back, never signal that child.
      return { source: "rust", value };
    }
    return { source: "rust", value };
  } catch (error) {
    const classification = classifyHeartbeatRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation: "run_agent", kind: classification.kind, err: error },
        "paperwork-engine heartbeat.run_agent not committed; falling back to TS runner");
      return { source: "ts", value: await tsFallback() };
    }
    throw new HeartbeatRunCutoverIndeterminateError(classification, error);
  }
}
