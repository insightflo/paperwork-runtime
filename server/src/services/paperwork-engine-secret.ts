// [파일 목적] resident paperwork-engine `secret.*` typed RPC client — Rust
//   crates/paperwork-engine/src/secret.rs·engine-secret/{lib,queries}.rs 와
//   필드명·에러 코드·결과 union 을 1:1 로 맞춘 fail-closed 경계 계층. 실행 권한은
//   엔진의 SQL/Rust 계약이며 TS는 직렬화·응답 검증·에러 분류만 담당한다.
//   METADATA-ONLY 불변조건: 비밀값 material/value/plaintext 를 자체 또는 상속
//   키로 실은 행·엔벌로프는 decode 없이 protocol_error 로 거부한다.
// [외부 연결] paperwork-engine-client PaperworkEngineClient/PaperworkEngineError,
//   paperwork-engine-heartbeat classifyHeartbeatRpcError 위임, secret 감독 경유 호출부.
import { PaperworkEngineError, type PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  classifyHeartbeatRpcError, type HeartbeatCommitOutcome,
  type HeartbeatRpcErrorClassification, type HeartbeatRpcErrorKind,
} from "./paperwork-engine-heartbeat.js";

// company_secrets 의 metadata-only 11열 투영 — material·value_sha256 은 절대 없다.
export interface SecretMetadata {
  id: string; company_id: string; name: string; provider: string;
  external_ref: string | null; latest_version: number; description: string | null;
  created_by_agent_id: string | null; created_by_user_id: string | null;
  created_at: string; updated_at: string;
}
// company_secret_versions 의 metadata-only 7열 투영 (material·value_sha256 제외).
export interface SecretVersionMetadata {
  id: string; secret_id: string; version: number;
  created_by_agent_id: string | null; created_by_user_id: string | null;
  created_at: string; revoked_at: string | null;
}
export interface SecretListParams { company_id: string; limit?: number }
export interface SecretListResult { secrets: SecretMetadata[] }
export interface SecretGetByIdParams { company_id: string; secret_id: string }
export interface SecretGetByNameParams { company_id: string; name: string }
export interface SecretGetResult { secret: SecretMetadata | null }
export interface SecretListVersionsParams { company_id: string; secret_id: string; limit?: number }
export interface SecretListVersionsResult { versions: SecretVersionMetadata[] }
export interface SecretBumpLatestVersionFencedParams {
  company_id: string; secret_id: string; expected_latest_version: number; new_version: number;
}
export type SecretBumpLatestVersionFencedResult =
  | { applied: true; secret: SecretMetadata } | { applied: false; reason: "fenced" };

// secret.* shares the heartbeat Fail tuple table (-32001..-32005, -32602).
export type SecretRpcErrorKind = HeartbeatRpcErrorKind;
export type SecretCommitOutcome = HeartbeatCommitOutcome;
export type SecretRpcErrorClassification = HeartbeatRpcErrorClassification;

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
const checkI64 = make((v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v), "a 64-bit safe integer");
const checkI32 = make(isI32, "a 32-bit signed integer");
// secret.rs's pre-I/O -32602 gate (get_by_name trim().is_empty()) never ships.
const checkNonEmpty = make((v: unknown): v is string => isStr(v) && v.trim() !== "", "a non-empty string");

// SECURITY INVARIANT (metadata-only): a decoded row or envelope carrying a
// banned material key — as an own OR inherited property — fails closed here,
// before the exact own-key-set check that would reject an own copy anyway.
const BANNED_MATERIAL_KEYS = ["material", "value", "plaintext"] as const;
const assertMetadataOnly = (v: Record<string, unknown>, msg: string): void => {
  for (const k of BANNED_MATERIAL_KEYS) if (k in v) throw proto(`${msg} carries banned material key ${k}`);
};

/** Classifies a rejected secret.* call via heartbeat.*'s shared Fail tuple table. */
export const classifySecretRpcError = (error: unknown): SecretRpcErrorClassification =>
  classifyHeartbeatRpcError(error);

// --- response validators -----------------------------------------------------
const env = (v: unknown, keys: readonly string[], msg: string): Record<string, unknown> => {
  if (!isRec(v)) throw proto(`bad ${msg} shape`);
  assertMetadataOnly(v, msg);
  if (!hasExactKeys(v, keys)) throw proto(`bad ${msg} shape`);
  return v;
};
const row = <T>(v: unknown, fields: readonly (readonly [string, (g: unknown) => boolean])[], msg: string): T => {
  if (!isRec(v)) throw proto(`bad ${msg} shape`);
  assertMetadataOnly(v, msg);
  if (Object.keys(v).length !== fields.length
    || !fields.every(([k, g]) => Object.hasOwn(v, k) && g(v[k]))) throw proto(`bad ${msg} shape`);
  return v as unknown as T;
};
const SECRET_ROW = [
  ["id", isUuid], ["company_id", isUuid], ["name", isStr], ["provider", isStr],
  ["external_ref", isStrOrNull], ["latest_version", isI32], ["description", isStrOrNull],
  ["created_by_agent_id", isUuidOrNull], ["created_by_user_id", isStrOrNull],
  ["created_at", isTs], ["updated_at", isTs],
] as const;
const VERSION_ROW = [
  ["id", isUuid], ["secret_id", isUuid], ["version", isI32],
  ["created_by_agent_id", isUuidOrNull], ["created_by_user_id", isStrOrNull],
  ["created_at", isTs], ["revoked_at", isTsOrNull],
] as const;
const toSecret = (v: unknown): SecretMetadata => row(v, SECRET_ROW, "secret metadata");
const toVersion = (v: unknown): SecretVersionMetadata => row(v, VERSION_ROW, "secret version metadata");

// --- typed methods (params mirror Rust #[serde(deny_unknown_fields)] structs) --
type CallOpts = { timeoutMs?: number };
const checkLimit = (wire: Record<string, unknown>, limit: unknown): void => {
  // i64 #[serde(default = 50)]: undefined omits the key; null is not an i64 and
  // would hit the engine -32602 gate, so it fails closed here as RangeError.
  if (limit !== undefined) wire.limit = checkI64(limit, "limit");
};

export async function listSecrets(
  client: PaperworkEngineClient, params: SecretListParams, callOpts?: CallOpts,
): Promise<SecretListResult> {
  const wire: Record<string, unknown> = { company_id: checkUuid(params.company_id, "company_id") };
  // engine clamps to 1..=200 via clamp_list_limit; the client sends it verbatim.
  checkLimit(wire, params.limit);
  const result = env(await client.call<unknown>("secret.list", wire, callOpts), ["secrets"], "secret.list result");
  if (!Array.isArray(result.secrets)) throw proto("bad secret.list result shape");
  return { secrets: result.secrets.map(toSecret) };
}

export async function getSecretById(
  client: PaperworkEngineClient, params: SecretGetByIdParams, callOpts?: CallOpts,
): Promise<SecretGetResult> {
  const result = env(await client.call<unknown>("secret.get_by_id", {
    company_id: checkUuid(params.company_id, "company_id"),
    secret_id: checkUuid(params.secret_id, "secret_id"),
  }, callOpts), ["secret"], "secret.get_by_id result");
  return { secret: result.secret === null ? null : toSecret(result.secret) };
}

export async function getSecretByName(
  client: PaperworkEngineClient, params: SecretGetByNameParams, callOpts?: CallOpts,
): Promise<SecretGetResult> {
  const result = env(await client.call<unknown>("secret.get_by_name", {
    company_id: checkUuid(params.company_id, "company_id"),
    // secret.rs trims only for the empty gate; the name ships verbatim.
    name: checkNonEmpty(params.name, "name"),
  }, callOpts), ["secret"], "secret.get_by_name result");
  return { secret: result.secret === null ? null : toSecret(result.secret) };
}

export async function listSecretVersions(
  client: PaperworkEngineClient, params: SecretListVersionsParams, callOpts?: CallOpts,
): Promise<SecretListVersionsResult> {
  const wire: Record<string, unknown> = {
    company_id: checkUuid(params.company_id, "company_id"),
    secret_id: checkUuid(params.secret_id, "secret_id"),
  };
  checkLimit(wire, params.limit);
  const result = env(await client.call<unknown>("secret.list_versions", wire, callOpts), ["versions"], "secret.list_versions result");
  if (!Array.isArray(result.versions)) throw proto("bad secret.list_versions result shape");
  return { versions: result.versions.map(toVersion) };
}

export async function bumpSecretLatestVersionFenced(
  client: PaperworkEngineClient, params: SecretBumpLatestVersionFencedParams, callOpts?: CallOpts,
): Promise<SecretBumpLatestVersionFencedResult> {
  const expected = checkI32(params.expected_latest_version, "expected_latest_version");
  const next = checkI32(params.new_version, "new_version");
  // engine-secret validate_version_bump: expected >= 1 and new == expected + 1;
  // i32::MAX has no successor and fails closed the same way, before any I/O.
  if (expected < 1 || expected + 1 !== next) {
    throw new RangeError("invalid secret version bump: require expected_latest_version >= 1 and new_version == expected_latest_version + 1");
  }
  const result = await client.call<unknown>("secret.bump_latest_version_fenced", {
    company_id: checkUuid(params.company_id, "company_id"),
    secret_id: checkUuid(params.secret_id, "secret_id"),
    expected_latest_version: expected, new_version: next,
  }, callOpts);
  if (!isRec(result) || typeof result.applied !== "boolean") {
    throw proto("bad secret.bump_latest_version_fenced result shape");
  }
  assertMetadataOnly(result, "secret.bump_latest_version_fenced result");
  if (!hasExactKeys(result, result.applied ? ["applied", "secret"] : ["applied", "reason"])
    || (!result.applied && result.reason !== "fenced")) {
    throw proto("bad secret.bump_latest_version_fenced result shape");
  }
  return result.applied
    ? { applied: true, secret: toSecret(result.secret) }
    : { applied: false, reason: "fenced" };
}
