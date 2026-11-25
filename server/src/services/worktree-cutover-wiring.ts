// [파일 목적] Wave 5 — worktree.* 컷오버(create/update/toggle/delete/list/get_by_id)
//   배선 + 구조화 텔레메트리 계층. PAPERWORK_RUST_WORKTREE_CUTOVER=1(기본 OFF)일
//   때만 공유 엔진 클라이언트를 지연 해석해 컷오버 어댑터(worktree-cutover)에 위임하고,
//   그 외에는 TS 작성자/리더를 그대로 호출한다. indeterminate 쓰기 오류는 절대 TS
//   폴백 없이 WorktreeCutoverIndeterminateError 로 전파하고, fence/not-applied 결과
//   (updated/deleted:false)는 폴백 없이 그대로 반환한다.
// [외부 연결] worktree-cutover(어댑터), paperwork-engine-runtime(공유 클라이언트),
//   logger. 호출부는 createWorktreeCutoverHooks 로 env/getClient/timeoutMs/onEvent 를
//   한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  WorktreeCutoverIndeterminateError, createWorktreeRuleWithCutover,
  deleteWorktreeRuleWithCutover, getWorktreeRuleByIdWithCutover,
  isWorktreeEngineCutoverEnabled, listWorktreeRulesWithCutover,
  toggleWorktreeRuleEnabledWithCutover, updateWorktreeRuleWithCutover,
  type WorktreeCutoverCallOpts, type WorktreeCutoverOperation, type WorktreeCutoverResult,
} from "./worktree-cutover.js";
import type {
  WorktreeCreateParams, WorktreeCreateResult, WorktreeDeleteParams,
  WorktreeDeleteResult, WorktreeGetByIdParams, WorktreeGetResult,
  WorktreeListParams, WorktreeListResult, WorktreeToggleEnabledParams,
  WorktreeUpdateParams, WorktreeUpdateResult,
} from "./paperwork-engine-worktree.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { WorktreeCutoverIndeterminateError };
export type { WorktreeCutoverOperation, WorktreeCutoverResult };

/** 텔레메트리가 다루는 컷오버 대상 — 어댑터의 쓰기 4종 + 읽기 2종 전부. */
export type WorktreeWiredOperation =
  WorktreeCutoverOperation | "list_worktree_rules" | "get_worktree_rule_by_id";

export type WorktreeCutoverOutcome =
  | "rust_success" | "ts_bypass" | "ts_fallback" | "indeterminate_error" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface WorktreeCutoverTelemetryEvent {
  operation: WorktreeWiredOperation;
  outcome: WorktreeCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  fenceMismatch: boolean;
  error?: unknown;
}

export interface WorktreeCutoverOperationMetrics {
  rustSuccess: number;
  tsBypass: number;
  tsFallback: number;
  indeterminateError: number;
  tsError: number;
  fenceMismatch: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type WorktreeCutoverMetricsSnapshot = Readonly<
  Record<WorktreeWiredOperation, Readonly<WorktreeCutoverOperationMetrics>>>;

export interface WorktreeCutoverWiringOpts extends WorktreeCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: WorktreeCutoverTelemetryEvent) => void;
}

type Meter = Record<WorktreeWiredOperation, WorktreeCutoverOperationMetrics>;

const WIRED_OPS = [
  "create_worktree_rule", "update_worktree_rule", "toggle_worktree_rule_enabled",
  "delete_worktree_rule", "list_worktree_rules", "get_worktree_rule_by_id",
] as const satisfies readonly WorktreeWiredOperation[];

const emptyOperationMetrics = (): WorktreeCutoverOperationMetrics => ({
  rustSuccess: 0, tsBypass: 0, tsFallback: 0, indeterminateError: 0,
  tsError: 0, fenceMismatch: 0, totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => Object.fromEntries(
  WIRED_OPS.map((op) => [op, emptyOperationMetrics()])) as Meter;
const snapshotMeter = (meter: Meter): WorktreeCutoverMetricsSnapshot => Object.fromEntries(
  WIRED_OPS.map((op) => [op, { ...meter[op] }])) as WorktreeCutoverMetricsSnapshot;

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob<T> {
  operation: WorktreeWiredOperation;
  call: (client: PaperworkEngineClient, callOpts: WorktreeCutoverCallOpts) => Promise<WorktreeCutoverResult<T>>;
  isFenceMismatch: (value: T) => boolean;
  tsFallback: () => Promise<T>;
  opts: WorktreeCutoverWiringOpts;
  meter: Meter;
}

async function executeCutover<T>(job: CutoverJob<T>): Promise<WorktreeCutoverResult<T>> {
  const { operation, call, isFenceMismatch, tsFallback, opts, meter } = job;
  const metrics = meter[operation];
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: WorktreeCutoverOutcome, source: "rust" | "ts" | null,
    fenceMismatch: boolean, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation, outcome, source, durationMs, fenceMismatch, error }))
        .catch((observerError) => safeWarn({ operation, err: observerError },
          "worktree cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation, err: observerError },
        "worktree cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 경로를 호출한다.
  // tsFallback 이 던지면 tsError 로 집계 후 그대로 rethrow.
  const runTsBypass = async (): Promise<WorktreeCutoverResult<T>> => {
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
  if (!isWorktreeEngineCutoverEnabled(env)) return runTsBypass();

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
    const fenceMismatch = isFenceMismatch(result.value);
    if (fenceMismatch) metrics.fenceMismatch += 1;
    if (result.source === "rust") {
      metrics.rustSuccess += 1;
      emit("rust_success", "rust", fenceMismatch);
    } else {
      metrics.tsFallback += 1;
      emit("ts_fallback", "ts", fenceMismatch);
    }
    return result;
  } catch (error) {
    if (error instanceof WorktreeCutoverIndeterminateError) {
      metrics.indeterminateError += 1;
      emit("indeterminate_error", null, false, error);
    } else {
      // 어댑터가 던지는 비-indeterminate 오류는 tsFallback 자체의 실패다.
      metrics.tsError += 1;
      emit("ts_error", null, false, error);
    }
    throw error;
  }
}

type AdapterCall<P, T> = (
  client: PaperworkEngineClient, params: P,
  tsFallback: () => Promise<T>, callOpts: WorktreeCutoverCallOpts,
) => Promise<WorktreeCutoverResult<T>>;
type WiredOp<P, T> = (params: P, tsFallback: () => Promise<T>,
  opts?: WorktreeCutoverWiringOpts) => Promise<WorktreeCutoverResult<T>>;

/** 엔진 fence/not-applied 결과 — 폴백 없이 반환하되 텔레메트리엔 fenceMismatch 로 집계. */
const updateNotApplied = (v: WorktreeUpdateResult) => v.updated === false;
const deleteNotApplied = (v: WorktreeDeleteResult) => v.deleted === false;
const neverNotApplied = () => false;

function makeWiredOp<P, T>(
  operation: WorktreeWiredOperation, adapterCall: AdapterCall<P, T>,
  isFenceMismatch: (value: T) => boolean, meter: Meter, defaults?: WorktreeCutoverWiringOpts,
): WiredOp<P, T> {
  return (params, tsFallback, opts = {}) => executeCutover({
    operation,
    call: (client, callOpts) => adapterCall(client, params, tsFallback, callOpts),
    isFenceMismatch, tsFallback,
    opts: defaults ? { ...defaults, ...opts } : opts, meter,
  });
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getWorktreeCutoverMetrics(): WorktreeCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetWorktreeCutoverMetricsForTests(): void {
  for (const op of WIRED_OPS) moduleMeter[op] = emptyOperationMetrics();
}

export const wireCreateWorktreeRuleCutover =
  makeWiredOp("create_worktree_rule", createWorktreeRuleWithCutover, neverNotApplied, moduleMeter);
export const wireUpdateWorktreeRuleCutover =
  makeWiredOp("update_worktree_rule", updateWorktreeRuleWithCutover, updateNotApplied, moduleMeter);
export const wireToggleWorktreeRuleEnabledCutover =
  makeWiredOp("toggle_worktree_rule_enabled", toggleWorktreeRuleEnabledWithCutover, updateNotApplied, moduleMeter);
export const wireDeleteWorktreeRuleCutover =
  makeWiredOp("delete_worktree_rule", deleteWorktreeRuleWithCutover, deleteNotApplied, moduleMeter);
export const wireListWorktreeRulesCutover =
  makeWiredOp("list_worktree_rules", listWorktreeRulesWithCutover, neverNotApplied, moduleMeter);
export const wireGetWorktreeRuleByIdCutover =
  makeWiredOp("get_worktree_rule_by_id", getWorktreeRuleByIdWithCutover, neverNotApplied, moduleMeter);

export interface WorktreeCutoverHooks {
  createWorktreeRule: typeof wireCreateWorktreeRuleCutover;
  updateWorktreeRule: typeof wireUpdateWorktreeRuleCutover;
  toggleWorktreeRuleEnabled: typeof wireToggleWorktreeRuleEnabledCutover;
  deleteWorktreeRule: typeof wireDeleteWorktreeRuleCutover;
  listWorktreeRules: typeof wireListWorktreeRulesCutover;
  getWorktreeRuleById: typeof wireGetWorktreeRuleByIdCutover;
  getMetrics: () => WorktreeCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createWorktreeCutoverHooks(defaultOpts: WorktreeCutoverWiringOpts = {}): WorktreeCutoverHooks {
  const meter = emptyMeter();
  return {
    createWorktreeRule: makeWiredOp("create_worktree_rule", createWorktreeRuleWithCutover, neverNotApplied, meter, defaultOpts),
    updateWorktreeRule: makeWiredOp("update_worktree_rule", updateWorktreeRuleWithCutover, updateNotApplied, meter, defaultOpts),
    toggleWorktreeRuleEnabled: makeWiredOp("toggle_worktree_rule_enabled", toggleWorktreeRuleEnabledWithCutover, updateNotApplied, meter, defaultOpts),
    deleteWorktreeRule: makeWiredOp("delete_worktree_rule", deleteWorktreeRuleWithCutover, deleteNotApplied, meter, defaultOpts),
    listWorktreeRules: makeWiredOp("list_worktree_rules", listWorktreeRulesWithCutover, neverNotApplied, meter, defaultOpts),
    getWorktreeRuleById: makeWiredOp("get_worktree_rule_by_id", getWorktreeRuleByIdWithCutover, neverNotApplied, meter, defaultOpts),
    getMetrics: () => snapshotMeter(meter),
  };
}
