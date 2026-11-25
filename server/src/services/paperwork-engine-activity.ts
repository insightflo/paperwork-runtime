// [파일 목적] resident paperwork-engine `activity.*` typed RPC client — Rust
//   crates/paperwork-engine/src/activity.rs·engine-activity/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, activity 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const ACTOR_TYPES = ["system", "user", "agent", "plugin", "board"] as const;
export const OPERATOR_DECISION_STATUSES = ["pending", "resolved", "cancelled"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export type OperatorDecisionStatus = (typeof OPERATOR_DECISION_STATUSES)[number];

export interface ActivityAppendEventParams {
  company_id: string; actor_type: ActorType; actor_id: string; action: string;
  entity_type: string; entity_id: string;
  agent_id?: string | null; run_id?: string | null; details?: Record<string, unknown> | null;
}
export interface ActivityEvent {
  id: string; company_id: string; actor_type: ActorType; actor_id: string; action: string;
  entity_type: string; entity_id: string; agent_id: string | null; run_id: string | null;
  details: Record<string, unknown> | null; created_at: string;
}
export interface OperatorDecision {
  id: string; company_id: string; quality_action_id: string | null;
  quality_binding: Record<string, unknown> | null; request_key: string; request_hash: string;
  schema_version: number; status: OperatorDecisionStatus; priority: string;
  interaction_type: string; title: string; description: string; source_type: string;
  source_id: string; source_context: Record<string, unknown>; issue_id: string | null;
  requested_by_agent_id: string | null; requested_by_user_id: string | null;
  definition: Record<string, unknown>; result: Record<string, unknown> | null;
  resolved_by_user_id: string | null; resolved_at: string | null; cancelled_at: string | null;
  continuation_mode: string; created_at: string; updated_at: string;
}
export interface ActivityAppendEventResult { event: ActivityEvent }
export interface ActivityListEventsParams {
  company_id: string; agent_id?: string | null; entity_type?: string | null;
  entity_id?: string | null; limit: number;
}
export interface ActivityListEventsResult { events: ActivityEvent[] }
export interface ActivityListOperatorDecisionsParams {
  company_id: string; status?: OperatorDecisionStatus | null; limit: number;
}
export interface ActivityListOperatorDecisionsResult { operator_decisions: OperatorDecision[] }
export interface ActivityResolveOperatorDecisionFencedParams {
  operator_decision_id: string; company_id: string;
  resolved_by_user_id: string; result: Record<string, unknown>;
}
export type ActivityResolveOperatorDecisionFencedResult =
  | { updated: true; operator_decision: OperatorDecision }
  | { updated: false };

// activity.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type ActivityRpcErrorKind = HeartbeatRpcErrorKind;
export type ActivityCommitOutcome = HeartbeatCommitOutcome;
export type ActivityRpcErrorClassification = HeartbeatRpcErrorClassification;

const ACTOR_SET: ReadonlySet<string> = new Set(ACTOR_TYPES);
const STATUS_SET: ReadonlySet<string> = new Set(OPERATOR_DECISION_STATUSES);
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
const isObjOrNull = (v: unknown): v is Record<string, unknown> | null => v === null || isRec(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isEnum = <S extends string>(set: ReadonlySet<string>, v: unknown): v is S => isStr(v) && set.has(v);
const isActorType = (v: unknown): v is ActorType => isEnum(ACTOR_SET, v);
const isDecisionStatus = (v: unknown): v is OperatorDecisionStatus => isEnum(STATUS_SET, v);
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
const checkActorType = make(isActorType, "a valid activity actor type");
const checkDecisionStatus = make(isDecisionStatus, "a valid operator decision status");
const checkI64 = make((v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v), "a 64-bit safe integer");
// activity.rs pre-I/O gates trim().is_empty() => -32602; the client never ships them.
const checkNonEmpty = make((v: unknown): v is string => isStr(v) && v.trim() !== "", "a non-empty string");
const checkObj = make(isRec, "a JSON object");
// serde Option<T>: undefined keeps the key off the wire, null -> None.
const checkOptUuid = (v: unknown, n: string) => (v === undefined || v === null ? v : checkUuid(v, n));
const checkOptStr = (v: unknown, n: string) => (v === undefined || v === null ? v : checkStr(v, n));
const checkOptStatus = (v: unknown, n: string) => (v === undefined || v === null ? v : checkDecisionStatus(v, n));

/** Classifies a rejected activity.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyActivityRpcError = (error: unknown): ActivityRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const EVENT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["actor_type", isActorType], ["actor_id", isStr],
  ["action", isStr], ["entity_type", isStr], ["entity_id", isStr], ["agent_id", isUuidOrNull],
  ["run_id", isUuidOrNull], ["details", isObjOrNull], ["created_at", isTs],
] as const;
const DECISION_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["quality_action_id", isUuidOrNull],
  ["quality_binding", isObjOrNull], ["request_key", isStr], ["request_hash", isStr],
  ["schema_version", isI32], ["status", isDecisionStatus], ["priority", isStr],
  ["interaction_type", isStr], ["title", isStr], ["description", isStr], ["source_type", isStr],
  ["source_id", isStr], ["source_context", isRec], ["issue_id", isUuidOrNull],
  ["requested_by_agent_id", isUuidOrNull], ["requested_by_user_id", isStrOrNull],
  ["definition", isRec], ["result", isObjOrNull], ["resolved_by_user_id", isStrOrNull],
  ["resolved_at", isTsOrNull], ["cancelled_at", isTsOrNull], ["continuation_mode", isStr],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const toEvent = (v: unknown): ActivityEvent => row(v, EVENT_ROW, "activity event");
const toDecision = (v: unknown): OperatorDecision => row(v, DECISION_ROW, "operator decision");

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function appendActivityEvent(
  client: PaperworkEngineClient, params: ActivityAppendEventParams, callOpts?: CallOpts,
): Promise<ActivityAppendEventResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    actor_type: checkActorType(params.actor_type, "actor_type"),
    actor_id: checkNonEmpty(params.actor_id, "actor_id"),
    action: checkNonEmpty(params.action, "action"),
    entity_type: checkNonEmpty(params.entity_type, "entity_type"),
    entity_id: checkNonEmpty(params.entity_id, "entity_id"),
  };
  for (const name of ["agent_id", "run_id"] as const) {
    const v = checkOptUuid(params[name], name);
    if (v !== undefined) wire[name] = v;
  }
  // engine maps Option<Value>: undefined omits, null -> None, object stays.
  if (params.details !== undefined) {
    wire.details = params.details === null ? null : checkObj(params.details, "details");
  }
  const result = await client.call<unknown>("activity.append_event", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["event"])) {
    throw proto("bad activity.append_event result shape");
  }
  return { event: toEvent(result.event) };
}

export async function listActivityEvents(
  client: PaperworkEngineClient, params: ActivityListEventsParams, callOpts?: CallOpts,
): Promise<ActivityListEventsResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    // engine clamps to 1..=200 via clamp_list_limit; the client sends it verbatim.
    limit: checkI64(params.limit, "limit"),
  };
  for (const [name, check] of [
    ["agent_id", checkOptUuid], ["entity_type", checkOptStr], ["entity_id", checkOptStr],
  ] as const) {
    const v = check(params[name], name);
    if (v !== undefined) wire[name] = v;
  }
  const result = await client.call<unknown>("activity.list_events", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["events"]) || !Array.isArray(result.events)) {
    throw proto("bad activity.list_events result shape");
  }
  return { events: result.events.map(toEvent) };
}

export async function listOperatorDecisions(
  client: PaperworkEngineClient, params: ActivityListOperatorDecisionsParams, callOpts?: CallOpts,
): Promise<ActivityListOperatorDecisionsResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    limit: checkI64(params.limit, "limit"),
  };
  const status = checkOptStatus(params.status, "status");
  if (status !== undefined) wire.status = status;
  const result = await client.call<unknown>("activity.list_operator_decisions", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["operator_decisions"]) || !Array.isArray(result.operator_decisions)) {
    throw proto("bad activity.list_operator_decisions result shape");
  }
  return { operator_decisions: result.operator_decisions.map(toDecision) };
}

export async function resolveOperatorDecisionFenced(
  client: PaperworkEngineClient, params: ActivityResolveOperatorDecisionFencedParams, callOpts?: CallOpts,
): Promise<ActivityResolveOperatorDecisionFencedResult> {
  const result = await client.call<unknown>("activity.resolve_operator_decision_fenced", {
    operator_decision_id: checkUuid(params.operator_decision_id, "operator_decision_id"),
    company_id: checkUuid(params.company_id, "company_id"),
    resolved_by_user_id: checkNonEmpty(params.resolved_by_user_id, "resolved_by_user_id"),
    result: checkObj(params.result, "result"),
  }, callOpts);
  if (!isRec(result) || typeof result.updated !== "boolean"
    || !hasExactKeys(result, result.updated ? ["updated", "operator_decision"] : ["updated"])) {
    throw proto("bad activity.resolve_operator_decision_fenced result shape");
  }
  return result.updated
    ? { updated: true, operator_decision: toDecision(result.operator_decision) }
    : { updated: false };
}
