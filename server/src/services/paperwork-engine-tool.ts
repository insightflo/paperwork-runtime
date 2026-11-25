// [파일 목적] resident paperwork-engine `tool.*` typed RPC client — Rust
//   crates/paperwork-engine/src/tool.rs·engine-tool/{lib,queries}.rs 와
//   필드명·에러 코드·claim outcome union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, tool 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const TOOL_SKILL_SOURCE_TYPES = ["local_path", "github", "url", "catalog", "skills_sh"] as const;
export type CompanySkillSourceType = (typeof TOOL_SKILL_SOURCE_TYPES)[number];
export const TOOL_SKILL_TRUST_LEVELS = ["markdown_only", "assets", "scripts_executables"] as const;
export type CompanySkillTrustLevel = (typeof TOOL_SKILL_TRUST_LEVELS)[number];
export const TOOL_SKILL_COMPATIBILITIES = ["compatible", "unknown", "invalid"] as const;
export type CompanySkillCompatibility = (typeof TOOL_SKILL_COMPATIBILITIES)[number];
export const TOOL_RECEIPT_STATUSES = ["executing", "completed"] as const;
export type ToolReceiptStatus = (typeof TOOL_RECEIPT_STATUSES)[number];
export const TOOL_CLAIM_OUTCOMES = ["claimed", "replay", "in_progress"] as const;
export type ToolClaimOutcome = (typeof TOOL_CLAIM_OUTCOMES)[number];

export interface ToolDefinition {
  id: string; company_id: string; name: string; description: string;
  input_schema: unknown; adapter_type: string; adapter_config: unknown;
  enabled: boolean; created_at: string; updated_at: string;
}
export interface CompanySkill {
  id: string; company_id: string; key: string; slug: string; name: string;
  description: string | null; markdown: string; source_type: CompanySkillSourceType;
  source_locator: string | null; source_ref: string | null;
  trust_level: CompanySkillTrustLevel; compatibility: CompanySkillCompatibility;
  file_inventory: unknown; metadata: unknown; created_at: string; updated_at: string;
}
export interface ToolExecutionReceipt {
  id: string; company_id: string; run_id: string; tool: string;
  idempotency_key: string; status: ToolReceiptStatus; request_parameters: unknown;
  result_status: number | null; result_body: unknown; claimed_at: string;
  completed_at: string | null; workflow_run_id: string | null; step_id: string | null;
}

export interface ToolListDefinitionsParams { company_id: string; enabled?: boolean | null; limit: number }
export interface ToolListDefinitionsResult { definitions: ToolDefinition[] }
export interface ToolGetDefinitionParams { company_id: string; tool_id: string }
export interface ToolGetDefinitionResult { definition: ToolDefinition | null }
export interface ToolListSkillsParams { company_id: string; limit: number }
export interface ToolListSkillsResult { skills: CompanySkill[] }
export interface ToolListExecutionReceiptsParams { company_id: string; run_id?: string | null; limit: number }
export interface ToolListExecutionReceiptsResult { receipts: ToolExecutionReceipt[] }
export interface ToolClaimExecutionReceiptIdempotentParams {
  company_id: string; run_id: string; tool: string; idempotency_key: string; parameters: unknown;
}
export type ToolClaimExecutionReceiptIdempotentResult =
  { outcome: ToolClaimOutcome; receipt: ToolExecutionReceipt };

// tool.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type ToolRpcErrorKind = HeartbeatRpcErrorKind;
export type ToolCommitOutcome = HeartbeatCommitOutcome;
export type ToolRpcErrorClassification = HeartbeatRpcErrorClassification;

const SOURCE_SET: ReadonlySet<string> = new Set(TOOL_SKILL_SOURCE_TYPES);
const TRUST_SET: ReadonlySet<string> = new Set(TOOL_SKILL_TRUST_LEVELS);
const COMPAT_SET: ReadonlySet<string> = new Set(TOOL_SKILL_COMPATIBILITIES);
const STATUS_SET: ReadonlySet<string> = new Set(TOOL_RECEIPT_STATUSES);
const OUTCOME_SET: ReadonlySet<string> = new Set(TOOL_CLAIM_OUTCOMES);
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
const isSourceType = (v: unknown): v is CompanySkillSourceType => isStr(v) && SOURCE_SET.has(v);
const isTrustLevel = (v: unknown): v is CompanySkillTrustLevel => isStr(v) && TRUST_SET.has(v);
const isCompatibility = (v: unknown): v is CompanySkillCompatibility => isStr(v) && COMPAT_SET.has(v);
const isReceiptStatus = (v: unknown): v is ToolReceiptStatus => isStr(v) && STATUS_SET.has(v);
const isClaimOutcome = (v: unknown): v is ToolClaimOutcome => isStr(v) && OUTCOME_SET.has(v);
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
const checkBool = make(isBool, "a boolean");
const checkI64 = make(isI64, "a 64-bit safe integer");
// serde #[serde(default)] Option<T>: undefined and null both mean the key is
// omitted from the wire object (None on the Rust side either way).
const checkOptBool = (v: unknown, n: string) => (v === undefined || v === null ? undefined : checkBool(v, n));
const checkOptStr = (v: unknown, n: string) => (v === undefined || v === null ? undefined : checkStr(v, n));
// tool.rs pre-I/O -32602 gates: run_id/tool must be non-blank after trim;
// the value itself goes to the wire verbatim.
const checkNonBlank = (v: unknown, n: string): string => {
  const s = checkStr(v, n);
  if (s.trim().length === 0) throw new RangeError(`${n} must be non-blank`);
  return s;
};
// engine-tool validate_idempotency_key: trimmed non-empty, <= 200 chars; the
// engine re-trims before the SQL, so the raw value stays on the wire.
const checkIdempotencyKey = (v: unknown, n: string): string => {
  const s = checkStr(v, n);
  const t = s.trim();
  if (t.length === 0 || [...t].length > 200) throw new RangeError(`${n} must be 1..200 chars after trim`);
  return s;
};
// parameters is serde_json::Value: any JSON value; undefined/function/symbol/bigint cannot serialize.
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

/** Classifies a rejected tool.* call via heartbeat.*'s shared Fail tuple table. */
export const classifyToolRpcError = (error: unknown): ToolRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const DEF_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["name", isStr], ["description", isStr],
  ["input_schema", isJson], ["adapter_type", isStr], ["adapter_config", isJson],
  ["enabled", isBool], ["created_at", isTs], ["updated_at", isTs],
] as const;
const SKILL_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["key", isStr], ["slug", isStr],
  ["name", isStr], ["description", isStrOrNull], ["markdown", isStr],
  ["source_type", isSourceType], ["source_locator", isStrOrNull], ["source_ref", isStrOrNull],
  ["trust_level", isTrustLevel], ["compatibility", isCompatibility],
  ["file_inventory", isJson], ["metadata", isJson], ["created_at", isTs], ["updated_at", isTs],
] as const;
const RECEIPT_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["run_id", isStr], ["tool", isStr],
  ["idempotency_key", isStr], ["status", isReceiptStatus], ["request_parameters", isJson],
  ["result_status", isI32OrNull], ["result_body", isJson], ["claimed_at", isTs],
  ["completed_at", isTsOrNull], ["workflow_run_id", isUuidOrNull], ["step_id", isStrOrNull],
] as const;
const toDefinition = (v: unknown): ToolDefinition => row(v, DEF_ROW, "tool definition row");
const toSkill = (v: unknown): CompanySkill => row(v, SKILL_ROW, "company skill row");
const toReceipt = (v: unknown): ToolExecutionReceipt => row(v, RECEIPT_ROW, "tool execution receipt row");
const listResult = (v: unknown, key: string, msg: string): unknown[] => {
  if (!isRec(v) || !hasExactKeys(v, [key]) || !Array.isArray(v[key])) throw proto(`bad ${msg} result shape`);
  return v[key] as unknown[];
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function listToolDefinitions(
  client: PaperworkEngineClient, params: ToolListDefinitionsParams, callOpts?: CallOpts,
): Promise<ToolListDefinitionsResult> {
  checkKeys(params, ["company_id", "limit"], ["enabled"]);
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    limit: checkI64(params.limit, "limit"), // engine clamps 1..200 server-side; pass through
  };
  const enabled = checkOptBool(params.enabled, "enabled");
  if (enabled !== undefined) wire.enabled = enabled;
  return { definitions: listResult(await client.call<unknown>("tool.list_definitions", wire, callOpts),
    "definitions", "tool.list_definitions").map(toDefinition) };
}

export async function getToolDefinition(
  client: PaperworkEngineClient, params: ToolGetDefinitionParams, callOpts?: CallOpts,
): Promise<ToolGetDefinitionResult> {
  checkKeys(params, ["company_id", "tool_id"]);
  const result = await client.call<unknown>("tool.get_definition", {
    company_id: checkUuid(params.company_id, "company_id"),
    tool_id: checkUuid(params.tool_id, "tool_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["definition"])) throw proto("bad tool.get_definition result shape");
  return { definition: result.definition === null ? null : toDefinition(result.definition) };
}

export async function listCompanySkills(
  client: PaperworkEngineClient, params: ToolListSkillsParams, callOpts?: CallOpts,
): Promise<ToolListSkillsResult> {
  checkKeys(params, ["company_id", "limit"]);
  const wire = {
    company_id: checkUuid(params.company_id, "company_id"),
    limit: checkI64(params.limit, "limit"),
  };
  return { skills: listResult(await client.call<unknown>("tool.list_skills", wire, callOpts),
    "skills", "tool.list_skills").map(toSkill) };
}

export async function listToolExecutionReceipts(
  client: PaperworkEngineClient, params: ToolListExecutionReceiptsParams, callOpts?: CallOpts,
): Promise<ToolListExecutionReceiptsResult> {
  checkKeys(params, ["company_id", "limit"], ["run_id"]);
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    limit: checkI64(params.limit, "limit"),
  };
  const runId = checkOptStr(params.run_id, "run_id"); // serde Option<String>; no blank gate in Rust
  if (runId !== undefined) wire.run_id = runId;
  return { receipts: listResult(await client.call<unknown>("tool.list_execution_receipts", wire, callOpts),
    "receipts", "tool.list_execution_receipts").map(toReceipt) };
}

export async function claimToolExecutionReceiptIdempotent(
  client: PaperworkEngineClient, params: ToolClaimExecutionReceiptIdempotentParams, callOpts?: CallOpts,
): Promise<ToolClaimExecutionReceiptIdempotentResult> {
  checkKeys(params, ["company_id", "run_id", "tool", "idempotency_key", "parameters"]);
  const result = await client.call<unknown>("tool.claim_execution_receipt_idempotent", {
    company_id: checkUuid(params.company_id, "company_id"),
    run_id: checkNonBlank(params.run_id, "run_id"),
    tool: checkNonBlank(params.tool, "tool"),
    idempotency_key: checkIdempotencyKey(params.idempotency_key, "idempotency_key"),
    parameters: checkJson(params.parameters, "parameters"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["outcome", "receipt"]) || !isClaimOutcome(result.outcome)) {
    throw proto("bad tool.claim_execution_receipt_idempotent result shape");
  }
  return { outcome: result.outcome, receipt: toReceipt(result.receipt) };
}
