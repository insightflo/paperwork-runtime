// [파일 목적] resident paperwork-engine `worktree.*` typed RPC client — Rust
//   crates/paperwork-engine/src/worktree.rs·engine-worktree/{lib,queries}.rs 와
//   필드명·에러 코드·CRUD 결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, Wave 5 cutover 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const WORKTREE_RULE_SEVERITIES = ["MUST", "SHOULD", "MAY"] as const;
export const WORKTREE_RULE_ACTIONS = [
  "tool_call", "file_read", "file_write", "file_delete",
  "network_request", "command_execution", "state_query",
] as const;
export type WorktreeRuleSeverity = (typeof WORKTREE_RULE_SEVERITIES)[number];
export type WorktreeRuleAction = (typeof WORKTREE_RULE_ACTIONS)[number];

export interface EngineWorktreeRule {
  id: string; company_id: string; name: string;
  severity: WorktreeRuleSeverity; action: WorktreeRuleAction;
  predicate: unknown; decision_map: unknown; message: string; enabled: boolean;
  version: number; created_by: string; created_at: string; updated_at: string;
}

type JsonObject = Record<string, unknown>;
export interface WorktreeListParams { company_id: string; enabled_only?: boolean | null }
export interface WorktreeGetByIdParams { company_id: string; rule_id: string }
export interface WorktreeCreateParams {
  company_id: string; name: string; severity: WorktreeRuleSeverity; action: WorktreeRuleAction;
  predicate: JsonObject | null; decision_map: JsonObject | null;
  message?: string; enabled?: boolean; created_by: string;
}
export interface WorktreeUpdateParams {
  company_id: string; rule_id: string; expected_version: number;
  name?: string | null; severity?: WorktreeRuleSeverity | null; action?: WorktreeRuleAction | null;
  predicate?: JsonObject | null; decision_map?: JsonObject | null; message?: string | null;
}
export interface WorktreeToggleEnabledParams { company_id: string; rule_id: string; expected_version: number }
export interface WorktreeDeleteParams { company_id: string; rule_id: string }

export interface WorktreeListResult { rules: EngineWorktreeRule[] }
export type WorktreeGetResult =
  | { found: true; rule: EngineWorktreeRule }
  | { found: false };
export interface WorktreeCreateResult { created: true; rule: EngineWorktreeRule }
export type WorktreeUpdateResult =
  | { updated: true; rule: EngineWorktreeRule }
  | { updated: false; reason: "not_found" }
  | { updated: false; reason: "version_conflict"; current_version: number };
export type WorktreeDeleteResult = { deleted: true } | { deleted: false };

// worktree.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type WorktreeRpcErrorKind = HeartbeatRpcErrorKind;
export type WorktreeCommitOutcome = HeartbeatCommitOutcome;
export type WorktreeRpcErrorClassification = HeartbeatRpcErrorClassification;

const SEVERITY_SET: ReadonlySet<string> = new Set(WORKTREE_RULE_SEVERITIES);
const ACTION_SET: ReadonlySet<string> = new Set(WORKTREE_RULE_ACTIONS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isSeverity = (v: unknown): v is WorktreeRuleSeverity => isStr(v) && SEVERITY_SET.has(v);
const isAction = (v: unknown): v is WorktreeRuleAction => isStr(v) && ACTION_SET.has(v);
// jsonb fields serialize any serde_json::Value; the key must exist but the value
// itself is deliberately not revalidated on read.
const isJsonValue = (v: unknown): boolean => v !== undefined;
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

const proto = (msg: string) => new PaperworkEngineError("protocol_error", msg);
const make = <T>(guard: (v: unknown) => v is T, msg: string) => (v: unknown, name: string): T => {
  if (!guard(v)) throw new RangeError(`${name} must be ${msg}`); return v;
};
const checkUuid = make(isUuid, "a UUID string");
const checkSeverity = make(isSeverity, "a valid worktree rule severity");
const checkAction = make(isAction, "a valid worktree rule action");
const checkNonEmpty = (v: unknown, name: string): string => {
  if (!isStr(v) || v.trim() === "") throw new RangeError(`${name} must be a non-empty string`);
  return v;
};
const checkObjectOrNull = (v: unknown, name: string): JsonObject | null => {
  if (v === null || isRec(v)) return v;
  throw new RangeError(`${name} must be a plain JSON object or null`);
};
const checkExpectedVersion = (v: unknown, name: string): number => {
  if (!isI32(v) || v < 1) throw new RangeError(`${name} must be an integer >= 1`);
  return v;
};

/** Classifies a rejected worktree.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyWorktreeRpcError = (error: unknown): WorktreeRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const RULE_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["name", isStr],
  ["severity", isSeverity], ["action", isAction],
  ["predicate", isJsonValue], ["decision_map", isJsonValue], ["message", isStr],
  ["enabled", isBool], ["version", isI32], ["created_by", isStr],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const toRule = (v: unknown): EngineWorktreeRule => row(v, RULE_ROW, "worktree rule row");
const toUpdateResult = (v: unknown, method: string): WorktreeUpdateResult => {
  if (!isRec(v) || typeof v.updated !== "boolean") throw proto(`bad ${method} result shape`);
  if (v.updated) {
    if (!hasExactKeys(v, ["updated", "rule"])) throw proto(`bad ${method} result shape`);
    return { updated: true, rule: toRule(v.rule) };
  }
  if (v.reason === "not_found" && hasExactKeys(v, ["updated", "reason"])) {
    return { updated: false, reason: "not_found" };
  }
  if (v.reason === "version_conflict" && hasExactKeys(v, ["updated", "reason", "current_version"])
    && isI32(v.current_version)) {
    return { updated: false, reason: "version_conflict", current_version: v.current_version };
  }
  throw proto(`bad ${method} result shape`);
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };
const scopedIds = (p: { company_id: string; rule_id: string }) => ({
  company_id: checkUuid(p.company_id, "company_id"), rule_id: checkUuid(p.rule_id, "rule_id"),
});

export async function listWorktreeRules(
  client: PaperworkEngineClient, params: WorktreeListParams, callOpts?: CallOpts,
): Promise<WorktreeListResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  if (params.enabled_only !== undefined) {
    if (params.enabled_only !== null && !isBool(params.enabled_only)) {
      throw new RangeError("enabled_only must be a boolean or null");
    }
    wire.enabled_only = params.enabled_only;
  }
  const result = await client.call<unknown>("worktree.list", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["rules"]) || !Array.isArray(result.rules)) {
    throw proto("bad worktree.list result shape");
  }
  return { rules: result.rules.map(toRule) };
}

export async function getWorktreeRuleById(
  client: PaperworkEngineClient, params: WorktreeGetByIdParams, callOpts?: CallOpts,
): Promise<WorktreeGetResult> {
  const result = await client.call<unknown>("worktree.get_by_id", scopedIds(params), callOpts);
  if (!isRec(result) || typeof result.found !== "boolean") throw proto("bad worktree.get_by_id result shape");
  if (!result.found) {
    if (!hasExactKeys(result, ["found"])) throw proto("bad worktree.get_by_id result shape");
    return { found: false };
  }
  if (!hasExactKeys(result, ["found", "rule"])) throw proto("bad worktree.get_by_id result shape");
  return { found: true, rule: toRule(result.rule) };
}

export async function createWorktreeRule(
  client: PaperworkEngineClient, params: WorktreeCreateParams, callOpts?: CallOpts,
): Promise<WorktreeCreateResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    name: checkNonEmpty(params.name, "name"),
    severity: checkSeverity(params.severity, "severity"),
    action: checkAction(params.action, "action"),
    predicate: checkObjectOrNull(params.predicate, "predicate"),
    decision_map: checkObjectOrNull(params.decision_map, "decision_map"),
    created_by: checkNonEmpty(params.created_by, "created_by"),
  };
  if (params.message !== undefined) {
    if (!isStr(params.message)) throw new RangeError("message must be a string");
    wire.message = params.message;
  }
  if (params.enabled !== undefined) {
    if (!isBool(params.enabled)) throw new RangeError("enabled must be a boolean");
    wire.enabled = params.enabled;
  }
  const result = await client.call<unknown>("worktree.create", wire, callOpts);
  if (!isRec(result) || result.created !== true || !hasExactKeys(result, ["created", "rule"])) {
    throw proto("bad worktree.create result shape");
  }
  return { created: true, rule: toRule(result.rule) };
}

export async function updateWorktreeRule(
  client: PaperworkEngineClient, params: WorktreeUpdateParams, callOpts?: CallOpts,
): Promise<WorktreeUpdateResult> {
  const wire: Record<string, unknown> = {
    ...scopedIds(params), expected_version: checkExpectedVersion(params.expected_version, "expected_version"),
  };
  const put = (name: "name" | "severity" | "action" | "predicate" | "decision_map" | "message") => {
    const v = params[name];
    if (v === undefined) return;
    if (v === null) { wire[name] = null; return; }
    if (name === "name") wire[name] = checkNonEmpty(v, name);
    else if (name === "severity") wire[name] = checkSeverity(v, name);
    else if (name === "action") wire[name] = checkAction(v, name);
    else if (name === "message") {
      if (!isStr(v)) throw new RangeError("message must be a string");
      wire[name] = v;
    } else wire[name] = checkObjectOrNull(v, name);
  };
  for (const n of ["name", "severity", "action", "predicate", "decision_map", "message"] as const) put(n);
  return toUpdateResult(await client.call<unknown>("worktree.update", wire, callOpts), "worktree.update");
}

export async function toggleWorktreeRuleEnabled(
  client: PaperworkEngineClient, params: WorktreeToggleEnabledParams, callOpts?: CallOpts,
): Promise<WorktreeUpdateResult> {
  const wire = { ...scopedIds(params), expected_version: checkExpectedVersion(params.expected_version, "expected_version") };
  return toUpdateResult(await client.call<unknown>("worktree.toggle_enabled", wire, callOpts), "worktree.toggle_enabled");
}

export async function deleteWorktreeRule(
  client: PaperworkEngineClient, params: WorktreeDeleteParams, callOpts?: CallOpts,
): Promise<WorktreeDeleteResult> {
  const result = await client.call<unknown>("worktree.delete", scopedIds(params), callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["deleted"]) || typeof result.deleted !== "boolean") {
    throw proto("bad worktree.delete result shape");
  }
  return result.deleted ? { deleted: true } : { deleted: false };
}
