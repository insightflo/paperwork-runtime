// [파일 목적] Phase 2N Wave 5 — skill.* 컷오버(upsert/delete/list/get_by_id/
//   get_by_key) 배선 + 구조화 텔레메트리 계층. PAPERWORK_RUST_SKILL_CUTOVER=1
//   (기본 OFF)일 때만 엔진 클라이언트를 해석해 Wave 4 컷오버 어댑터(skill-cutover)
//   에 위임하고, 그 외에는 TS 작성자/리더를 그대로 호출한다. indeterminate 쓰기
//   오류는 절대 TS 폴백 없이 SkillCutoverIndeterminateError 로 전파한다.
// [외부 연결] skill-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createSkillCutoverHooks 로 env/getClient/timeoutMs/onEvent 를
//   한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  deleteSkillWithCutover, getSkillByIdWithCutover, getSkillByKeyWithCutover,
  isSkillEngineCutoverEnabled, listSkillsWithCutover, SkillCutoverIndeterminateError,
  upsertSkillWithCutover,
  type SkillCutoverCallOpts, type SkillCutoverOperation, type SkillCutoverResult,
} from "./skill-cutover.js";
import type {
  SkillDeleteParams, SkillDeleteResult, SkillGetByIdParams, SkillGetByKeyParams,
  SkillGetResult, SkillListParams, SkillRow, SkillUpsertParams, SkillUpsertResult,
} from "./paperwork-engine-skill.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { SkillCutoverIndeterminateError };
export type { SkillCutoverCallOpts, SkillCutoverOperation, SkillCutoverResult };

/** 텔레메트리가 다루는 skill.* 컷오버 대상 — RPC 메서드 접미사와 1:1 대응. */
export const SKILL_WIRED_OPERATIONS = [
  "upsert", "delete", "list", "get_by_id", "get_by_key",
] as const;
export type SkillWiredOperation = (typeof SKILL_WIRED_OPERATIONS)[number];

export type SkillCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface SkillCutoverTelemetryEvent {
  operation: SkillWiredOperation;
  outcome: SkillCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  error?: unknown;
}

export interface SkillCutoverOperationMetrics {
  rustOk: number;
  fallback: number;
  indeterminate: number;
  tsBypass: number;
  tsError: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type SkillCutoverMetricsSnapshot = Readonly<
  Record<SkillWiredOperation, Readonly<SkillCutoverOperationMetrics>>>;

export interface SkillCutoverWiringOpts extends SkillCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: SkillCutoverTelemetryEvent) => void;
}

type Meter = Record<SkillWiredOperation, SkillCutoverOperationMetrics>;

const emptyOperationMetrics = (): SkillCutoverOperationMetrics => ({
  rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0,
  tsError: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  SKILL_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): SkillCutoverMetricsSnapshot => Object.fromEntries(
  SKILL_WIRED_OPERATIONS.map((op) => [op, { ...meter[op] }])) as SkillCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: SkillWiredOperation;
  call: (
    client: PaperworkEngineClient, callOpts: SkillCutoverCallOpts,
  ) => Promise<SkillCutoverResult<T>>;
  tsFallback: () => Promise<T>;
  opts: SkillCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<SkillCutoverResult<T>> {
  const { operation, call, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: SkillCutoverOutcome, source: "rust" | "ts" | null,
    error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "skill cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "skill cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<SkillCutoverResult<T>> => {
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
  if (!isSkillEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ operation, err: error },
      "paperwork-engine client resolution failed; bypassing to TS");
    return runTsBypass();
  }
  if (client === null) {
    safeWarn({ operation }, "paperwork-engine client unavailable; bypassing to TS");
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
    if (error instanceof SkillCutoverIndeterminateError) {
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

type AdapterCall<P, T> = (
  client: PaperworkEngineClient, params: P,
  tsFallback: () => Promise<T>, callOpts: SkillCutoverCallOpts,
) => Promise<SkillCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<T>>;

function makeWiredOp<P, T>(
  operation: SkillWiredOperation, adapterCall: AdapterCall<P, T>,
  meter: Meter, defaults?: SkillCutoverWiringOpts,
): WiredOp<P, T> {
  return (params, tsFallback, opts = {}) => executeCutover({
    operation,
    call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
    tsFallback,
    opts: defaults ? { ...defaults, ...opts } : opts, meter,
  });
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getSkillCutoverMetrics(): SkillCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetSkillCutoverMetricsForTests(): void {
  for (const op of SKILL_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireUpsertSkillCutover =
  makeWiredOp("upsert", upsertSkillWithCutover, moduleMeter);
export const wireDeleteSkillCutover =
  makeWiredOp("delete", deleteSkillWithCutover, moduleMeter);
export const wireListSkillsCutover =
  makeWiredOp("list", listSkillsWithCutover, moduleMeter);
export const wireGetSkillByIdCutover =
  makeWiredOp("get_by_id", getSkillByIdWithCutover, moduleMeter);
export const wireGetSkillByKeyCutover =
  makeWiredOp("get_by_key", getSkillByKeyWithCutover, moduleMeter);

export interface SkillCutoverHooks {
  upsertSkill: (params: SkillUpsertParams, tsFallback: () => Promise<SkillUpsertResult>,
    opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<SkillUpsertResult>>;
  deleteSkill: (params: SkillDeleteParams, tsFallback: () => Promise<SkillDeleteResult>,
    opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<SkillDeleteResult>>;
  listSkills: (params: SkillListParams, tsFallback: () => Promise<SkillRow[]>,
    opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<SkillRow[]>>;
  getSkillById: (params: SkillGetByIdParams, tsFallback: () => Promise<SkillGetResult>,
    opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<SkillGetResult>>;
  getSkillByKey: (params: SkillGetByKeyParams, tsFallback: () => Promise<SkillGetResult>,
    opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<SkillGetResult>>;
  getMetrics: () => SkillCutoverMetricsSnapshot;
  snapshot: () => SkillCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createSkillCutoverHooks(
  defaultOpts: SkillCutoverWiringOpts = {},
): SkillCutoverHooks {
  const meter = emptyMeter();
  const snapshot = () => snapshotMeter(meter);
  return {
    upsertSkill: makeWiredOp("upsert", upsertSkillWithCutover, meter, defaultOpts),
    deleteSkill: makeWiredOp("delete", deleteSkillWithCutover, meter, defaultOpts),
    listSkills: makeWiredOp("list", listSkillsWithCutover, meter, defaultOpts),
    getSkillById: makeWiredOp("get_by_id", getSkillByIdWithCutover, meter, defaultOpts),
    getSkillByKey: makeWiredOp("get_by_key", getSkillByKeyWithCutover, meter, defaultOpts),
    getMetrics: snapshot,
    snapshot,
  };
}
