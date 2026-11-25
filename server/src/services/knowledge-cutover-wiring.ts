// [파일 목적] Phase 2H Wave 5 — knowledge.* 컷오버 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_KNOWLEDGE_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해 컷오버
//   어댑터(knowledge-cutover)에 위임하고, 그 외에는 TS 경로를 그대로 호출한다. 쓰기의
//   indeterminate 는 절대 TS 폴백 없이 전파하고, fence mismatch({applied:false})는
//   성공 결과로 집계만 하며 폴백하지 않는다.
// [외부 연결] knowledge-cutover(어댑터), paperwork-engine-knowledge(타입),
//   paperwork-engine-runtime(공유 클라이언트), logger. 호출부는
//   createKnowledgeCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  getKnowledgeNodeWithCutover,
  isKnowledgeEngineCutoverEnabled,
  KnowledgeCutoverIndeterminateError,
  listAgentKbGrantsWithCutover,
  listKnowledgeBasesWithCutover,
  listKnowledgeNodesWithCutover,
  updateKnowledgeNodeFencedWithCutover,
  type KnowledgeCutoverCallOpts,
  type KnowledgeCutoverResult,
} from "./knowledge-cutover.js";
import type {
  KnowledgeGetNodeParams, KnowledgeGetNodeResult, KnowledgeListAgentGrantsParams,
  KnowledgeListAgentGrantsResult, KnowledgeListBasesParams, KnowledgeListBasesResult,
  KnowledgeListNodesParams, KnowledgeListNodesResult, KnowledgeUpdateNodeFencedParams,
  KnowledgeUpdateNodeFencedResult,
} from "./paperwork-engine-knowledge.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { KnowledgeCutoverIndeterminateError };
export type { KnowledgeCutoverCallOpts, KnowledgeCutoverResult };

/** 텔레메트리가 다루는 knowledge.* 컷오버 대상 — RPC 메서드 접미사와 1:1 대응. */
export const KNOWLEDGE_WIRED_OPERATIONS = [
  "update_node_fenced", "list_bases", "get_node", "list_nodes", "list_agent_grants",
] as const;
export type KnowledgeWiredOperation = (typeof KNOWLEDGE_WIRED_OPERATIONS)[number];

export type KnowledgeCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface KnowledgeCutoverTelemetryEvent {
  operation: KnowledgeWiredOperation;
  outcome: KnowledgeCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface KnowledgeCutoverOperationMetrics {
  rustOk: number; fallback: number; indeterminate: number;
  tsBypass: number; tsError: number; fenceMismatch: number;
  totalCalls: number; totalDurationMs: number;
}

export type KnowledgeCutoverMetricsSnapshot = Readonly<
  Record<KnowledgeWiredOperation, Readonly<KnowledgeCutoverOperationMetrics>>>;

export interface KnowledgeCutoverWiringOpts extends KnowledgeCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: KnowledgeCutoverTelemetryEvent) => void;
}

type Meter = Record<KnowledgeWiredOperation, KnowledgeCutoverOperationMetrics>;

const emptyOperationMetrics = (): KnowledgeCutoverOperationMetrics => ({
  rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  KNOWLEDGE_WIRED_OPERATIONS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): KnowledgeCutoverMetricsSnapshot =>
  Object.fromEntries(KNOWLEDGE_WIRED_OPERATIONS.map(
    (op) => [op, { ...meter[op] }])) as KnowledgeCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

const neverFenceMismatch = (): boolean => false;
const appliedFalse = (v: { applied: boolean }): boolean => v.applied === false;

interface CutoverJob<T> {
  operation: KnowledgeWiredOperation;
  call: (c: PaperworkEngineClient, o: KnowledgeCutoverCallOpts) => Promise<KnowledgeCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: KnowledgeCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<KnowledgeCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: KnowledgeCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "knowledge cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "knowledge cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<KnowledgeCutoverResult<T>> => {
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
  if (!isKnowledgeEngineCutoverEnabled(env)) return runTsBypass();

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
    if (error instanceof KnowledgeCutoverIndeterminateError) {
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
export function getKnowledgeCutoverMetrics(): KnowledgeCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetKnowledgeCutoverMetricsForTests(): void {
  for (const op of KNOWLEDGE_WIRED_OPERATIONS) moduleMeter[op] = emptyOperationMetrics();
}

function wireOp<T>(meter: Meter, operation: KnowledgeWiredOperation,
  call: CutoverJob<T>["call"], isFenceMismatch: (value: T) => boolean,
  tsFallback: () => Promise<T>, opts: KnowledgeCutoverWiringOpts,
): Promise<KnowledgeCutoverResult<T>> {
  return executeCutover({ operation, call, isFenceMismatch, tsFallback, opts, meter });
}

export function wireKnowledgeUpdateNodeFencedCutover(
  params: KnowledgeUpdateNodeFencedParams,
  tsFallback: () => Promise<KnowledgeUpdateNodeFencedResult>,
  opts: KnowledgeCutoverWiringOpts = {}): Promise<KnowledgeCutoverResult<KnowledgeUpdateNodeFencedResult>> {
  return wireOp(moduleMeter, "update_node_fenced",
    (c, o) => updateKnowledgeNodeFencedWithCutover(c, params, tsFallback, o),
    appliedFalse, tsFallback, opts);
}

export function wireKnowledgeListBasesCutover(
  params: KnowledgeListBasesParams,
  tsFallback: () => Promise<KnowledgeListBasesResult>,
  opts: KnowledgeCutoverWiringOpts = {}): Promise<KnowledgeCutoverResult<KnowledgeListBasesResult>> {
  return wireOp(moduleMeter, "list_bases",
    (c, o) => listKnowledgeBasesWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export function wireKnowledgeGetNodeCutover(
  params: KnowledgeGetNodeParams,
  tsFallback: () => Promise<KnowledgeGetNodeResult>,
  opts: KnowledgeCutoverWiringOpts = {}): Promise<KnowledgeCutoverResult<KnowledgeGetNodeResult>> {
  return wireOp(moduleMeter, "get_node",
    (c, o) => getKnowledgeNodeWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export function wireKnowledgeListNodesCutover(
  params: KnowledgeListNodesParams,
  tsFallback: () => Promise<KnowledgeListNodesResult>,
  opts: KnowledgeCutoverWiringOpts = {}): Promise<KnowledgeCutoverResult<KnowledgeListNodesResult>> {
  return wireOp(moduleMeter, "list_nodes",
    (c, o) => listKnowledgeNodesWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export function wireKnowledgeListAgentGrantsCutover(
  params: KnowledgeListAgentGrantsParams,
  tsFallback: () => Promise<KnowledgeListAgentGrantsResult>,
  opts: KnowledgeCutoverWiringOpts = {}): Promise<KnowledgeCutoverResult<KnowledgeListAgentGrantsResult>> {
  return wireOp(moduleMeter, "list_agent_grants",
    (c, o) => listAgentKbGrantsWithCutover(c, params, tsFallback, o),
    neverFenceMismatch, tsFallback, opts);
}

export interface KnowledgeCutoverHooks {
  updateNodeFenced: typeof wireKnowledgeUpdateNodeFencedCutover;
  listBases: typeof wireKnowledgeListBasesCutover;
  getNode: typeof wireKnowledgeGetNodeCutover;
  listNodes: typeof wireKnowledgeListNodesCutover;
  listAgentGrants: typeof wireKnowledgeListAgentGrantsCutover;
  getMetrics: () => KnowledgeCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createKnowledgeCutoverHooks(
  defaultOpts: KnowledgeCutoverWiringOpts = {},
): KnowledgeCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: KnowledgeCutoverWiringOpts): KnowledgeCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  return {
    updateNodeFenced: (params, tsFallback, opts = {}) => wireOp(meter,
      "update_node_fenced",
      (c, o) => updateKnowledgeNodeFencedWithCutover(c, params, tsFallback, o),
      appliedFalse, tsFallback, merged(opts)),
    listBases: (params, tsFallback, opts = {}) => wireOp(meter, "list_bases",
      (c, o) => listKnowledgeBasesWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    getNode: (params, tsFallback, opts = {}) => wireOp(meter, "get_node",
      (c, o) => getKnowledgeNodeWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    listNodes: (params, tsFallback, opts = {}) => wireOp(meter, "list_nodes",
      (c, o) => listKnowledgeNodesWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    listAgentGrants: (params, tsFallback, opts = {}) => wireOp(meter, "list_agent_grants",
      (c, o) => listAgentKbGrantsWithCutover(c, params, tsFallback, o),
      neverFenceMismatch, tsFallback, merged(opts)),
    getMetrics: () => snapshotMeter(meter),
  };
}
