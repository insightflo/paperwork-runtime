// [파일 목적] resident paperwork-engine `approval.*` typed RPC client — Rust
//   crates/paperwork-engine/src/approval.rs·engine-approval/lib.rs 와 필드명·
//   에러 코드·ApprovalStatus enum 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError (approval.rs 도 동일한
//   exec_db/Fail 경로를 공유하므로 분류 테이블이 같다).
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const APPROVAL_STATUSES = [
  "pending", "revision_requested", "approved", "rejected", "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_RESOLVE_TARGETS = ["approved", "rejected"] as const;
export type ApprovalResolveTarget = (typeof APPROVAL_RESOLVE_TARGETS)[number];

export interface Approval {
  id: string; company_id: string; approval_type: string;
  requested_by_agent_id: string | null; requested_by_user_id: string | null;
  requested_by_plugin_id: string | null; status: ApprovalStatus; payload: unknown;
  decision_note: string | null; decided_by_user_id: string | null;
  decided_at: string | null; created_at: string; updated_at: string;
}

export interface ApprovalValidateTransitionParams { from: ApprovalStatus; to: ApprovalStatus }
export type ApprovalValidateTransitionResult =
  | { valid: true }
  | { valid: false; reason: "invalid_transition"; from: ApprovalStatus; to: ApprovalStatus };

export interface ApprovalScopedParams { approval_id: string; company_id: string }
export interface ApprovalListParams { company_id: string; status?: ApprovalStatus; limit: number }
export interface ApprovalCreateParams {
  company_id: string; approval_type: string;
  requested_by_agent_id?: string; requested_by_user_id?: string; requested_by_plugin_id?: string;
  payload: unknown;
}
export interface ApprovalResolveParams extends ApprovalScopedParams {
  target_status: ApprovalResolveTarget; decided_by_user_id: string; decision_note?: string;
}
export interface ApprovalRevisionParams extends ApprovalScopedParams {
  decided_by_user_id: string; decision_note?: string;
}
export interface ApprovalResubmitParams extends ApprovalScopedParams { payload?: unknown }

export type ApprovalCreateResult = { created: true; approval: Approval } | { created: false };
export type ApprovalResolveResult =
  | { outcome: "applied"; approval: Approval }
  | { outcome: "already_in_target_state"; approval: Approval }
  | { outcome: "not_found_or_conflict" };
export type ApprovalUpdatedResult = { updated: true; approval: Approval } | { updated: false };

export type ApprovalRpcErrorKind = HeartbeatRpcErrorKind;
export type ApprovalCommitOutcome = HeartbeatCommitOutcome;
export type ApprovalRpcErrorClassification = HeartbeatRpcErrorClassification;

const STATUS_SET: ReadonlySet<string> = new Set(APPROVAL_STATUSES);
const RESOLVE_TARGET_SET: ReadonlySet<string> = new Set(APPROVAL_RESOLVE_TARGETS);
const APPROVAL_ROW_KEYS = [
  "id", "company_id", "approval_type", "requested_by_agent_id", "requested_by_user_id",
  "requested_by_plugin_id", "status", "payload", "decision_note", "decided_by_user_id",
  "decided_at", "created_at", "updated_at",
] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isStatus = (v: unknown): v is ApprovalStatus => typeof v === "string" && STATUS_SET.has(v);
const isTs = (v: unknown): v is string => {
  if (typeof v !== "string" || !RFC3339_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d] = v.slice(0, 10).split("-").map(Number);
  const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d);
  return dt.toISOString().slice(0, 10) === v.slice(0, 10);
};
const isTsOrNull = (v: unknown): v is string | null => v === null || isTs(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);

function proto(msg: string): PaperworkEngineError {
  return new PaperworkEngineError("protocol_error", msg);
}
function checkUuid(v: unknown, name: string): string {
  if (!isUuid(v)) throw new RangeError(`${name} must be a UUID string`);
  return v;
}
function checkStatus(v: unknown, name: string): ApprovalStatus {
  if (!isStatus(v)) throw new RangeError(`${name} must be a valid approval status`);
  return v;
}
function checkActor(v: unknown, name: string): string {
  // approval.rs rejects empty/whitespace decided_by_user_id pre-I/O (-32602).
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
  return v;
}
function checkOptStr(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new RangeError(`${name} must be a string`);
  return v;
}
function checkOptUuid(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  return checkUuid(v, name);
}

/** approval.* shares heartbeat.rs's exec_db Fail tuple table (-32001..-32005,
 *  -32602); transport/local errors and unrecognized codes stay
 *  indeterminate/never-retry so a retry can never double-apply a commit. */
export const classifyApprovalRpcError: (error: unknown) => ApprovalRpcErrorClassification =
  classifyHeartbeatRpcError;

// --- response validators -----------------------------------------------------
function toApproval(v: unknown): Approval {
  if (!isRec(v) || !exactKeys(v, APPROVAL_ROW_KEYS)
    || !isUuid(v.id) || !isUuid(v.company_id) || typeof v.approval_type !== "string"
    || !(v.requested_by_agent_id === null || isUuid(v.requested_by_agent_id))
    || !isStrOrNull(v.requested_by_user_id) || !isStrOrNull(v.requested_by_plugin_id)
    || !isStatus(v.status) || v.payload === undefined
    || !isStrOrNull(v.decision_note) || !isStrOrNull(v.decided_by_user_id)
    || !isTsOrNull(v.decided_at) || !isTs(v.created_at) || !isTs(v.updated_at)) {
    throw proto("bad approval row shape");
  }
  return {
    id: v.id, company_id: v.company_id, approval_type: v.approval_type,
    requested_by_agent_id: v.requested_by_agent_id, requested_by_user_id: v.requested_by_user_id,
    requested_by_plugin_id: v.requested_by_plugin_id, status: v.status, payload: v.payload,
    decision_note: v.decision_note, decided_by_user_id: v.decided_by_user_id,
    decided_at: v.decided_at, created_at: v.created_at, updated_at: v.updated_at,
  };
}
function toValidateResult(v: unknown): ApprovalValidateTransitionResult {
  if (!isRec(v) || typeof v.valid !== "boolean") throw proto("bad approval.validate_transition result shape");
  if (v.valid) {
    if (!exactKeys(v, ["valid"])) throw proto("bad approval.validate_transition result shape");
    return { valid: true };
  }
  if (!exactKeys(v, ["valid", "reason", "from", "to"])
    || v.reason !== "invalid_transition" || !isStatus(v.from) || !isStatus(v.to)) {
    throw proto("bad approval.validate_transition result shape");
  }
  return { valid: false, reason: "invalid_transition", from: v.from, to: v.to };
}
function toCreatedResult(v: unknown): ApprovalCreateResult {
  if (!isRec(v) || typeof v.created !== "boolean") throw proto("bad approval.create result shape");
  if (!v.created) {
    if (!exactKeys(v, ["created"])) throw proto("bad approval.create result shape");
    return { created: false };
  }
  if (!exactKeys(v, ["created", "approval"])) throw proto("bad approval.create result shape");
  return { created: true, approval: toApproval(v.approval) };
}
function toResolveResult(v: unknown): ApprovalResolveResult {
  if (!isRec(v) || (v.outcome !== "applied" && v.outcome !== "already_in_target_state"
    && v.outcome !== "not_found_or_conflict")) throw proto("bad approval.resolve_fenced result shape");
  if (v.outcome === "not_found_or_conflict") {
    if (!exactKeys(v, ["outcome"])) throw proto("bad approval.resolve_fenced result shape");
    return { outcome: "not_found_or_conflict" };
  }
  if (!exactKeys(v, ["outcome", "approval"])) throw proto("bad approval.resolve_fenced result shape");
  return { outcome: v.outcome, approval: toApproval(v.approval) };
}
function toUpdatedResult(method: string, v: unknown): ApprovalUpdatedResult {
  if (!isRec(v) || typeof v.updated !== "boolean") throw proto(`bad ${method} result shape`);
  if (!v.updated) {
    if (!exactKeys(v, ["updated"])) throw proto(`bad ${method} result shape`);
    return { updated: false };
  }
  if (!exactKeys(v, ["updated", "approval"])) throw proto(`bad ${method} result shape`);
  return { updated: true, approval: toApproval(v.approval) };
}

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };
const scopedWire = (p: ApprovalScopedParams): Record<string, unknown> => ({
  approval_id: checkUuid(p.approval_id, "approval_id"),
  company_id: checkUuid(p.company_id, "company_id"),
});

export async function validateApprovalTransition(
  client: PaperworkEngineClient, params: ApprovalValidateTransitionParams, callOpts?: CallOpts,
): Promise<ApprovalValidateTransitionResult> {
  const result = await client.call<unknown>("approval.validate_transition", {
    from: checkStatus(params.from, "from"), to: checkStatus(params.to, "to"),
  }, callOpts);
  return toValidateResult(result);
}

export async function getApproval(
  client: PaperworkEngineClient, params: ApprovalScopedParams, callOpts?: CallOpts,
): Promise<Approval | null> {
  const result = await client.call<unknown>("approval.get", scopedWire(params), callOpts);
  if (!isRec(result) || !exactKeys(result, ["approval"])) throw proto("bad approval.get result shape");
  return result.approval === null ? null : toApproval(result.approval);
}

export async function listApprovals(
  client: PaperworkEngineClient, params: ApprovalListParams, callOpts?: CallOpts,
): Promise<Approval[]> {
  if (!Number.isSafeInteger(params.limit)) throw new RangeError("limit must be a safe integer");
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"), limit: params.limit,
  };
  if (params.status !== undefined) wire.status = checkStatus(params.status, "status");
  const result = await client.call<unknown>("approval.list", wire, callOpts);
  if (!isRec(result) || !exactKeys(result, ["approvals"]) || !Array.isArray(result.approvals)) {
    throw proto("bad approval.list result shape");
  }
  return result.approvals.map(toApproval);
}

export async function createApproval(
  client: PaperworkEngineClient, params: ApprovalCreateParams, callOpts?: CallOpts,
): Promise<ApprovalCreateResult> {
  if (typeof params.approval_type !== "string" || params.approval_type.length === 0) {
    throw new RangeError("approval_type must be a non-empty string");
  }
  if (params.payload === undefined) throw new RangeError("payload is required");
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    approval_type: params.approval_type, payload: params.payload,
  };
  const agentId = checkOptUuid(params.requested_by_agent_id, "requested_by_agent_id");
  const userId = checkOptStr(params.requested_by_user_id, "requested_by_user_id");
  const pluginId = checkOptStr(params.requested_by_plugin_id, "requested_by_plugin_id");
  if (agentId !== undefined) wire.requested_by_agent_id = agentId;
  if (userId !== undefined) wire.requested_by_user_id = userId;
  if (pluginId !== undefined) wire.requested_by_plugin_id = pluginId;
  const result = await client.call<unknown>("approval.create", wire, callOpts);
  return toCreatedResult(result);
}

export async function resolveApprovalFenced(
  client: PaperworkEngineClient, params: ApprovalResolveParams, callOpts?: CallOpts,
): Promise<ApprovalResolveResult> {
  // resolve_approval_fenced's own guards: approved/rejected targets only, and
  // a non-empty decided_by_user_id — both rejected pre-I/O with -32602.
  if (typeof params.target_status !== "string" || !RESOLVE_TARGET_SET.has(params.target_status)) {
    throw new RangeError("target_status must be 'approved' or 'rejected'");
  }
  const wire: Record<string, unknown> = { ...scopedWire(params), target_status: params.target_status,
    decided_by_user_id: checkActor(params.decided_by_user_id, "decided_by_user_id") };
  const note = checkOptStr(params.decision_note, "decision_note");
  if (note !== undefined) wire.decision_note = note;
  const result = await client.call<unknown>("approval.resolve_fenced", wire, callOpts);
  return toResolveResult(result);
}

export async function requestApprovalRevisionFenced(
  client: PaperworkEngineClient, params: ApprovalRevisionParams, callOpts?: CallOpts,
): Promise<ApprovalUpdatedResult> {
  const wire: Record<string, unknown> = { ...scopedWire(params),
    decided_by_user_id: checkActor(params.decided_by_user_id, "decided_by_user_id") };
  const note = checkOptStr(params.decision_note, "decision_note");
  if (note !== undefined) wire.decision_note = note;
  const result = await client.call<unknown>("approval.request_revision_fenced", wire, callOpts);
  return toUpdatedResult("approval.request_revision_fenced", result);
}

export async function resubmitApprovalFenced(
  client: PaperworkEngineClient, params: ApprovalResubmitParams, callOpts?: CallOpts,
): Promise<ApprovalUpdatedResult> {
  const wire = scopedWire(params);
  if (params.payload !== undefined) wire.payload = params.payload;
  const result = await client.call<unknown>("approval.resubmit_fenced", wire, callOpts);
  return toUpdatedResult("approval.resubmit_fenced", result);
}

export async function cancelApprovalFenced(
  client: PaperworkEngineClient, params: ApprovalScopedParams, callOpts?: CallOpts,
): Promise<ApprovalUpdatedResult> {
  const result = await client.call<unknown>("approval.cancel_fenced", scopedWire(params), callOpts);
  return toUpdatedResult("approval.cancel_fenced", result);
}
