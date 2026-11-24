// [파일 목적] resident paperwork-engine `mission.*` typed RPC client — Rust
//   crates/paperwork-engine/src/mission.rs·engine-mission/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, mission 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const MISSION_STATUSES = ["planning", "active", "completed", "cancelled", "paused"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export interface Mission {
  id: string; company_id: string; owner_agent_id: string; title: string;
  description: string | null; status: MissionStatus; goal_id: string | null;
  project_id: string | null; source_mission_id: string | null;
  source_workflow_run_id: string | null; started_at: string | null;
  completed_at: string | null; created_at: string; updated_at: string;
}
export interface MissionRollingState {
  id: string; company_id: string; mission_id: string; revision: number; status: string;
  state_markdown: string; state_json: unknown; last_run_id: string | null;
  last_compacted_at: string | null; total_runs: number; total_input_tokens: number;
  total_output_tokens: number; total_cost_cents: number; created_at: string; updated_at: string;
}
export interface MissionSession {
  id: string; mission_id: string; agent_id: string; company_id: string;
  session_secret_id: string; adapter_type: string; status: string; last_active_at: string;
  run_count: number; expires_at: string | null; created_at: string;
}
export interface MissionGetParams { mission_id: string; company_id: string }
export interface MissionGetResult { mission: Mission | null }
export interface MissionListByCompanyParams {
  company_id: string; status?: MissionStatus | null; limit: number;
}
export interface MissionListByCompanyResult { missions: Mission[] }
export interface MissionGetRollingStateParams { mission_id: string; company_id: string }
export interface MissionGetRollingStateResult { rolling_state: MissionRollingState | null }
export interface MissionListSessionsParams { mission_id: string; company_id: string }
export interface MissionListSessionsResult { sessions: MissionSession[] }
export interface MissionTransitionStatusFencedParams {
  mission_id: string; company_id: string; expected_status: MissionStatus; next_status: MissionStatus;
}
export type MissionTransitionStatusFencedResult = { applied: true; mission: Mission } | { applied: false };
export interface MissionBumpRollingStateFencedParams {
  mission_id: string; company_id: string;
  expected_revision: number; state_json: unknown; state_markdown: string;
}
export type MissionBumpRollingStateFencedResult =
  | { applied: true; rolling_state: MissionRollingState } | { applied: false };

// mission.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type MissionRpcErrorKind = HeartbeatRpcErrorKind;
export type MissionCommitOutcome = HeartbeatCommitOutcome;
export type MissionRpcErrorClassification = HeartbeatRpcErrorClassification;

const STATUS_SET: ReadonlySet<string> = new Set(MISSION_STATUSES);
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
const isI64 = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isI32 = (v: unknown): v is number => isI64(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isMissionStatus = (v: unknown): v is MissionStatus => isStr(v) && STATUS_SET.has(v);
const isJsonValue = (v: unknown): v is unknown => v !== undefined;
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
const checkMissionStatus = make(isMissionStatus, "a valid mission status");
const checkI64 = make(isI64, "a 64-bit safe integer");
const checkI32 = make(isI32, "a 32-bit signed integer");
// serde Option<MissionStatus>: undefined keeps the key off the wire, null -> None.
const checkOptStatus = (v: unknown, n: string) => (v === undefined || v === null ? v : checkMissionStatus(v, n));
// state_json is serde_json::Value: any JSON value; undefined/function/symbol/bigint cannot serialize.
const checkJson = (v: unknown, name: string): unknown => {
  const t = typeof v;
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    throw new RangeError(`${name} must be a JSON value`);
  }
  return v;
};
// Params mirror Rust #[serde(deny_unknown_fields)]: unknown own keys and
// missing required keys are rejected before any RPC.
const checkKeys = (v: unknown, required: readonly string[], optional: readonly string[] = []): void => {
  if (!isRec(v)) throw new RangeError("params must be an object");
  const allowed = new Set([...required, ...optional]);
  if (!required.every((k) => Object.hasOwn(v, k)) || Object.keys(v).some((k) => !allowed.has(k))) {
    throw new RangeError(`params must have keys ${required.join(",")}`);
  }
};

/** Classifies a rejected mission.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyMissionRpcError = (error: unknown): MissionRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const MISSION_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["owner_agent_id", isUuid], ["title", isStr],
  ["description", isStrOrNull], ["status", isMissionStatus], ["goal_id", isUuidOrNull],
  ["project_id", isUuidOrNull], ["source_mission_id", isUuidOrNull],
  ["source_workflow_run_id", isUuidOrNull], ["started_at", isTsOrNull],
  ["completed_at", isTsOrNull], ["created_at", isTs], ["updated_at", isTs],
] as const;
const ROLLING_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["mission_id", isUuid], ["revision", isI64],
  ["status", isStr], ["state_markdown", isStr], ["state_json", isJsonValue],
  ["last_run_id", isUuidOrNull], ["last_compacted_at", isTsOrNull], ["total_runs", isI64],
  ["total_input_tokens", isI64], ["total_output_tokens", isI64], ["total_cost_cents", isI64],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const SESSION_ROW = [
  ["id", isUuid], ["mission_id", isUuid], ["agent_id", isUuid], ["company_id", isUuid],
  ["session_secret_id", isUuid], ["adapter_type", isStr], ["status", isStr],
  ["last_active_at", isTs], ["run_count", isI64], ["expires_at", isTsOrNull], ["created_at", isTs],
] as const;
const toMission = (v: unknown): Mission => row(v, MISSION_ROW, "mission");
const toRolling = (v: unknown): MissionRollingState => row(v, ROLLING_ROW, "mission rolling_state");
const toSession = (v: unknown): MissionSession => row(v, SESSION_ROW, "mission session");
const checkApplied = (v: unknown, method: string, key: string): Record<string, unknown> => {
  if (!isRec(v) || typeof v.applied !== "boolean"
    || !hasExactKeys(v, v.applied ? ["applied", key] : ["applied"])) {
    throw proto(`bad ${method} result shape`);
  }
  return v;
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };
const MISSION_CO: readonly string[] = ["mission_id", "company_id"];

export async function getMission(
  client: PaperworkEngineClient, params: MissionGetParams, callOpts?: CallOpts,
): Promise<MissionGetResult> {
  checkKeys(params, MISSION_CO);
  const result = await client.call<unknown>("mission.get", {
    mission_id: checkUuid(params.mission_id, "mission_id"),
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["mission"])) throw proto("bad mission.get result shape");
  return { mission: result.mission === null ? null : toMission(result.mission) };
}

export async function listMissionsByCompany(
  client: PaperworkEngineClient, params: MissionListByCompanyParams, callOpts?: CallOpts,
): Promise<MissionListByCompanyResult> {
  checkKeys(params, ["company_id", "limit"], ["status"]);
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    limit: checkI64(params.limit, "limit"), // engine clamps 1..200 server-side; pass through
  };
  const status = checkOptStatus(params.status, "status");
  if (status !== undefined) wire.status = status;
  const result = await client.call<unknown>("mission.list_by_company", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["missions"]) || !Array.isArray(result.missions)) {
    throw proto("bad mission.list_by_company result shape");
  }
  return { missions: result.missions.map(toMission) };
}

export async function getMissionRollingState(
  client: PaperworkEngineClient, params: MissionGetRollingStateParams, callOpts?: CallOpts,
): Promise<MissionGetRollingStateResult> {
  checkKeys(params, MISSION_CO);
  const result = await client.call<unknown>("mission.get_rolling_state", {
    mission_id: checkUuid(params.mission_id, "mission_id"),
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["rolling_state"])) {
    throw proto("bad mission.get_rolling_state result shape");
  }
  return { rolling_state: result.rolling_state === null ? null : toRolling(result.rolling_state) };
}

export async function listMissionSessions(
  client: PaperworkEngineClient, params: MissionListSessionsParams, callOpts?: CallOpts,
): Promise<MissionListSessionsResult> {
  checkKeys(params, MISSION_CO);
  const result = await client.call<unknown>("mission.list_sessions", {
    mission_id: checkUuid(params.mission_id, "mission_id"),
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["sessions"]) || !Array.isArray(result.sessions)) {
    throw proto("bad mission.list_sessions result shape");
  }
  return { sessions: result.sessions.map(toSession) };
}

export async function transitionMissionStatusFenced(
  client: PaperworkEngineClient, params: MissionTransitionStatusFencedParams, callOpts?: CallOpts,
): Promise<MissionTransitionStatusFencedResult> {
  checkKeys(params, [...MISSION_CO, "expected_status", "next_status"]);
  const expected = checkMissionStatus(params.expected_status, "expected_status");
  const next = checkMissionStatus(params.next_status, "next_status");
  // engine-mission validate_mission_transition rejects expected == next (-32602).
  if (expected === next) {
    throw new RangeError(`illegal mission status transition: ${expected} -> ${next}`);
  }
  const o = checkApplied(await client.call<unknown>("mission.transition_status_fenced", {
    mission_id: checkUuid(params.mission_id, "mission_id"),
    company_id: checkUuid(params.company_id, "company_id"),
    expected_status: expected, next_status: next,
  }, callOpts), "mission.transition_status_fenced", "mission");
  return o.applied ? { applied: true, mission: toMission(o.mission) } : { applied: false };
}

export async function bumpMissionRollingStateFenced(
  client: PaperworkEngineClient, params: MissionBumpRollingStateFencedParams, callOpts?: CallOpts,
): Promise<MissionBumpRollingStateFencedResult> {
  checkKeys(params, [...MISSION_CO, "expected_revision", "state_json", "state_markdown"]);
  const revision = checkI32(params.expected_revision, "expected_revision");
  // engine-mission validate_bump_revision rejects < 1 (-32602).
  if (revision < 1) throw new RangeError("expected_revision must be >= 1");
  const o = checkApplied(await client.call<unknown>("mission.bump_rolling_state_fenced", {
    mission_id: checkUuid(params.mission_id, "mission_id"),
    company_id: checkUuid(params.company_id, "company_id"),
    expected_revision: revision,
    state_json: checkJson(params.state_json, "state_json"),
    state_markdown: checkStr(params.state_markdown, "state_markdown"),
  }, callOpts), "mission.bump_rolling_state_fenced", "rolling_state");
  return o.applied ? { applied: true, rolling_state: toRolling(o.rolling_state) } : { applied: false };
}
