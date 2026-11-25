// [파일 목적] resident paperwork-engine `decision.*` typed RPC client — Rust
//   crates/paperwork-engine/src/decision.rs·engine-decision/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, Wave 5 decision 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatRpcErrorClassification,
} from "./paperwork-engine-heartbeat.js";

export const DECISION_STATUSES = ["pending", "resolved", "cancelled"] as const;
export const DECISION_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const DECISION_INTERACTION_TYPES = ["single_select", "multi_select", "action"] as const;
export const DECISION_CONTINUATION_MODES = ["none", "issue_current_assignee"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type DecisionPriority = (typeof DECISION_PRIORITIES)[number];
export type DecisionInteractionType = (typeof DECISION_INTERACTION_TYPES)[number];
export type DecisionContinuationMode = (typeof DECISION_CONTINUATION_MODES)[number];

export interface DecisionRow {
  id: string; company_id: string; quality_action_id: string | null; quality_binding: unknown;
  request_key: string; request_hash: string; schema_version: number; status: DecisionStatus;
  priority: DecisionPriority; interaction_type: DecisionInteractionType; title: string; description: string;
  source_type: string; source_id: string; source_context: unknown; issue_id: string | null;
  requested_by_agent_id: string | null; requested_by_user_id: string | null; definition: unknown;
  result: unknown; resolved_by_user_id: string | null; resolved_at: string | null; cancelled_at: string | null;
  continuation_mode: DecisionContinuationMode; created_at: string; updated_at: string;
}
export interface DecisionListParams { company_id: string; status?: DecisionStatus; limit?: number }
export interface DecisionGetByIdParams { decision_id: string; company_id: string }
export interface DecisionGetByKeyParams { company_id: string; request_key: string }
export interface DecisionCreateParams {
  company_id: string; request_key: string; request_hash: string; priority: DecisionPriority;
  interaction_type: DecisionInteractionType; title: string; description: string;
  source_type: string; source_id: string; source_context: Record<string, unknown>;
  issue_id?: string | null; requested_by_agent_id?: string | null; requested_by_user_id?: string | null;
  definition: Record<string, unknown>; continuation_mode: DecisionContinuationMode;
  quality_action_id?: string | null; quality_binding?: Record<string, unknown> | null;
}
export interface DecisionResolveParams {
  decision_id: string; company_id: string; result: Record<string, unknown>; resolved_by_user_id: string;
}
export interface DecisionCancelParams { decision_id: string; company_id: string }
export interface DecisionGetResult { decision: DecisionRow | null }
export type DecisionCreateResult = { created: true; decision: DecisionRow }
  | { created: false; replayed: true; decision: DecisionRow } | { created: false; conflict: "request_key" };
export type DecisionResolveResult = { resolved: true; decision: DecisionRow }
  | { resolved: false; decision: DecisionRow | null };
export type DecisionCancelResult = { cancelled: true; decision: DecisionRow }
  | { cancelled: false; decision: DecisionRow | null };

const STATUS_SET: ReadonlySet<string> = new Set(DECISION_STATUSES);
const PRIORITY_SET: ReadonlySet<string> = new Set(DECISION_PRIORITIES);
const INTERACTION_SET: ReadonlySet<string> = new Set(DECISION_INTERACTION_TYPES);
const CONTINUATION_SET: ReadonlySet<string> = new Set(DECISION_CONTINUATION_MODES);
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
const isEnum = <S extends string>(set: ReadonlySet<string>, v: unknown): v is S => isStr(v) && set.has(v);
const isStatus = (v: unknown): v is DecisionStatus => isEnum(STATUS_SET, v);
const isPriority = (v: unknown): v is DecisionPriority => isEnum(PRIORITY_SET, v);
const isInteractionType = (v: unknown): v is DecisionInteractionType => isEnum(INTERACTION_SET, v);
const isContinuationMode = (v: unknown): v is DecisionContinuationMode => isEnum(CONTINUATION_SET, v);
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
const fail = (name: string, msg: string): never => { throw new RangeError(`${name} must be ${msg}`); };
const checkUuid = (v: unknown, name: string): string => (isUuid(v) ? v : fail(name, "a UUID string"));
const checkEnum = <T extends string>(set: ReadonlySet<string>, v: unknown, name: string, msg: string): T =>
  (isStr(v) && set.has(v) ? v as T : fail(name, msg));
const checkTrim = (v: unknown, name: string): string =>
  (isStr(v) && v.trim() !== "" ? v : fail(name, "a non-empty string"));
const checkObj = (v: unknown, name: string): Record<string, unknown> =>
  (isRec(v) ? v : fail(name, "a JSON object"));
const checkOptUuid = (v: unknown, name: string) => (v === undefined || v === null ? v : checkUuid(v, name));
const checkOptStr = (v: unknown, name: string) => {
  if (v === undefined || v === null) return v;
  if (!isStr(v)) fail(name, "a string or null");
  return v;
};

/** Classifies a rejected decision.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyDecisionRpcError = (error: unknown): HeartbeatRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[]): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto("bad decision row shape");
};
const DECISION_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["quality_action_id", isUuidOrNull], ["quality_binding", isJson],
  ["request_key", isStr], ["request_hash", isStr], ["schema_version", isI32], ["status", isStatus],
  ["priority", isPriority], ["interaction_type", isInteractionType], ["title", isStr], ["description", isStr],
  ["source_type", isStr], ["source_id", isStr], ["source_context", isJson], ["issue_id", isUuidOrNull],
  ["requested_by_agent_id", isUuidOrNull], ["requested_by_user_id", isStrOrNull], ["definition", isJson],
  ["result", isJson], ["resolved_by_user_id", isStrOrNull], ["resolved_at", isTsOrNull],
  ["cancelled_at", isTsOrNull], ["continuation_mode", isContinuationMode], ["created_at", isTs], ["updated_at", isTs],
] as const;
const toDecision = (v: unknown): DecisionRow => row(v, DECISION_ROW);
const exact = (v: unknown, keys: readonly string[], method: string): Record<string, unknown> => {
  if (!isRec(v) || !hasExactKeys(v, keys)) throw proto(`bad ${method} result shape`);
  return v;
};
const toGetResult = (v: unknown, method: string): DecisionGetResult => {
  const o = exact(v, ["decision"], method);
  return { decision: o.decision === null ? null : toDecision(o.decision) };
};
const toDecisionOrNull = (v: unknown): DecisionRow | null => (v === null ? null : toDecision(v));

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function listDecisions(
  client: PaperworkEngineClient, params: DecisionListParams, callOpts?: CallOpts,
): Promise<DecisionRow[]> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  if (params.status !== undefined) {
    wire.status = checkEnum<DecisionStatus>(STATUS_SET, params.status, "status", "a valid decision status");
  }
  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200) {
      throw new RangeError("limit must be an integer in [1, 200]");
    }
    wire.limit = params.limit;
  }
  const result = await client.call<unknown>("decision.list", wire, callOpts);
  const o = exact(result, ["decisions"], "decision.list");
  if (!Array.isArray(o.decisions)) throw proto("bad decision.list result shape");
  return o.decisions.map(toDecision);
}

export async function getDecisionById(
  client: PaperworkEngineClient, params: DecisionGetByIdParams, callOpts?: CallOpts,
): Promise<DecisionGetResult> {
  const result = await client.call<unknown>("decision.get_by_id", {
    decision_id: checkUuid(params.decision_id, "decision_id"), company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  return toGetResult(result, "decision.get_by_id");
}

export async function getDecisionByRequestKey(
  client: PaperworkEngineClient, params: DecisionGetByKeyParams, callOpts?: CallOpts,
): Promise<DecisionGetResult> {
  const result = await client.call<unknown>("decision.get_by_request_key", {
    company_id: checkUuid(params.company_id, "company_id"),
    request_key: checkTrim(params.request_key, "request_key"),
  }, callOpts);
  return toGetResult(result, "decision.get_by_request_key");
}

export async function createDecision(
  client: PaperworkEngineClient, params: DecisionCreateParams, callOpts?: CallOpts,
): Promise<DecisionCreateResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    request_key: checkTrim(params.request_key, "request_key"),
    request_hash: checkTrim(params.request_hash, "request_hash"),
    priority: checkEnum<DecisionPriority>(PRIORITY_SET, params.priority, "priority", "a valid decision priority"),
    interaction_type: checkEnum<DecisionInteractionType>(
      INTERACTION_SET, params.interaction_type, "interaction_type", "a valid decision interaction type"),
    title: checkTrim(params.title, "title"), description: checkTrim(params.description, "description"),
    source_type: checkTrim(params.source_type, "source_type"), source_id: checkTrim(params.source_id, "source_id"),
    source_context: checkObj(params.source_context, "source_context"),
    definition: checkObj(params.definition, "definition"),
    continuation_mode: checkEnum<DecisionContinuationMode>(
      CONTINUATION_SET, params.continuation_mode, "continuation_mode", "a valid decision continuation mode"),
  };
  for (const name of ["issue_id", "requested_by_agent_id", "quality_action_id"] as const) {
    const v = checkOptUuid(params[name], name);
    if (v !== undefined) wire[name] = v;
  }
  const user = checkOptStr(params.requested_by_user_id, "requested_by_user_id");
  if (user !== undefined) wire.requested_by_user_id = user;
  if (params.quality_binding !== undefined) {
    wire.quality_binding = params.quality_binding === null ? null : checkObj(params.quality_binding, "quality_binding");
  }
  if (wire.quality_action_id !== undefined && wire.quality_action_id !== null && wire.continuation_mode !== "none") {
    throw new RangeError("quality_action_id requires continuation_mode = 'none'");
  }
  const result = await client.call<unknown>("decision.create", wire, callOpts);
  if (!isRec(result) || typeof result.created !== "boolean") throw proto("bad decision.create result shape");
  if (result.created === true) {
    exact(result, ["created", "decision"], "decision.create");
    return { created: true, decision: toDecision(result.decision) };
  }
  if (hasExactKeys(result, ["created", "replayed", "decision"]) && result.replayed === true) {
    return { created: false, replayed: true, decision: toDecision(result.decision) };
  }
  if (hasExactKeys(result, ["created", "conflict"]) && result.conflict === "request_key") {
    return { created: false, conflict: "request_key" };
  }
  throw proto("bad decision.create result shape");
}

export async function resolveDecision(
  client: PaperworkEngineClient, params: DecisionResolveParams, callOpts?: CallOpts,
): Promise<DecisionResolveResult> {
  const result = await client.call<unknown>("decision.resolve", {
    decision_id: checkUuid(params.decision_id, "decision_id"), company_id: checkUuid(params.company_id, "company_id"),
    result: checkObj(params.result, "result"), resolved_by_user_id: checkTrim(params.resolved_by_user_id, "resolved_by_user_id"),
  }, callOpts);
  if (!isRec(result) || typeof result.resolved !== "boolean"
    || !hasExactKeys(result, ["resolved", "decision"])) throw proto("bad decision.resolve result shape");
  return result.resolved
    ? { resolved: true, decision: toDecision(result.decision) }
    : { resolved: false, decision: toDecisionOrNull(result.decision) };
}

export async function cancelDecision(
  client: PaperworkEngineClient, params: DecisionCancelParams, callOpts?: CallOpts,
): Promise<DecisionCancelResult> {
  const result = await client.call<unknown>("decision.cancel", {
    decision_id: checkUuid(params.decision_id, "decision_id"), company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || typeof result.cancelled !== "boolean"
    || !hasExactKeys(result, ["cancelled", "decision"])) throw proto("bad decision.cancel result shape");
  return result.cancelled
    ? { cancelled: true, decision: toDecision(result.decision) }
    : { cancelled: false, decision: toDecisionOrNull(result.decision) };
}
