// [파일 목적] resident paperwork-engine `heartbeat.run_agent` typed RPC client —
//   crates/paperwork-engine/src/heartbeat_run.rs·engine-heartbeat/src/runner.rs 의
//   RunAgentParams/AgentRunResult 와 필드명·범위·에러 계약을 1:1 로 맞춘 fail-closed
//   경계 계층. 실행 권한은 엔진의 supervised runner 이며 TS는 직렬화·응답 검증·
//   transport deadline 파생만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat HEARTBEAT_RUN_STATUSES, heartbeat supervisor 호출부.
import path from "node:path";
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import { HEARTBEAT_RUN_STATUSES, type HeartbeatRunStatus } from "./paperwork-engine-heartbeat.js";

export const HEARTBEAT_AGENT_ADAPTERS = ["pi_local", "commandcode_local"] as const;
export type HeartbeatAgentAdapter = (typeof HEARTBEAT_AGENT_ADAPTERS)[number];
export const HEARTBEAT_RUN_AGENT_MAX_TIMEOUT_MS = 3_600_000;
export const HEARTBEAT_RUN_AGENT_MAX_GRACE_MS = 60_000;
export const HEARTBEAT_RUN_AGENT_DEFAULT_GRACE_MS = 5_000; // Rust default_grace_ms

// Mirrors RunAgentParams (#[serde(deny_unknown_fields)]): the wire object is
// rebuilt field-by-field below so extra properties can never reach the engine.
export interface HeartbeatRunAgentParams {
  adapter: HeartbeatAgentAdapter;
  executable: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd: string;
  timeout_ms: number;
  grace_ms?: number;
}

// Mirrors AgentRunResult -> heartbeat_run.rs result_to_json.
export interface HeartbeatRunAgentResult {
  status: HeartbeatRunStatus;
  exit_code: number | null;
  signal: number | null;
  error: string | null;
  error_code: string | null;
  /** Non-null => caller holds exclusive wait/reap ownership of this child. */
  unreaped_pid: number | null;
  stdout_excerpt: string;
  stderr_excerpt: string;
  stdout_captured_bytes: number;
  stderr_captured_bytes: number;
}

// PaperworkEngineClient accepts callOpts.timeoutMs integers in [1, 600_000].
const MAX_CLIENT_TIMEOUT_MS = 600_000;
const RUN_STATUS_SET: ReadonlySet<string> = new Set(HEARTBEAT_RUN_STATUSES);
const ADAPTER_SET: ReadonlySet<string> = new Set(HEARTBEAT_AGENT_ADAPTERS);
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isRunStatus = (v: unknown): v is HeartbeatRunStatus =>
  typeof v === "string" && RUN_STATUS_SET.has(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isIntOrNull = (v: unknown): v is number | null => v === null || Number.isInteger(v);
const isPosIntOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isInteger(v) && v > 0);
const isNonNegSafeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function proto(msg: string): PaperworkEngineError {
  return new PaperworkEngineError("protocol_error", msg);
}
function checkAdapter(v: unknown): HeartbeatAgentAdapter {
  if (typeof v !== "string" || !ADAPTER_SET.has(v)) {
    throw new RangeError(`adapter must be one of: ${HEARTBEAT_AGENT_ADAPTERS.join(", ")}`);
  }
  return v as HeartbeatAgentAdapter;
}
function checkAbsPath(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "" || v.includes("\0") || !path.posix.isAbsolute(v)) {
    throw new RangeError(`${name} must be a non-empty absolute path with no NUL bytes`);
  }
  return v;
}
// Index loop (not .every): a sparse-array hole reads as undefined and fails closed.
function checkArgs(v: readonly string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new RangeError("args must be an array of strings");
  const out: string[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    if (typeof a !== "string" || a.includes("\0")) {
      throw new RangeError(`args[${i}] must be a string with no NUL bytes`);
    }
    out[i] = a;
  }
  return out;
}
function checkEnv(v: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isRec(v)) throw new RangeError("env must be a record of string values");
  const out: Record<string, string> = {};
  for (const key of Object.keys(v)) {
    if (key === "" || key.includes("=") || key.includes("\0")) {
      throw new RangeError(`env key ${JSON.stringify(key)} must be non-empty with no '=' or NUL bytes`);
    }
    const val = v[key];
    if (typeof val !== "string" || val.includes("\0")) {
      throw new RangeError(`env[${JSON.stringify(key)}] must be a string with no NUL bytes`);
    }
    out[key] = val;
  }
  return out;
}
function checkIntRange(v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new RangeError(`${name} must be an integer in [${lo}, ${hi}]`);
  }
  return v;
}

// Bounds the RPC transport slightly past the run's own deadline: the engine's
// timeout_ms + grace_ms already terminates the child, so +5s is transport slack.
function deriveTransportTimeoutMs(params: HeartbeatRunAgentParams): number {
  return Math.min(MAX_CLIENT_TIMEOUT_MS,
    params.timeout_ms + (params.grace_ms ?? HEARTBEAT_RUN_AGENT_DEFAULT_GRACE_MS) + 5_000);
}

function toRunAgentResult(v: unknown): HeartbeatRunAgentResult {
  if (!isRec(v) || !isRunStatus(v.status)
    || !isIntOrNull(v.exit_code) || !isIntOrNull(v.signal)
    || !isStrOrNull(v.error) || !isStrOrNull(v.error_code)
    || !isPosIntOrNull(v.unreaped_pid)
    || typeof v.stdout_excerpt !== "string" || typeof v.stderr_excerpt !== "string"
    || !isNonNegSafeInt(v.stdout_captured_bytes) || !isNonNegSafeInt(v.stderr_captured_bytes)) {
    throw proto("bad heartbeat.run_agent result shape");
  }
  return {
    status: v.status, exit_code: v.exit_code, signal: v.signal,
    error: v.error, error_code: v.error_code, unreaped_pid: v.unreaped_pid,
    stdout_excerpt: v.stdout_excerpt, stderr_excerpt: v.stderr_excerpt,
    stdout_captured_bytes: v.stdout_captured_bytes, stderr_captured_bytes: v.stderr_captured_bytes,
  };
}

type CallOpts = { timeoutMs?: number };

export async function runHeartbeatAgent(
  client: PaperworkEngineClient, params: HeartbeatRunAgentParams, callOpts?: CallOpts,
): Promise<HeartbeatRunAgentResult> {
  const wire: Record<string, unknown> = {
    adapter: checkAdapter(params.adapter),
    executable: checkAbsPath(params.executable, "executable"),
    cwd: checkAbsPath(params.cwd, "cwd"),
    timeout_ms: checkIntRange(params.timeout_ms, "timeout_ms", 1, HEARTBEAT_RUN_AGENT_MAX_TIMEOUT_MS),
  };
  const args = checkArgs(params.args);
  if (args !== undefined) wire.args = args;
  const env = checkEnv(params.env);
  if (env !== undefined) wire.env = env;
  if (params.grace_ms !== undefined) {
    wire.grace_ms = checkIntRange(params.grace_ms, "grace_ms", 0, HEARTBEAT_RUN_AGENT_MAX_GRACE_MS);
  }
  const timeoutMs = callOpts?.timeoutMs === undefined
    ? deriveTransportTimeoutMs(params)
    : checkIntRange(callOpts.timeoutMs, "callOpts.timeoutMs", 1, MAX_CLIENT_TIMEOUT_MS);
  const result = await client.call<unknown>("heartbeat.run_agent", wire, { timeoutMs });
  return toRunAgentResult(result);
}

/** True when the run handed an unreaped child to the caller: that pid MUST be
 *  exclusively reaped by the caller and MUST NOT be signaled or re-dispatched. */
export function hasUnreapedChild(result: HeartbeatRunAgentResult): boolean {
  return result.unreaped_pid !== null || result.error_code === "reap_handoff_pending";
}
