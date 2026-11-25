// [파일 목적] resident paperwork-engine `skill.*` typed RPC client — Rust
//   crates/paperwork-engine/src/skill.rs·engine-skill/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, skill 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

export const SKILL_SOURCE_TYPES = ["local_path", "github", "url", "catalog", "skills_sh"] as const;
export const SKILL_TRUST_LEVELS = ["markdown_only", "assets", "scripts_executables"] as const;
export const SKILL_COMPATIBILITIES = ["compatible", "unknown", "invalid"] as const;
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number];
export type SkillTrustLevel = (typeof SKILL_TRUST_LEVELS)[number];
export type SkillCompatibility = (typeof SKILL_COMPATIBILITIES)[number];

export interface SkillRow {
  id: string; company_id: string; key: string; slug: string; name: string;
  description: string | null; markdown: string; source_type: SkillSourceType;
  source_locator: string | null; source_ref: string | null; trust_level: SkillTrustLevel;
  compatibility: SkillCompatibility; file_inventory: unknown; metadata: unknown;
  created_at: string; updated_at: string;
}
export interface SkillListParams { company_id: string }
export interface SkillGetByIdParams { company_id: string; skill_id: string }
export interface SkillGetByKeyParams { company_id: string; key: string }
export interface SkillUpsertParams {
  company_id: string; key: string; slug: string; name: string; description?: string | null;
  markdown: string; source_type: SkillSourceType; source_locator?: string | null;
  source_ref?: string | null; trust_level: SkillTrustLevel; compatibility: SkillCompatibility;
  file_inventory: unknown[]; metadata?: Record<string, unknown> | null;
}
export interface SkillDeleteParams { company_id: string; skill_id: string }
export type SkillGetResult = { found: true; skill: SkillRow } | { found: false };
export type SkillUpsertResult = { upserted: true; skill: SkillRow };
export type SkillDeleteResult = { deleted: true; skill: SkillRow } | { deleted: false };

// skill.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type SkillRpcErrorKind = HeartbeatRpcErrorKind;
export type SkillCommitOutcome = HeartbeatCommitOutcome;
export type SkillRpcErrorClassification = HeartbeatRpcErrorClassification;

const SOURCE_SET: ReadonlySet<string> = new Set(SKILL_SOURCE_TYPES);
const TRUST_SET: ReadonlySet<string> = new Set(SKILL_TRUST_LEVELS);
const COMPAT_SET: ReadonlySet<string> = new Set(SKILL_COMPATIBILITIES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Required keys must be own properties: a bare key count lets inherited fields in.
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isUuid = (v: unknown): v is string => isStr(v) && UUID_RE.test(v);
const isEnum = <S extends string>(set: ReadonlySet<string>, v: unknown): v is S => isStr(v) && set.has(v);
const isSourceType = (v: unknown): v is SkillSourceType => isEnum(SOURCE_SET, v);
const isTrustLevel = (v: unknown): v is SkillTrustLevel => isEnum(TRUST_SET, v);
const isCompatibility = (v: unknown): v is SkillCompatibility => isEnum(COMPAT_SET, v);
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
const isJson = (v: unknown): boolean => v !== undefined;
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!isRec(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

const proto = (msg: string) => new PaperworkEngineError("protocol_error", msg);
const make = <T>(guard: (v: unknown) => v is T, msg: string) => (v: unknown, name: string): T => {
  if (!guard(v)) throw new RangeError(`${name} must be ${msg}`); return v;
};
const checkUuid = make(isUuid, "a UUID string");
const checkSourceType = make(isSourceType, "a valid skill source type");
const checkTrustLevel = make(isTrustLevel, "a valid skill trust level");
const checkCompatibility = make(isCompatibility, "a valid skill compatibility");
const checkNonEmpty = (v: unknown, name: string): string => {
  if (!isStr(v) || v.trim() === "") throw new RangeError(`${name} must be a non-empty string`);
  return v;
};
// serde Option<T>: undefined keeps the key off the wire, null -> None.
const checkOptStr = (v: unknown, n: string) => (v === undefined || v === null ? v : make(isStr, "a string")(v, n));
const checkMetadata = (v: unknown): Record<string, unknown> | null | undefined => {
  if (v === undefined || v === null) return v;
  if (!isPlainObject(v)) throw new RangeError("metadata must be a plain object or null");
  return v;
};

/** Classifies a rejected skill.* call via heartbeat.*'s shared Fail tuple table. */
export const classifySkillRpcError = (error: unknown): SkillRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (isRec(v) && Object.keys(v).length === fields.length
    && fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) return v as unknown as T;
  throw proto(`bad ${msg} shape`);
};
const SKILL_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["key", isStr], ["slug", isStr], ["name", isStr],
  ["description", isStrOrNull], ["markdown", isStr], ["source_type", isSourceType],
  ["source_locator", isStrOrNull], ["source_ref", isStrOrNull], ["trust_level", isTrustLevel],
  ["compatibility", isCompatibility], ["file_inventory", isJson], ["metadata", isJson],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const toSkill = (v: unknown): SkillRow => row(v, SKILL_ROW, "skill row");
const checkFlag = (v: unknown, method: string, flag: "found" | "deleted"): Record<string, unknown> => {
  if (!isRec(v) || typeof v[flag] !== "boolean" || !hasExactKeys(v, v[flag] ? [flag, "skill"] : [flag])) {
    throw proto(`bad ${method} result shape`);
  }
  return v;
};
const checkUpserted = (v: unknown): Record<string, unknown> => {
  if (!isRec(v) || v.upserted !== true || !hasExactKeys(v, ["upserted", "skill"])) {
    throw proto("bad skill.upsert result shape");
  }
  return v;
};

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };

export async function listSkills(
  client: PaperworkEngineClient, params: SkillListParams, callOpts?: CallOpts,
): Promise<SkillRow[]> {
  const result = await client.call<unknown>("skill.list", {
    company_id: checkUuid(params.company_id, "company_id"),
  }, callOpts);
  if (!isRec(result) || !hasExactKeys(result, ["skills"]) || !Array.isArray(result.skills)) {
    throw proto("bad skill.list result shape");
  }
  return result.skills.map(toSkill);
}

export async function getSkillById(
  client: PaperworkEngineClient, params: SkillGetByIdParams, callOpts?: CallOpts,
): Promise<SkillGetResult> {
  const result = await client.call<unknown>("skill.get_by_id", {
    company_id: checkUuid(params.company_id, "company_id"),
    skill_id: checkUuid(params.skill_id, "skill_id"),
  }, callOpts);
  const o = checkFlag(result, "skill.get_by_id", "found");
  return o.found ? { found: true, skill: toSkill(o.skill) } : { found: false };
}

export async function getSkillByKey(
  client: PaperworkEngineClient, params: SkillGetByKeyParams, callOpts?: CallOpts,
): Promise<SkillGetResult> {
  const result = await client.call<unknown>("skill.get_by_key", {
    company_id: checkUuid(params.company_id, "company_id"),
    key: checkNonEmpty(params.key, "key"),
  }, callOpts);
  const o = checkFlag(result, "skill.get_by_key", "found");
  return o.found ? { found: true, skill: toSkill(o.skill) } : { found: false };
}

export async function upsertSkill(
  client: PaperworkEngineClient, params: SkillUpsertParams, callOpts?: CallOpts,
): Promise<SkillUpsertResult> {
  if (!Array.isArray(params.file_inventory)) throw new RangeError("file_inventory must be an Array");
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    key: checkNonEmpty(params.key, "key"), slug: checkNonEmpty(params.slug, "slug"),
    name: checkNonEmpty(params.name, "name"), markdown: checkNonEmpty(params.markdown, "markdown"),
    source_type: checkSourceType(params.source_type, "source_type"),
    trust_level: checkTrustLevel(params.trust_level, "trust_level"),
    compatibility: checkCompatibility(params.compatibility, "compatibility"),
    file_inventory: params.file_inventory,
  };
  for (const name of ["description", "source_locator", "source_ref"] as const) {
    const v = checkOptStr(params[name], name);
    if (v !== undefined) wire[name] = v;
  }
  const metadata = checkMetadata(params.metadata);
  if (metadata !== undefined) wire.metadata = metadata;
  const o = checkUpserted(await client.call<unknown>("skill.upsert", wire, callOpts));
  return { upserted: true, skill: toSkill(o.skill) };
}

export async function deleteSkill(
  client: PaperworkEngineClient, params: SkillDeleteParams, callOpts?: CallOpts,
): Promise<SkillDeleteResult> {
  const result = await client.call<unknown>("skill.delete", {
    company_id: checkUuid(params.company_id, "company_id"),
    skill_id: checkUuid(params.skill_id, "skill_id"),
  }, callOpts);
  const o = checkFlag(result, "skill.delete", "deleted");
  return o.deleted ? { deleted: true, skill: toSkill(o.skill) } : { deleted: false };
}
