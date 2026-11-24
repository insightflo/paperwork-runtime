// [파일 목적] Phase 2L Wave 5 — secret.* 컷오버 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_SECRET_CUTOVER=1(기본 OFF)일 때만 공유 엔진 클라이언트를 지연
//   해석해 컷오버 어댑터(secret-cutover)에 위임하고, 그 외에는 TS 경로를 그대로
//   호출한다. 쓰기(bump_latest_version_fenced)의 indeterminate 는 절대 TS 폴백
//   없이 전파하고, fence 미적용({applied:false,reason:"fenced"})은 엔진의 정상
//   응답이므로 폴백 없이 rust_ok 로 집계한다. metadata-only 도메인 — 이벤트에는
//   비밀 material 이 아니라 operation/outcome/source/duration/error 만 담긴다.
// [외부 연결] secret-cutover(어댑터), paperwork-engine-secret(타입),
//   paperwork-engine-runtime(공유 클라이언트), logger. 호출부는
//   createSecretCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import {
  bumpSecretLatestVersionFencedWithCutover,
  getSecretByIdWithCutover,
  getSecretByNameWithCutover,
  isSecretEngineCutoverEnabled,
  listSecretsWithCutover,
  listSecretVersionsWithCutover,
  SecretCutoverIndeterminateError,
  type SecretCutoverCallOpts,
  type SecretCutoverResult,
} from "./secret-cutover.js";
import type {
  SecretBumpLatestVersionFencedParams, SecretBumpLatestVersionFencedResult,
  SecretGetByIdParams, SecretGetByNameParams, SecretGetResult,
  SecretListParams, SecretListResult, SecretListVersionsParams, SecretListVersionsResult,
} from "./paperwork-engine-secret.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { SecretCutoverIndeterminateError };
export type { SecretCutoverCallOpts, SecretCutoverResult };

/** 공유 클라이언트 해석기 반환형에서 유도 — 클라이언트 모듈을 직접 import 하지 않는다. */
type EngineClient = NonNullable<ReturnType<typeof getSharedPaperworkEngineClient>>;

/** 텔레메트리가 다루는 secret.* 컷오버 대상 — RPC 메서드 접미사와 1:1 대응. */
export const SECRET_WIRED_OPERATIONS = [
  "list", "get_by_id", "get_by_name", "list_versions", "bump_latest_version_fenced",
] as const;
export type SecretWiredOperation = (typeof SECRET_WIRED_OPERATIONS)[number];

export type SecretCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface SecretCutoverTelemetryEvent {
  operation: SecretWiredOperation;
  outcome: SecretCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  error?: unknown;
}

export interface SecretCutoverOperationMetrics {
  rustOk: number; fallback: number; indeterminate: number;
  tsBypass: number; tsError: number; totalCalls: number; totalDurationMs: number;
}

export type SecretCutoverMetricsSnapshot = Readonly<
  Record<SecretWiredOperation, Readonly<SecretCutoverOperationMetrics>>>;

export interface SecretCutoverWiringOpts extends SecretCutoverCallOpts {
  getClient?: () => EngineClient | null;
  onEvent?: (event: SecretCutoverTelemetryEvent) => void;
}

type Meter = Record<SecretWiredOperation, SecretCutoverOperationMetrics>;

const emptyOperationMetrics = (): SecretCutoverOperationMetrics => ({
  rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0,
  tsError: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  SECRET_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): SecretCutoverMetricsSnapshot =>
  Object.fromEntries(SECRET_WIRED_OPERATIONS.map(
    (op) => [op, { ...meter[op] }])) as SecretCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: SecretWiredOperation;
  call: (c: EngineClient, o: SecretCutoverCallOpts) => Promise<SecretCutoverResult<T>>;
  tsFallback: () => Promise<T>;
  opts: SecretCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<SecretCutoverResult<T>> {
  const { operation, call, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: SecretCutoverOutcome, source: "rust" | "ts" | null,
    error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "secret cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "secret cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<SecretCutoverResult<T>> => {
    metrics.tsBypass += 1;
    try {
      const value = await tsFallback();
      emit("ts_bypass", "ts");
      return { source: "ts", value };
    } catch (error) {
      metrics.tsError += 1;
      emit("ts_error", "ts", error);
      throw error;
    }
  };

  const env = opts.env ?? process.env;
  if (!isSecretEngineCutoverEnabled(env)) return runTsBypass();

  let client: EngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine client resolution failed; bypassing to TS");
    return runTsBypass();
  }
  if (client === null) {
    safeWarn({ operation },
      "paperwork-engine client unavailable; bypassing to TS");
    return runTsBypass();
  }

  try {
    const result = await call(client, { timeoutMs: opts.timeoutMs, env });
    if (result.source === "rust") {
      metrics.rustOk += 1;
      emit("rust_ok", "rust");
    } else {
      metrics.fallback += 1;
      emit("fallback", "ts");
    }
    return result;
  } catch (error) {
    if (error instanceof SecretCutoverIndeterminateError) {
      metrics.indeterminate += 1;
      emit("indeterminate", null, error);
    } else {
      // 어댑터가 던지는 비-indeterminate 오류는 tsFallback 자체의 실패다.
      metrics.tsError += 1;
      emit("ts_error", null, error);
    }
    throw error;
  }
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getSecretCutoverMetrics(): SecretCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetSecretCutoverMetricsForTests(): void {
  for (const op of SECRET_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

function wireOp<T>(meter: Meter, operation: SecretWiredOperation,
  call: CutoverJob<T>["call"], tsFallback: () => Promise<T>, opts: SecretCutoverWiringOpts,
): Promise<SecretCutoverResult<T>> {
  return executeCutover({ operation, call, tsFallback, opts, meter });
}

export function wireSecretListCutover(
  params: SecretListParams,
  tsFallback: () => Promise<SecretListResult>,
  opts: SecretCutoverWiringOpts = {}): Promise<SecretCutoverResult<SecretListResult>> {
  return wireOp(moduleMeter, "list",
    (c, o) => listSecretsWithCutover(c, params, tsFallback, o), tsFallback, opts);
}

export function wireSecretGetByIdCutover(
  params: SecretGetByIdParams,
  tsFallback: () => Promise<SecretGetResult>,
  opts: SecretCutoverWiringOpts = {}): Promise<SecretCutoverResult<SecretGetResult>> {
  return wireOp(moduleMeter, "get_by_id",
    (c, o) => getSecretByIdWithCutover(c, params, tsFallback, o), tsFallback, opts);
}

export function wireSecretGetByNameCutover(
  params: SecretGetByNameParams,
  tsFallback: () => Promise<SecretGetResult>,
  opts: SecretCutoverWiringOpts = {}): Promise<SecretCutoverResult<SecretGetResult>> {
  return wireOp(moduleMeter, "get_by_name",
    (c, o) => getSecretByNameWithCutover(c, params, tsFallback, o), tsFallback, opts);
}

export function wireSecretListVersionsCutover(
  params: SecretListVersionsParams,
  tsFallback: () => Promise<SecretListVersionsResult>,
  opts: SecretCutoverWiringOpts = {}): Promise<SecretCutoverResult<SecretListVersionsResult>> {
  return wireOp(moduleMeter, "list_versions",
    (c, o) => listSecretVersionsWithCutover(c, params, tsFallback, o), tsFallback, opts);
}

export function wireSecretBumpLatestVersionFencedCutover(
  params: SecretBumpLatestVersionFencedParams,
  tsFallback: () => Promise<SecretBumpLatestVersionFencedResult>,
  opts: SecretCutoverWiringOpts = {},
): Promise<SecretCutoverResult<SecretBumpLatestVersionFencedResult>> {
  return wireOp(moduleMeter, "bump_latest_version_fenced",
    (c, o) => bumpSecretLatestVersionFencedWithCutover(c, params, tsFallback, o),
    tsFallback, opts);
}

export interface SecretCutoverHooks {
  listSecretsWired: typeof wireSecretListCutover;
  getSecretByIdWired: typeof wireSecretGetByIdCutover;
  getSecretByNameWired: typeof wireSecretGetByNameCutover;
  listSecretVersionsWired: typeof wireSecretListVersionsCutover;
  bumpSecretLatestVersionFencedWired: typeof wireSecretBumpLatestVersionFencedCutover;
  getMetrics: () => SecretCutoverMetricsSnapshot;
  snapshot: () => SecretCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createSecretCutoverHooks(
  defaultOpts: SecretCutoverWiringOpts = {},
): SecretCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: SecretCutoverWiringOpts): SecretCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  const snapshot = (): SecretCutoverMetricsSnapshot => snapshotMeter(meter);
  return {
    listSecretsWired: (params, tsFallback, opts = {}) => wireOp(meter, "list",
      (c, o) => listSecretsWithCutover(c, params, tsFallback, o),
      tsFallback, merged(opts)),
    getSecretByIdWired: (params, tsFallback, opts = {}) => wireOp(meter, "get_by_id",
      (c, o) => getSecretByIdWithCutover(c, params, tsFallback, o),
      tsFallback, merged(opts)),
    getSecretByNameWired: (params, tsFallback, opts = {}) => wireOp(meter, "get_by_name",
      (c, o) => getSecretByNameWithCutover(c, params, tsFallback, o),
      tsFallback, merged(opts)),
    listSecretVersionsWired: (params, tsFallback, opts = {}) => wireOp(meter,
      "list_versions",
      (c, o) => listSecretVersionsWithCutover(c, params, tsFallback, o),
      tsFallback, merged(opts)),
    bumpSecretLatestVersionFencedWired: (params, tsFallback, opts = {}) => wireOp(
      meter, "bump_latest_version_fenced",
      (c, o) => bumpSecretLatestVersionFencedWithCutover(c, params, tsFallback, o),
      tsFallback, merged(opts)),
    getMetrics: snapshot,
    snapshot,
  };
}
