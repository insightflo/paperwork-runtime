// [파일 목적] paperwork-engine secret.* 실트래픽 컷오버 어댑터 —
//   PAPERWORK_RUST_SECRET_CUTOVER=1 이면 쓰기(bump_latest_version_fenced)를
//   Rust RPC 로 먼저 시도한다. 응답이 not_committed 로 분류되면 경고 후 기존 TS
//   작성자로 폴백하고, indeterminate 면 엔진이 버전 범프를 커밋했을 수 있으므로
//   절대 TS 폴백을 호출하지 않고 SecretCutoverIndeterminateError 를 던진다
//   (이중 적용 방지). 읽기(list/get_by_id/get_by_name/list_versions)는 부작용이
//   없어 어떤 오류든 TS 폴백한다. 플래그 OFF·null 클라이언트는 RPC 없이 곧바로
//   TS 경로다. typed client 의 전송 전 RangeError 는 미전송이지만 미분류
//   입력이므로 issue/tool 컷오버와 같은 fail-closed 분류(indeterminate)를
//   따른다. fence 미적용 응답({applied:false,reason:"fenced"})은 성공 결과이므로
//   폴백 없이 그대로 반환한다. metadata-only 도메인 — 비밀값 material 은
//   파라미터·결과·로그 어디에도 포함되지 않는다.
// [외부 연결] paperwork-engine-secret typed client(파라미터 snake_case·에러
//   분류 1:1 재사용), PaperworkEngineClient, middleware logger. 호출부는 기존
//   TS 작성자/리더 호출을 그대로 tsFallback 으로 넘긴다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  bumpSecretLatestVersionFenced, classifySecretRpcError, getSecretById,
  getSecretByName, listSecrets, listSecretVersions,
  type SecretBumpLatestVersionFencedParams,
  type SecretBumpLatestVersionFencedResult,
  type SecretGetByIdParams, type SecretGetByNameParams, type SecretGetResult,
  type SecretListParams, type SecretListResult,
  type SecretListVersionsParams, type SecretListVersionsResult,
  type SecretRpcErrorClassification,
} from "./paperwork-engine-secret.js";

export const SECRET_CUTOVER_WRITE_TIMEOUT_MS = 17_000;
export const SECRET_CUTOVER_READ_TIMEOUT_MS = 10_000;

/** 쓰기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [17s, 600s] 로 클램프한다. 엔진
 *  callOpts.timeoutMs 는 정수 1..600_000 필수 — 비유한 입력은 17s 기본값을 쓴다. */
function cutoverWriteTimeoutMs(requested: number | undefined): number {
  return Math.min(600_000, Math.max(SECRET_CUTOVER_WRITE_TIMEOUT_MS,
    Math.trunc(typeof requested === "number" && Number.isFinite(requested) ? requested : 0)));
}

/** 읽기 RPC 타임아웃 — 유한 입력은 정수로 잘라 [1, 600s] 로 클램프하고, 비유한 입력은 10s 를 쓴다. */
function cutoverReadTimeoutMs(requested: number | undefined): number {
  return typeof requested === "number" && Number.isFinite(requested)
    ? Math.min(600_000, Math.max(1, Math.trunc(requested)))
    : SECRET_CUTOVER_READ_TIMEOUT_MS;
}

export type SecretCutoverSource = "rust" | "ts";
export interface SecretCutoverResult<T> { source: SecretCutoverSource; value: T }
export type SecretCutoverOperation =
  | "bump_latest_version_fenced"
  | "list" | "get_by_id" | "get_by_name" | "list_versions";
type CutoverEnv = Readonly<Record<string, string | undefined>>;
export interface SecretCutoverCallOpts { timeoutMs?: number; env?: CutoverEnv }

/** outcome 이 indeterminate 인 쓰기는 엔진이 커밋했을 수 있어 TS 재적용이
 *  이중 쓰기가 된다. tsFallback 을 호출하지 않고 이 오류로 상위 판단에 맡긴다. */
export class SecretCutoverIndeterminateError extends Error {
  constructor(
    readonly operation: SecretCutoverOperation,
    readonly classification: SecretRpcErrorClassification,
    override readonly cause: unknown,
  ) {
    super(`secret cutover ${operation} outcome is indeterminate; refusing TS fallback`);
    this.name = "SecretCutoverIndeterminateError";
  }
}

export function isSecretEngineCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_SECRET_CUTOVER === "1";
}

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

async function writeWithCutover<T>(
  operation: SecretCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<SecretCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    const classification = classifySecretRpcError(error);
    if (classification.outcome === "not_committed") {
      safeWarn({ operation, kind: classification.kind, err: error },
        "paperwork-engine secret write not committed; falling back to TS writer");
      return { source: "ts", value: await tsFallback() };
    }
    throw new SecretCutoverIndeterminateError(operation, classification, error);
  }
}

async function readWithCutover<T>(
  operation: SecretCutoverOperation,
  call: () => Promise<T>,
  tsFallback: () => Promise<T>,
): Promise<SecretCutoverResult<T>> {
  try {
    return { source: "rust", value: await call() };
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine secret read failed; falling back to TS reader");
    return { source: "ts", value: await tsFallback() };
  }
}

export async function bumpSecretLatestVersionFencedWithCutover(
  client: PaperworkEngineClient | null,
  params: SecretBumpLatestVersionFencedParams,
  tsFallback: () => Promise<SecretBumpLatestVersionFencedResult>,
  opts: SecretCutoverCallOpts = {},
): Promise<SecretCutoverResult<SecretBumpLatestVersionFencedResult>> {
  if (client === null || !isSecretEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return writeWithCutover("bump_latest_version_fenced",
    () => bumpSecretLatestVersionFenced(client, params,
      { timeoutMs: cutoverWriteTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listSecretsWithCutover(
  client: PaperworkEngineClient | null,
  params: SecretListParams,
  tsFallback: () => Promise<SecretListResult>,
  opts: SecretCutoverCallOpts = {},
): Promise<SecretCutoverResult<SecretListResult>> {
  if (client === null || !isSecretEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list",
    () => listSecrets(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getSecretByIdWithCutover(
  client: PaperworkEngineClient | null,
  params: SecretGetByIdParams,
  tsFallback: () => Promise<SecretGetResult>,
  opts: SecretCutoverCallOpts = {},
): Promise<SecretCutoverResult<SecretGetResult>> {
  if (client === null || !isSecretEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_by_id",
    () => getSecretById(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function getSecretByNameWithCutover(
  client: PaperworkEngineClient | null,
  params: SecretGetByNameParams,
  tsFallback: () => Promise<SecretGetResult>,
  opts: SecretCutoverCallOpts = {},
): Promise<SecretCutoverResult<SecretGetResult>> {
  if (client === null || !isSecretEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("get_by_name",
    () => getSecretByName(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}

export async function listSecretVersionsWithCutover(
  client: PaperworkEngineClient | null,
  params: SecretListVersionsParams,
  tsFallback: () => Promise<SecretListVersionsResult>,
  opts: SecretCutoverCallOpts = {},
): Promise<SecretCutoverResult<SecretListVersionsResult>> {
  if (client === null || !isSecretEngineCutoverEnabled(opts.env)) {
    return { source: "ts", value: await tsFallback() };
  }
  return readWithCutover("list_versions",
    () => listSecretVersions(client, params, { timeoutMs: cutoverReadTimeoutMs(opts.timeoutMs) }),
    tsFallback);
}
