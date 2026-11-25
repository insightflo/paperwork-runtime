// [파일 목적] Phase 2J Wave 5 — tool.* 컷오버 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_TOOL_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해 컷오버
//   어댑터(tool-cutover)에 위임하고, 그 외에는 TS 경로를 그대로 호출한다. 쓰기의
//   indeterminate 는 절대 TS 폴백 없이 전파하고, claim replay(outcome:"replay")는
//   fenceMismatch 로 집계만 하며 폴백하지 않는다(엔진이 이미 receipt 를 가진 멱등
//   재생 성공 — {applied:false} union 이 없는 tool.* 의 not-newly-applied 아날로그).
// [외부 연결] tool-cutover(어댑터), paperwork-engine-tool(타입),
//   paperwork-engine-runtime(공유 클라이언트), logger. 호출부는
//   createToolCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  claimToolExecutionReceiptIdempotentWithCutover,
  getToolDefinitionWithCutover,
  isToolEngineCutoverEnabled,
  listCompanySkillsWithCutover,
  listToolDefinitionsWithCutover,
  listToolExecutionReceiptsWithCutover,
  ToolCutoverIndeterminateError,
  type ToolCutoverCallOpts,
  type ToolCutoverResult,
} from "./tool-cutover.js";
import type {
  ToolClaimExecutionReceiptIdempotentParams, ToolClaimExecutionReceiptIdempotentResult,
  ToolGetDefinitionParams, ToolGetDefinitionResult, ToolListDefinitionsParams,
  ToolListDefinitionsResult, ToolListExecutionReceiptsParams, ToolListExecutionReceiptsResult,
  ToolListSkillsParams, ToolListSkillsResult,
} from "./paperwork-engine-tool.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { ToolCutoverIndeterminateError };
export type { ToolCutoverCallOpts, ToolCutoverResult };

/** 텔레메트리가 다루는 tool.* 컷오버 대상 — RPC 메서드 접미사와 1:1 대응. */
export const TOOL_WIRED_OPERATIONS = [
  "claim_execution_receipt_idempotent", "list_definitions", "get_definition",
  "list_skills", "list_execution_receipts",
] as const;
export type ToolWiredOperation = (typeof TOOL_WIRED_OPERATIONS)[number];

export type ToolCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface ToolCutoverTelemetryEvent {
  operation: ToolWiredOperation;
  outcome: ToolCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface ToolCutoverOperationMetrics {
  rustOk: number; fallback: number; indeterminate: number;
  tsBypass: number; tsError: number; fenceMismatch: number;
  totalCalls: number; totalDurationMs: number;
}

export type ToolCutoverMetricsSnapshot = Readonly<
  Record<ToolWiredOperation, Readonly<ToolCutoverOperationMetrics>>>;

export interface ToolCutoverWiringOpts extends ToolCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: ToolCutoverTelemetryEvent) => void;
}

type Meter = Record<ToolWiredOperation, ToolCutoverOperationMetrics>;

const emptyOperationMetrics = (): ToolCutoverOperationMetrics => ({
  rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  TOOL_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): ToolCutoverMetricsSnapshot =>
  Object.fromEntries(TOOL_WIRED_OPERATIONS.map(
    (op) => [op, { ...meter[op] }])) as ToolCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

const neverFenceMismatch = (): boolean => false;
const replayOutcome = (v: { outcome: string }): boolean => v.outcome === "replay";

interface CutoverJob<T> {
  operation: ToolWiredOperation;
  call: (c: PaperworkEngineClient, o: ToolCutoverCallOpts) => Promise<ToolCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: ToolCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<ToolCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: ToolCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "tool cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "tool cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<ToolCutoverResult<T>> => {
    metrics.tsBypass += 1;
    try {
      const value = await tsFallback();
      const fenceMismatch = isFenceMismatch(value);
      if (fenceMismatch) metrics.fenceMismatch += 1;
      emit("ts_bypass", "ts", fenceMismatch);
      return { source: "ts", value };
    } catch (error) {
      metrics.tsError += 1;
      emit("ts_error", "ts", false, error);
      throw error;
    }
  };

  const env = opts.env ?? process.env;
  if (!isToolEngineCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
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
    const fenceMismatch = isFenceMismatch(result.value);
    if (fenceMismatch) metrics.fenceMismatch += 1;
    if (result.source === "rust") {
      metrics.rustOk += 1;
      emit("rust_ok", "rust", fenceMismatch);
    } else {
      metrics.fallback += 1;
      emit("fallback", "ts", fenceMismatch);
    }
    return result;
  } catch (error) {
    if (error instanceof ToolCutoverIndeterminateError) {
      metrics.indeterminate += 1;
      emit("indeterminate", null, false, error);
    } else {
      // 어댑터가 던지는 비-indeterminate 오류는 tsFallback 자체의 실패다.
      metrics.tsError += 1;
      emit("ts_error", null, false, error);
    }
    throw error;
  }
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getToolCutoverMetrics(): ToolCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetToolCutoverMetricsForTests(): void {
  for (const op of TOOL_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

function wireOp<T>(meter: Meter, operation: ToolWiredOperation,
  call: CutoverJob<T>["call"], isFenceMismatch: (value: T) => boolean,
  tsFallback: () => Promise<T>, opts: ToolCutoverWiringOpts,
): Promise<ToolCutoverResult<T>> {
  return executeCutover({ operation, call, isFenceMismatch, tsFallback, opts, meter });
}

export function wireToolClaimExecutionReceiptIdempotentCutover(
  params: ToolClaimExecutionReceiptIdempotentParams,
  tsFallback: () => Promise<ToolClaimExecutionReceiptIdempotentResult>,
  opts: ToolCutoverWiringOpts = {}): Promise<ToolCutoverResult<ToolClaimExecutionReceiptIdempotentResult>> {
  return wireOp(moduleMeter, "claim_execution_receipt_idempotent",
    (c, o) => claimToolExecutionReceiptIdempotentWithCutover(c, params, tsFallback, o),
    replayOutcome, tsFallback, opts);
}

export function wireToolListDefinitionsCutover(
  params: ToolListDefinitionsParams,
  tsFallback: () => Promise<ToolListDefinitionsResult>,
  opts: ToolCutoverWiringOpts = {}): Promise<ToolCutoverResult<ToolListDefinitionsResult>> {
  return wireOp(moduleMeter, "list_definitions",
    (c, o) => listToolDefinitionsWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export function wireToolGetDefinitionCutover(
  params: ToolGetDefinitionParams,
  tsFallback: () => Promise<ToolGetDefinitionResult>,
  opts: ToolCutoverWiringOpts = {}): Promise<ToolCutoverResult<ToolGetDefinitionResult>> {
  return wireOp(moduleMeter, "get_definition",
    (c, o) => getToolDefinitionWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export function wireToolListSkillsCutover(
  params: ToolListSkillsParams,
  tsFallback: () => Promise<ToolListSkillsResult>,
  opts: ToolCutoverWiringOpts = {}): Promise<ToolCutoverResult<ToolListSkillsResult>> {
  return wireOp(moduleMeter, "list_skills",
    (c, o) => listCompanySkillsWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export function wireToolListExecutionReceiptsCutover(
  params: ToolListExecutionReceiptsParams,
  tsFallback: () => Promise<ToolListExecutionReceiptsResult>,
  opts: ToolCutoverWiringOpts = {}): Promise<ToolCutoverResult<ToolListExecutionReceiptsResult>> {
  return wireOp(moduleMeter, "list_execution_receipts",
    (c, o) => listToolExecutionReceiptsWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export interface ToolCutoverHooks {
  claimExecutionReceiptIdempotent: typeof wireToolClaimExecutionReceiptIdempotentCutover;
  listDefinitions: typeof wireToolListDefinitionsCutover;
  getDefinition: typeof wireToolGetDefinitionCutover;
  listSkills: typeof wireToolListSkillsCutover;
  listExecutionReceipts: typeof wireToolListExecutionReceiptsCutover;
  getMetrics: () => ToolCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createToolCutoverHooks(
  defaultOpts: ToolCutoverWiringOpts = {},
): ToolCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: ToolCutoverWiringOpts): ToolCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  return {
    claimExecutionReceiptIdempotent: (params, tsFallback, opts = {}) => wireOp(meter,
      "claim_execution_receipt_idempotent",
      (c, o) => claimToolExecutionReceiptIdempotentWithCutover(c, params, tsFallback, o),
      replayOutcome, tsFallback, merged(opts)),
    listDefinitions: (params, tsFallback, opts = {}) => wireOp(meter, "list_definitions",
      (c, o) => listToolDefinitionsWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    getDefinition: (params, tsFallback, opts = {}) => wireOp(meter, "get_definition",
      (c, o) => getToolDefinitionWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    listSkills: (params, tsFallback, opts = {}) => wireOp(meter, "list_skills",
      (c, o) => listCompanySkillsWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    listExecutionReceipts: (params, tsFallback, opts = {}) => wireOp(meter,
      "list_execution_receipts",
      (c, o) => listToolExecutionReceiptsWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    getMetrics: () => snapshotMeter(meter),
  };
}
