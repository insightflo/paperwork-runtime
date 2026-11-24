// [파일 목적] resident paperwork-engine `issue.*` typed RPC client — Rust
//   crates/paperwork-engine/src/issue.rs·engine-issue/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, issue 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export type IssueFencedReason = "not_found" | "company_mismatch" | "fenced";

export interface Issue {
  id: string; company_id: string; project_id: string | null; mission_id: string | null;
  parent_id: string | null; title: string; description: string | null; status: IssueStatus;
  priority: IssuePriority; assignee_agent_id: string | null; assignee_user_id: string | null;
  checkout_run_id: string | null; execution_run_id: string | null;
  execution_agent_name_key: string | null; execution_locked_at: string | null;
  created_by_agent_id: string | null; created_by_user_id: string | null;
  issue_number: number | null; identifier: string | null; origin_kind: string;
  origin_id: string | null; origin_run_id: string | null; request_depth: number;
  billing_code: string | null; started_at: string | null; completed_at: string | null;
  cancelled_at: string | null; hidden_at: string | null; created_at: string; updated_at: string;
}
export interface IssueWorkProduct {
  id: string; company_id: string; project_id: string | null; issue_id: string;
  execution_workspace_id: string | null; runtime_service_id: string | null;
  work_product_type: string; provider: string; external_id: string | null; title: string;
  url: string | null; status: string; review_state: string; is_primary: boolean;
  health_status: string; summary: string | null; metadata: unknown;
  created_by_run_id: string | null; source_execution_generation: number | null;
  created_at: string; updated_at: string;
}
export interface IssueGetParams { company_id: string; issue_id: string }
export interface IssueGetResult { issue: Issue | null }
export interface IssueListByCompanyParams { company_id: string; limit: number }
export interface IssueListByCompanyResult { issues: Issue[] }
export interface IssueListWorkProductsParams { company_id: string; issue_id: string }
export interface IssueListWorkProductsResult { work_products: IssueWorkProduct[] }
export interface IssueCheckoutFencedParams {
  company_id: string; issue_id: string; agent_id: string; run_id: string;
  expected_statuses: IssueStatus[]; agent_name_key?: string | null;
}
export interface IssueTransitionStatusFencedParams {
  company_id: string; issue_id: string; expected_status: IssueStatus; new_status: IssueStatus;
}
export interface IssueReleaseCheckoutFencedParams { company_id: string; issue_id: string; run_id: string }
export type IssueWriteResult = { applied: true; issue: Issue } | { applied: false; reason: IssueFencedReason };
export type IssueCheckoutFencedResult = IssueWriteResult;
export type IssueTransitionStatusFencedResult = IssueWriteResult;
export type IssueReleaseCheckoutFencedResult = IssueWriteResult;

// issue.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type IssueRpcErrorKind = HeartbeatRpcErrorKind;
export type IssueCommitOutcome = HeartbeatCommitOutcome;
export type IssueRpcErrorClassification = HeartbeatRpcErrorClassification;

const STATUS_SET: ReadonlySet<string> = new Set(ISSUE_STATUSES);
const PRIORITY_SET: ReadonlySet<string> = new Set(ISSUE_PRIORITIES);
const REASON_SET: ReadonlySet<string> = new Set(["not_found", "company_mismatch", "fenced"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isUuidOrNull = (v: unknown): v is string | null => v === null || isUuid(v);
const isI64 = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isI32 = (v: unknown): v is number => isI64(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isI32OrNull = (v: unknown): v is number | null => v === null || isI32(v);
const isIssueStatus = (v: unknown): v is IssueStatus => isStr(v) && STATUS_SET.has(v);
const isIssuePriority = (v: unknown): v is IssuePriority => isStr(v) && PRIORITY_SET.has(v);
const isFencedReason = (v: unknown): v is IssueFencedReason => isStr(v) && REASON_SET.has(v);
const isJsonValue = (v: unknown): v is unknown => v !== undefined; // Option<serde_json::Value>
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
const checkI64 = make(isI64, "a 64-bit safe integer");
const checkIssueStatus = make(isIssueStatus, "a valid issue status");
// engine -32602 gate: checkout rejects an empty expected-status set before any
// PG I/O; mirrored here pre-RPC.
const checkStatuses = (v: unknown, name: string): IssueStatus[] => {
  if (!Array.isArray(v) || v.length === 0) throw new RangeError(`${name} must be a non-empty status array`);
  return v.map((s, i) => checkIssueStatus(s, `${name}[${i}]`));
};
// serde Option<String> with #[serde(default)]: undefined keeps the key off the
// wire, null -> None, a blank-after-trim string fails the -32602 gate.
const checkAgentNameKey = (v: unknown, name: string): string | null | undefined => {
  if (v === undefined || v === null) return v;
  if (!isStr(v) || v.trim() === "") throw new RangeError(`${name} must be a non-blank string`);
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

/** Classifies a rejected issue.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyIssueRpcError = (error: unknown): IssueRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const ISSUE_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["project_id", isUuidOrNull], ["mission_id", isUuidOrNull],
  ["parent_id", isUuidOrNull], ["title", isStr], ["description", isStrOrNull], ["status", isIssueStatus],
  ["priority", isIssuePriority], ["assignee_agent_id", isUuidOrNull], ["assignee_user_id", isStrOrNull],
  ["checkout_run_id", isUuidOrNull], ["execution_run_id", isUuidOrNull], ["execution_agent_name_key", isStrOrNull],
  ["execution_locked_at", isTsOrNull], ["created_by_agent_id", isUuidOrNull], ["created_by_user_id", isStrOrNull],
  ["issue_number", isI32OrNull], ["identifier", isStrOrNull], ["origin_kind", isStr], ["origin_id", isStrOrNull],
  ["origin_run_id", isStrOrNull], ["request_depth", isI32], ["billing_code", isStrOrNull], ["started_at", isTsOrNull],
  ["completed_at", isTsOrNull], ["cancelled_at", isTsOrNull], ["hidden_at", isTsOrNull],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const WORK_PRODUCT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["project_id", isUuidOrNull], ["issue_id", isUuid],
  ["execution_workspace_id", isUuidOrNull], ["runtime_service_id", isUuidOrNull], ["work_product_type", isStr],
  ["provider", isStr], ["external_id", isStrOrNull], ["title", isStr], ["url", isStrOrNull], ["status", isStr],
  ["review_state", isStr], ["is_primary", isBool], ["health_status", isStr], ["summary", isStrOrNull],
  ["metadata", isJsonValue], ["created_by_run_id", isUuidOrNull], ["source_execution_generation", isI32OrNull],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const toIssue = (v: unknown): Issue => row(v, ISSUE_ROW, "issue");
const toWorkProduct = (v: unknown): IssueWorkProduct => row(v, WORK_PRODUCT_ROW, "issue work_product");
const toWriteResult = (v: unknown, method: string): IssueWriteResult => {
  if (!isRec(v) || typeof v.applied !== "boolean"
    || !hasExactKeys(v, v.applied ? ["applied", "issue"] : ["applied", "reason"])
    || (!v.applied && !isFencedReason(v.reason))) {
    throw proto(`bad ${method} result shape`);
  }
  return v.applied ? { applied: true, issue: toIssue(v.issue) } : { applied: false, reason: v.reason as IssueFencedReason };
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };
const ID_CO: readonly string[] = ["company_id", "issue_id"];

export async function getIssue(
  client: PaperworkEngineClient, params: IssueGetParams, callOpts?: CallOpts,
): Promise<IssueGetResult> {
  checkKeys(params, ID_CO);
  const result = await client.call<unknown>("issue.get", {
    company_id: checkUuid(params.company_id, "company_id"),
    issue_id: checkUuid(params.issue_id, "issue_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["issue"])) throw proto("bad issue.get result shape");
  return { issue: result.issue === null ? null : toIssue(result.issue) };
}

export async function listIssuesByCompany(
  client: PaperworkEngineClient, params: IssueListByCompanyParams, callOpts?: CallOpts,
): Promise<IssueListByCompanyResult> {
  checkKeys(params, ["company_id", "limit"]);
  const result = await client.call<unknown>("issue.list_by_company", {
    company_id: checkUuid(params.company_id, "company_id"),
    limit: checkI64(params.limit, "limit"), // engine clamps 1..200 server-side; pass through
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["issues"]) || !Array.isArray(result.issues)) {
    throw proto("bad issue.list_by_company result shape");
  }
  return { issues: result.issues.map(toIssue) };
}

export async function listIssueWorkProducts(
  client: PaperworkEngineClient, params: IssueListWorkProductsParams, callOpts?: CallOpts,
): Promise<IssueListWorkProductsResult> {
  checkKeys(params, ID_CO);
  const result = await client.call<unknown>("issue.list_issue_work_products", {
    company_id: checkUuid(params.company_id, "company_id"),
    issue_id: checkUuid(params.issue_id, "issue_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["work_products"]) || !Array.isArray(result.work_products)) {
    throw proto("bad issue.list_issue_work_products result shape");
  }
  return { work_products: result.work_products.map(toWorkProduct) };
}

export async function checkoutIssueFenced(
  client: PaperworkEngineClient, params: IssueCheckoutFencedParams, callOpts?: CallOpts,
): Promise<IssueCheckoutFencedResult> {
  checkKeys(params, [...ID_CO, "agent_id", "run_id", "expected_statuses"], ["agent_name_key"]);
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    issue_id: checkUuid(params.issue_id, "issue_id"),
    agent_id: checkUuid(params.agent_id, "agent_id"),
    run_id: checkUuid(params.run_id, "run_id"),
    expected_statuses: checkStatuses(params.expected_statuses, "expected_statuses"),
  };
  const nameKey = checkAgentNameKey(params.agent_name_key, "agent_name_key");
  if (nameKey !== undefined) wire.agent_name_key = nameKey;
  return toWriteResult(await client.call<unknown>("issue.checkout_fenced", wire, callOpts), "issue.checkout_fenced");
}

export async function transitionIssueStatusFenced(
  client: PaperworkEngineClient, params: IssueTransitionStatusFencedParams, callOpts?: CallOpts,
): Promise<IssueTransitionStatusFencedResult> {
  checkKeys(params, [...ID_CO, "expected_status", "new_status"]);
  const result = await client.call<unknown>("issue.transition_status_fenced", {
    company_id: checkUuid(params.company_id, "company_id"),
    issue_id: checkUuid(params.issue_id, "issue_id"),
    expected_status: checkIssueStatus(params.expected_status, "expected_status"),
    new_status: checkIssueStatus(params.new_status, "new_status"),
  }, callOpts);
  return toWriteResult(result, "issue.transition_status_fenced");
}

export async function releaseIssueCheckoutFenced(
  client: PaperworkEngineClient, params: IssueReleaseCheckoutFencedParams, callOpts?: CallOpts,
): Promise<IssueReleaseCheckoutFencedResult> {
  checkKeys(params, [...ID_CO, "run_id"]);
  const result = await client.call<unknown>("issue.release_checkout_fenced", {
    company_id: checkUuid(params.company_id, "company_id"),
    issue_id: checkUuid(params.issue_id, "issue_id"),
    run_id: checkUuid(params.run_id, "run_id"),
  }, callOpts);
  return toWriteResult(result, "issue.release_checkout_fenced");
}
