// [파일 목적] resident paperwork-engine `agent.*` typed RPC client — Rust
//   crates/paperwork-engine/src/agent.rs·engine-agent/{lib,queries}.rs 와
//   필드명·에러 코드·applied union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, agent 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const AGENT_STATUSES = [
  "active", "paused", "idle", "running", "error", "pending_approval", "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface Agent {
  id: string; company_id: string; name: string; role: string;
  title: string | null; icon: string | null; status: AgentStatus;
  reports_to: string | null; capabilities: string | null; adapter_type: string;
  adapter_config: unknown; agent_config: unknown; runtime_config: unknown;
  budget_monthly_cents: number; spent_monthly_cents: number;
  pause_reason: string | null; paused_at: string | null; permissions: unknown;
  last_heartbeat_at: string | null; metadata: unknown; created_at: string; updated_at: string;
}
export interface AgentTaskSession {
  id: string; company_id: string; agent_id: string; adapter_type: string; task_key: string;
  session_params_json: unknown; session_display_id: string | null; last_run_id: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}
export interface AgentToolGrant {
  id: string; company_id: string; agent_id: string; tool_id: string; granted_by: string; created_at: string;
}

export interface AgentGetParams { company_id: string; agent_id: string }
export interface AgentGetResult { agent: Agent | null }
export interface AgentListByCompanyParams { company_id: string }
export interface AgentListByCompanyResult { agents: Agent[] }
export interface AgentListTaskSessionsParams { company_id: string; agent_id?: string | null }
export interface AgentListTaskSessionsResult { sessions: AgentTaskSession[] }
export interface AgentListToolGrantsParams { company_id: string; agent_id?: string | null }
export interface AgentListToolGrantsResult { grants: AgentToolGrant[] }
export interface AgentTransitionStatusFencedParams {
  company_id: string; agent_id: string; expected_status: AgentStatus;
  new_status: AgentStatus; pause_reason?: string | null;
}
export type AgentTransitionStatusFencedResult =
  | { applied: true; agent: Agent }
  | { applied: false; reason: "fenced" };

// agent.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type AgentRpcErrorKind = HeartbeatRpcErrorKind;
export type AgentCommitOutcome = HeartbeatCommitOutcome;
export type AgentRpcErrorClassification = HeartbeatRpcErrorClassification;

const STATUS_SET: ReadonlySet<string> = new Set(AGENT_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isUuidOrNull = (v: unknown): v is string | null => v === null || isUuid(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isAgentStatus = (v: unknown): v is AgentStatus => isStr(v) && STATUS_SET.has(v);
// jsonb fields serialize any serde_json::Value (or Option<Value> -> null); the
// key must be present but the value itself is unconstrained.
const isJson = (v: unknown): boolean => v !== undefined;
// Date.parse normalizes hour 24 and out-of-range fields Chrono rejects; the
// regex pins unsigned 2-digit fields, so only upper bounds need checking.
const isTs = (v: unknown): v is string => {
  if (!isStr(v) || !RFC3339_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [hh, mm, ss] = v.slice(11, 19).split(":").map(Number);
  if (hh > 23 || mm > 59 || ss > 59) return false;
  if (!v.endsWith("Z") && (Number(v.slice(-5, -3)) > 23 || Number(v.slice(-2)) > 59)) return false;
  const [y, mo, d] = v.slice(0, 10).split("-").map(Number);
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
  return dt.toISOString().slice(0, 10) === v.slice(0, 10);
};
const isTsOrNull = (v: unknown): v is string | null => v === null || isTs(v);

const proto = (msg: string) => new PaperworkEngineError("protocol_error", msg);
const make = <T>(guard: (v: unknown) => v is T, msg: string) => (v: unknown, name: string): T => {
  if (!guard(v)) throw new RangeError(`${name} must be ${msg}`); return v;
};
const checkUuid = make(isUuid, "a UUID string");
const checkStr = make(isStr, "a string");
const checkAgentStatus = make(isAgentStatus, "a valid agent status");
// serde #[serde(default)] Option<T>: undefined and null both mean the key is
// omitted from the wire object (None on the Rust side either way).
const checkOptUuid = (v: unknown, n: string) => (v === undefined || v === null ? undefined : checkUuid(v, n));
const checkOptStr = (v: unknown, n: string) => (v === undefined || v === null ? undefined : checkStr(v, n));

// engine-agent validate_agent_transition: terminated is terminal,
// pending_approval leaves only via idle|terminated, the operational set is
// fully connected minus self-loops, and pending_approval is never a target.
const checkLegalTransition = (from: AgentStatus, to: AgentStatus): void => {
  const legal = from === "terminated" ? false
    : from === "pending_approval" ? (to === "idle" || to === "terminated")
    : from !== to && to !== "pending_approval";
  if (!legal) throw new RangeError(`illegal agent status transition: ${from} -> ${to}`);
};

/** Classifies a rejected agent.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyAgentRpcError = (error: unknown): AgentRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const AGENT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["name", isStr], ["role", isStr],
  ["title", isStrOrNull], ["icon", isStrOrNull], ["status", isAgentStatus],
  ["reports_to", isUuidOrNull], ["capabilities", isStrOrNull], ["adapter_type", isStr],
  ["adapter_config", isJson], ["agent_config", isJson], ["runtime_config", isJson],
  ["budget_monthly_cents", isI32], ["spent_monthly_cents", isI32],
  ["pause_reason", isStrOrNull], ["paused_at", isTsOrNull], ["permissions", isJson],
  ["last_heartbeat_at", isTsOrNull], ["metadata", isJson], ["created_at", isTs], ["updated_at", isTs],
] as const;
const SESSION_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["agent_id", isUuid], ["adapter_type", isStr],
  ["task_key", isStr], ["session_params_json", isJson], ["session_display_id", isStrOrNull],
  ["last_run_id", isUuidOrNull], ["last_error", isStrOrNull], ["created_at", isTs], ["updated_at", isTs],
] as const;
const GRANT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["agent_id", isUuid], ["tool_id", isUuid],
  ["granted_by", isStr], ["created_at", isTs],
] as const;
const toAgent = (v: unknown): Agent => row(v, AGENT_ROW, "agent row");
const toSession = (v: unknown): AgentTaskSession => row(v, SESSION_ROW, "agent task session row");
const toGrant = (v: unknown): AgentToolGrant => row(v, GRANT_ROW, "agent tool grant row");

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };
const checkMaybeAgentParams = (p: { company_id: string; agent_id?: string | null }) => {
  const wire: Record<string, unknown> = { company_id: checkUuid(p.company_id, "company_id") };
  const agentId = checkOptUuid(p.agent_id, "agent_id");
  if (agentId !== undefined) wire.agent_id = agentId;
  return wire;
};

export async function getAgent(
  client: PaperworkEngineClient, params: AgentGetParams, callOpts?: CallOpts,
): Promise<AgentGetResult> {
  const result = await client.call<unknown>("agent.get", {
    company_id: checkUuid(params.company_id, "company_id"),
    agent_id: checkUuid(params.agent_id, "agent_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["agent"])) throw proto("bad agent.get result shape");
  return { agent: result.agent === null ? null : toAgent(result.agent) };
}

export async function listAgentsByCompany(
  client: PaperworkEngineClient, params: AgentListByCompanyParams, callOpts?: CallOpts,
): Promise<AgentListByCompanyResult> {
  const result = await client.call<unknown>("agent.list_by_company", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["agents"]) || !Array.isArray(result.agents)) {
    throw proto("bad agent.list_by_company result shape");
  }
  return { agents: result.agents.map(toAgent) };
}

export async function listAgentTaskSessions(
  client: PaperworkEngineClient, params: AgentListTaskSessionsParams, callOpts?: CallOpts,
): Promise<AgentListTaskSessionsResult> {
  const result = await client.call<unknown>("agent.list_task_sessions",
    checkMaybeAgentParams(params), callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["sessions"]) || !Array.isArray(result.sessions)) {
    throw proto("bad agent.list_task_sessions result shape");
  }
  return { sessions: result.sessions.map(toSession) };
}

export async function listAgentToolGrants(
  client: PaperworkEngineClient, params: AgentListToolGrantsParams, callOpts?: CallOpts,
): Promise<AgentListToolGrantsResult> {
  const result = await client.call<unknown>("agent.list_tool_grants",
    checkMaybeAgentParams(params), callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["grants"]) || !Array.isArray(result.grants)) {
    throw proto("bad agent.list_tool_grants result shape");
  }
  return { grants: result.grants.map(toGrant) };
}

export async function transitionAgentStatusFenced(
  client: PaperworkEngineClient, params: AgentTransitionStatusFencedParams, callOpts?: CallOpts,
): Promise<AgentTransitionStatusFencedResult> {
  // agent.rs deserializes (and type-gates) every field before the legality
  // matrix, so all field checks run first here too.
  const from = checkAgentStatus(params.expected_status, "expected_status");
  const to = checkAgentStatus(params.new_status, "new_status");
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    agent_id: checkUuid(params.agent_id, "agent_id"),
    expected_status: from, new_status: to,
  };
  const pauseReason = checkOptStr(params.pause_reason, "pause_reason");
  if (pauseReason !== undefined) wire.pause_reason = pauseReason;
  checkLegalTransition(from, to);
  const result = await client.call<unknown>("agent.transition_status_fenced", wire, callOpts);
  if (!isRec(result) || typeof result.applied !== "boolean") {
    throw proto("bad agent.transition_status_fenced result shape");
  }
  if (!result.applied) {
    if (!hasExactKeys(result, ["applied", "reason"]) || result.reason !== "fenced") {
      throw proto("bad agent.transition_status_fenced result shape");
    }
    return { applied: false, reason: "fenced" };
  }
  if (!hasExactKeys(result, ["applied", "agent"])) {
    throw proto("bad agent.transition_status_fenced result shape");
  }
  return { applied: true, agent: toAgent(result.agent) };
}
