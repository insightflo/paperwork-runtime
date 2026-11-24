// [파일 목적] resident paperwork-engine `knowledge.*` typed RPC client — Rust
//   crates/paperwork-engine/src/knowledge.rs·engine-knowledge/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, knowledge 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const KNOWLEDGE_BASE_TYPES = ["static", "rag", "ontology"] as const;
export const KNOWLEDGE_NODE_TYPES = ["concept", "entity", "glossary", "fact", "index", "policy"] as const;
export const KNOWLEDGE_NODE_STATUSES = ["active", "retired"] as const;
export type KnowledgeBaseType = (typeof KNOWLEDGE_BASE_TYPES)[number];
export type KnowledgeNodeType = (typeof KNOWLEDGE_NODE_TYPES)[number];
export type KnowledgeNodeStatus = (typeof KNOWLEDGE_NODE_STATUSES)[number];

export interface KnowledgeBase {
  id: string; company_id: string; name: string; kb_type: KnowledgeBaseType;
  description: string; max_token_budget: number; config_json: unknown;
  created_at: string; updated_at: string;
}
export interface KnowledgeNode {
  id: string; company_id: string; kb_id: string; parent_id: string | null;
  slug: string; title: string; summary: string; content: string;
  node_type: KnowledgeNodeType; certified: boolean; status: KnowledgeNodeStatus;
  tags: string[]; linked_node_ids: string[]; source_refs: unknown;
  created_at: string; updated_at: string;
}
export interface AgentKbGrant { id: string; agent_id: string; kb_id: string; granted_by: string; created_at: string }
export interface KnowledgeListBasesParams { company_id: string }
export interface KnowledgeListBasesResult { kbs: KnowledgeBase[] }
export interface KnowledgeGetNodeParams { company_id: string; kb_id: string; node_id: string }
export interface KnowledgeGetNodeResult { node: KnowledgeNode | null }
export interface KnowledgeListNodesParams { company_id: string; kb_id: string }
export interface KnowledgeListNodesResult { nodes: KnowledgeNode[] }
export interface KnowledgeListAgentGrantsParams { company_id: string; agent_id?: string | null }
export interface KnowledgeListAgentGrantsResult { grants: AgentKbGrant[] }
export interface KnowledgeUpdateNodeFencedParams {
  company_id: string; kb_id: string; node_id: string; expected_updated_at: string | Date;
  new_title?: string | null; new_summary?: string | null; new_content?: string | null;
  new_status?: KnowledgeNodeStatus | null; new_certified?: boolean | null;
}
export type KnowledgeUpdateNodeFencedResult =
  | { applied: true; node: KnowledgeNode } | { applied: false; reason: "fenced" };

// knowledge.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type KnowledgeRpcErrorKind = HeartbeatRpcErrorKind;
export type KnowledgeCommitOutcome = HeartbeatCommitOutcome;
export type KnowledgeRpcErrorClassification = HeartbeatRpcErrorClassification;

const KB_TYPE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_BASE_TYPES);
const NODE_TYPE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_NODE_TYPES);
const NODE_STATUS_SET: ReadonlySet<string> = new Set(KNOWLEDGE_NODE_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isUuidOrNull = (v: unknown): v is string | null => v === null || isUuid(v);
const isI32 = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
const isEnum = <S extends string>(set: ReadonlySet<string>, v: unknown): v is S => isStr(v) && set.has(v);
const isKbType = (v: unknown): v is KnowledgeBaseType => isEnum(KB_TYPE_SET, v);
const isNodeType = (v: unknown): v is KnowledgeNodeType => isEnum(NODE_TYPE_SET, v);
const isNodeStatus = (v: unknown): v is KnowledgeNodeStatus => isEnum(NODE_STATUS_SET, v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isJsonValue = (v: unknown): v is unknown => v !== undefined; // jsonb: any JSON value, key required
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
const checkTs = (v: unknown, name: string): string => {
  // Date inputs re-validate through isTs so ±YYYYYY instants Chrono cannot parse.
  if (v instanceof Date && !Number.isNaN(v.getTime()) && isTs(v.toISOString())) return v.toISOString();
  if (isTs(v)) return v;
  throw new RangeError(`${name} must be a valid Date or RFC3339 timestamp`);
};
const make = <T>(guard: (v: unknown) => v is T, msg: string) => (v: unknown, name: string): T => {
  if (!guard(v)) throw new RangeError(`${name} must be ${msg}`); return v;
};
const checkUuid = make(isUuid, "a UUID string");
const checkBool = make(isBool, "a boolean");
const checkNodeStatus = make(isNodeStatus, "a valid knowledge node status");
// serde Option<T> #[serde(default)]: undefined AND null both mean absent — the
// key never reaches the wire. knowledge.rs's pre-I/O -32602 gate also rejects
// blank text values, mirrored here as RangeError before any client.call.
const checkNewText = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!isStr(v)) throw new RangeError(`${name} must be a string`);
  if (v.trim() === "") throw new RangeError(`${name} must be non-blank`);
  return v;
};
const checkNewStatus = (v: unknown): KnowledgeNodeStatus | undefined =>
  v === undefined || v === null ? undefined : checkNodeStatus(v, "new_status");
const checkNewCertified = (v: unknown): boolean | undefined =>
  v === undefined || v === null ? undefined : checkBool(v, "new_certified");

export const classifyKnowledgeRpcError = classifyHeartbeatRpcError;

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const KB_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["name", isStr], ["kb_type", isKbType],
  ["description", isStr], ["max_token_budget", isI32], ["config_json", isJsonValue],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const NODE_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["kb_id", isUuid], ["parent_id", isUuidOrNull],
  ["slug", isStr], ["title", isStr], ["summary", isStr], ["content", isStr],
  ["node_type", isNodeType], ["certified", isBool], ["status", isNodeStatus],
  ["tags", isStrArray], ["linked_node_ids", isStrArray], ["source_refs", isJsonValue],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const GRANT_ROW = [
  ["id", isUuid], ["agent_id", isUuid], ["kb_id", isUuid], ["granted_by", isStr], ["created_at", isTs],
] as const;
const toKb = (v: unknown): KnowledgeBase => row(v, KB_ROW, "knowledge_base");
const toNode = (v: unknown): KnowledgeNode => row(v, NODE_ROW, "knowledge_node");
const toGrant = (v: unknown): AgentKbGrant => row(v, GRANT_ROW, "agent_kb_grant");

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function listKnowledgeBases(
  client: PaperworkEngineClient, params: KnowledgeListBasesParams, callOpts?: CallOpts,
): Promise<KnowledgeListBasesResult> {
  const result = await client.call<unknown>("knowledge.list_bases", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["kbs"]) || !Array.isArray(result.kbs)) {
    throw proto("bad knowledge.list_bases result shape");
  }
  return { kbs: result.kbs.map(toKb) };
}

export async function getKnowledgeNode(
  client: PaperworkEngineClient, params: KnowledgeGetNodeParams, callOpts?: CallOpts,
): Promise<KnowledgeGetNodeResult> {
  const result = await client.call<unknown>("knowledge.get_node", {
    company_id: checkUuid(params.company_id, "company_id"),
    kb_id: checkUuid(params.kb_id, "kb_id"),
    node_id: checkUuid(params.node_id, "node_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["node"])) throw proto("bad knowledge.get_node result shape");
  return { node: result.node === null ? null : toNode(result.node) };
}

export async function listKnowledgeNodes(
  client: PaperworkEngineClient, params: KnowledgeListNodesParams, callOpts?: CallOpts,
): Promise<KnowledgeListNodesResult> {
  const result = await client.call<unknown>("knowledge.list_nodes", {
    company_id: checkUuid(params.company_id, "company_id"),
    kb_id: checkUuid(params.kb_id, "kb_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["nodes"]) || !Array.isArray(result.nodes)) {
    throw proto("bad knowledge.list_nodes result shape");
  }
  return { nodes: result.nodes.map(toNode) };
}

export async function listAgentKbGrants(
  client: PaperworkEngineClient, params: KnowledgeListAgentGrantsParams, callOpts?: CallOpts,
): Promise<KnowledgeListAgentGrantsResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  if (params.agent_id !== undefined && params.agent_id !== null) {
    wire.agent_id = checkUuid(params.agent_id, "agent_id");
  }
  const result = await client.call<unknown>("knowledge.list_agent_grants", wire, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["grants"]) || !Array.isArray(result.grants)) {
    throw proto("bad knowledge.list_agent_grants result shape");
  }
  return { grants: result.grants.map(toGrant) };
}

export async function updateKnowledgeNodeFenced(
  client: PaperworkEngineClient, params: KnowledgeUpdateNodeFencedParams, callOpts?: CallOpts,
): Promise<KnowledgeUpdateNodeFencedResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    kb_id: checkUuid(params.kb_id, "kb_id"),
    node_id: checkUuid(params.node_id, "node_id"),
    expected_updated_at: checkTs(params.expected_updated_at, "expected_updated_at"),
  };
  const fields: [string, unknown][] = [
    ["new_title", checkNewText(params.new_title, "new_title")],
    ["new_summary", checkNewText(params.new_summary, "new_summary")],
    ["new_content", checkNewText(params.new_content, "new_content")],
    ["new_status", checkNewStatus(params.new_status)],
    ["new_certified", checkNewCertified(params.new_certified)],
  ];
  // knowledge.rs's pre-I/O -32602 gate: at least one new_* field must be present.
  if (fields.every(([, v]) => v === undefined)) {
    throw new RangeError("update_node_fenced requires at least one new_* field");
  }
  for (const [k, v] of fields) { if (v !== undefined) wire[k] = v; }
  const result = await client.call<unknown>("knowledge.update_node_fenced", wire, callOpts);
  if (!isRec(result) || typeof result.applied !== "boolean"
    || !hasExactKeys(result, result.applied ? ["applied", "node"] : ["applied", "reason"])
    || (!result.applied && result.reason !== "fenced")) {
    throw proto("bad knowledge.update_node_fenced result shape");
  }
  return result.applied ? { applied: true, node: toNode(result.node) } : { applied: false, reason: "fenced" };
}
