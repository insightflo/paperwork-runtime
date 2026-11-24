// [파일 목적] Wave 5c — paperwork-engine heartbeat 쓰기(claim_wakeup / transition_run_fenced)
//   실트래픽 컷오버 배선 모듈. PAPERWORK_ENGINE_HEARTBEAT_CUTOVER=1(기본 OFF)일 때만
//   Rust 엔진을 시도하고, 구조화 텔레메트리(성공·폴백·사유별 카운터), 엄격한 입력 검증,
//   트랜잭션 경계 보존, indeterminate 무폴백(fail-closed) 전파, 그리고 heartbeat.ts /
//   heartbeat-queue-lifecycle.ts 에 2줄로 꽂을 수 있는 타입 안전 훅 어댑터를 제공한다.
// [외부 연결] paperwork-engine-heartbeat-cutover.ts, paperwork-engine-runtime.ts, logger.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  HEARTBEAT_RUN_STATUSES, type HeartbeatClaimWakeupParams, type HeartbeatClaimedWakeup,
  type HeartbeatRunStatus, type HeartbeatTransitionRunFencedResult,
} from "./paperwork-engine-heartbeat.js";
import {
  HEARTBEAT_CUTOVER_WRITE_TIMEOUT_MS, HeartbeatCutoverIndeterminateError,
  claimWakeupWithCutover, hasExpectedRunIdentityFence, hasExtraPatchFields,
  isHeartbeatEngineCutoverEnabled, transitionRunFencedWithCutover,
  type HeartbeatCutoverCallOpts, type HeartbeatCutoverOperation,
  type HeartbeatCutoverResult, type HeartbeatTransitionRunFencedCutoverParams,
} from "./paperwork-engine-heartbeat-cutover.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export const HEARTBEAT_CUTOVER_MAX_WRITE_TIMEOUT_MS = 600_000;

export type HeartbeatCutoverFallbackReason =
  | "flag_off" | "in_transaction" | "client_unavailable"
  | "client_init_error" | "ineligible_input" | "rpc_not_committed";

export type HeartbeatCutoverOutcomeReason =
  | "rust_ok" | HeartbeatCutoverFallbackReason | "indeterminate";

export interface HeartbeatCutoverOperationMetrics {
  rustHits: number; tsFallbacks: number; indeterminateErrors: number;
}

export interface HeartbeatCutoverTelemetrySnapshot {
  rustHits: number; tsFallbacks: number; indeterminateErrors: number;
  byOperation: Record<HeartbeatCutoverOperation, HeartbeatCutoverOperationMetrics>;
  byReason: Record<HeartbeatCutoverOutcomeReason, number>;
}
export interface HeartbeatCutoverWiringOpts extends HeartbeatCutoverCallOpts {
  /** True when caller already holds a PG transaction; routes to TS to preserve atomicity. */
  inTransaction?: boolean;
}
export interface HeartbeatCutoverWiringDeps {
  getClient?: () => PaperworkEngineClient | null;
  defaultEnv?: { PAPERWORK_ENGINE_HEARTBEAT_CUTOVER?: string };
}

const STATUS_SET: ReadonlySet<string> = new Set(HEARTBEAT_RUN_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGAL_NEXT: Readonly<Record<HeartbeatRunStatus, ReadonlySet<HeartbeatRunStatus>>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["succeeded", "failed", "cancelled", "timed_out"]),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), timed_out: new Set(),
};

const isUuid = (v: string): boolean => UUID_RE.test(v);
const isStatus = (v: unknown): v is HeartbeatRunStatus => typeof v === "string" && STATUS_SET.has(v);

function assertNonEmptyId(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`${field} must be a non-empty string`);
  }
}

function assertBoundedTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)
    || timeoutMs < HEARTBEAT_CUTOVER_WRITE_TIMEOUT_MS
    || timeoutMs > HEARTBEAT_CUTOVER_MAX_WRITE_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs must be an integer in [${HEARTBEAT_CUTOVER_WRITE_TIMEOUT_MS}, ${HEARTBEAT_CUTOVER_MAX_WRITE_TIMEOUT_MS}]`,
    );
  }
}

function validateClaimParams(params: HeartbeatClaimWakeupParams, opts: HeartbeatCutoverWiringOpts): void {
  assertNonEmptyId(params.company_id, "company_id");
  assertNonEmptyId(params.agent_id, "agent_id");
  assertBoundedTimeout(opts.timeoutMs);
}

function validateTransitionParams(
  params: HeartbeatTransitionRunFencedCutoverParams,
  opts: HeartbeatCutoverWiringOpts,
): void {
  assertNonEmptyId(params.run_id, "run_id");
  assertNonEmptyId(params.company_id, "company_id");
  if (!isStatus(params.next_status)) throw new RangeError("next_status must be a valid heartbeat run status");
  if (!Array.isArray(params.expected_statuses)) {
    throw new RangeError("expected_statuses must be an array of heartbeat run statuses");
  }
  for (let i = 0; i < params.expected_statuses.length; i++) {
    if (!isStatus(params.expected_statuses[i])) {
      throw new RangeError(`expected_statuses[${i}] must be a valid heartbeat run status`);
    }
  }
  if (params.error !== undefined && typeof params.error !== "string") throw new RangeError("error must be a string");
  if (params.error_code !== undefined && typeof params.error_code !== "string") throw new RangeError("error_code must be a string");
  assertBoundedTimeout(opts.timeoutMs);
}

function isTransitionEngineEligible(params: HeartbeatTransitionRunFencedCutoverParams): boolean {
  if (hasExpectedRunIdentityFence(params) || hasExtraPatchFields(params)) return false;
  if (!isUuid(params.run_id) || !isUuid(params.company_id) || params.expected_statuses.length === 0) return false;
  for (let i = 0; i < params.expected_statuses.length; i++) {
    if (!LEGAL_NEXT[params.expected_statuses[i]].has(params.next_status)) return false;
  }
  return true;
}

function emptyTelemetry(): HeartbeatCutoverTelemetrySnapshot {
  return {
    rustHits: 0, tsFallbacks: 0, indeterminateErrors: 0,
    byOperation: {
      claim_wakeup: { rustHits: 0, tsFallbacks: 0, indeterminateErrors: 0 },
      transition_run_fenced: { rustHits: 0, tsFallbacks: 0, indeterminateErrors: 0 },
    },
    byReason: {
      rust_ok: 0, flag_off: 0, in_transaction: 0, client_unavailable: 0,
      client_init_error: 0, ineligible_input: 0, rpc_not_committed: 0, indeterminate: 0,
    },
  };
}

export function createHeartbeatCutoverWiring(deps: HeartbeatCutoverWiringDeps = {}) {
  const resolveClient = deps.getClient ?? (() => getSharedPaperworkEngineClient());
  let telemetry = emptyTelemetry();

  const recordRust = (op: HeartbeatCutoverOperation): void => {
    telemetry.rustHits += 1; telemetry.byOperation[op].rustHits += 1; telemetry.byReason.rust_ok += 1;
  };
  const recordFallback = (op: HeartbeatCutoverOperation, reason: HeartbeatCutoverFallbackReason): void => {
    telemetry.tsFallbacks += 1; telemetry.byOperation[op].tsFallbacks += 1; telemetry.byReason[reason] += 1;
  };
  const recordIndeterminate = (op: HeartbeatCutoverOperation): void => {
    telemetry.indeterminateErrors += 1; telemetry.byOperation[op].indeterminateErrors += 1;
    telemetry.byReason.indeterminate += 1;
  };

  function acquireClient(
    op: HeartbeatCutoverOperation,
    opts: HeartbeatCutoverWiringOpts,
    eligible: boolean,
  ): { client: PaperworkEngineClient } | { fallbackReason: HeartbeatCutoverFallbackReason } {
    const env = opts.env ?? deps.defaultEnv ?? process.env;
    if (!isHeartbeatEngineCutoverEnabled(env)) return { fallbackReason: "flag_off" };
    if (opts.inTransaction) return { fallbackReason: "in_transaction" };
    if (!eligible) return { fallbackReason: "ineligible_input" };
    try {
      const client = resolveClient();
      return client ? { client } : { fallbackReason: "client_unavailable" };
    } catch (error) {
      logger.warn({ operation: op, err: error }, "failed to acquire paperwork-engine client; falling back to TS");
      return { fallbackReason: "client_init_error" };
    }
  }

  async function executeCutover<T>(
    op: HeartbeatCutoverOperation,
    opts: HeartbeatCutoverWiringOpts,
    eligible: boolean,
    runWithClient: (client: PaperworkEngineClient, callOpts: HeartbeatCutoverCallOpts) => Promise<HeartbeatCutoverResult<T>>,
    tsFallback: () => Promise<T>,
  ): Promise<HeartbeatCutoverResult<T>> {
    const acquired = acquireClient(op, opts, eligible);
    if ("fallbackReason" in acquired) {
      recordFallback(op, acquired.fallbackReason);
      return { source: "ts", value: await tsFallback() };
    }
    const callOpts: HeartbeatCutoverCallOpts = {
      timeoutMs: opts.timeoutMs, env: opts.env ?? deps.defaultEnv ?? process.env,
    };
    try {
      const result = await runWithClient(acquired.client, callOpts);
      if (result.source === "rust") recordRust(op);
      else recordFallback(op, "rpc_not_committed");
      return result;
    } catch (error) {
      if (error instanceof HeartbeatCutoverIndeterminateError) recordIndeterminate(op);
      throw error;
    }
  }

  async function claimWakeup(
    params: HeartbeatClaimWakeupParams,
    tsFallback: () => Promise<HeartbeatClaimedWakeup | null>,
    opts: HeartbeatCutoverWiringOpts = {},
  ): Promise<HeartbeatCutoverResult<HeartbeatClaimedWakeup | null>> {
    validateClaimParams(params, opts);
    return executeCutover(
      "claim_wakeup", opts, isUuid(params.company_id) && isUuid(params.agent_id),
      (client, callOpts) => claimWakeupWithCutover(client, params, tsFallback, callOpts), tsFallback,
    );
  }

  async function transitionRunFenced(
    params: HeartbeatTransitionRunFencedCutoverParams,
    tsFallback: () => Promise<HeartbeatTransitionRunFencedResult>,
    opts: HeartbeatCutoverWiringOpts = {},
  ): Promise<HeartbeatCutoverResult<HeartbeatTransitionRunFencedResult>> {
    validateTransitionParams(params, opts);
    return executeCutover(
      "transition_run_fenced", opts, isTransitionEngineEligible(params),
      (client, callOpts) => transitionRunFencedWithCutover(client, params, tsFallback, callOpts), tsFallback,
    );
  }

  const createClaimWakeupHook = (
    tsClaim: (params: HeartbeatClaimWakeupParams) => Promise<HeartbeatClaimedWakeup | null>,
    defaultOpts?: HeartbeatCutoverWiringOpts,
  ) => async (params: HeartbeatClaimWakeupParams, opts?: HeartbeatCutoverWiringOpts) =>
    (await claimWakeup(params, () => tsClaim(params), { ...defaultOpts, ...opts })).value;

  const createTransitionRunFencedHook = (
    tsTransition: (params: HeartbeatTransitionRunFencedCutoverParams) => Promise<HeartbeatTransitionRunFencedResult>,
    defaultOpts?: HeartbeatCutoverWiringOpts,
  ) => async (params: HeartbeatTransitionRunFencedCutoverParams, opts?: HeartbeatCutoverWiringOpts) =>
    (await transitionRunFenced(params, () => tsTransition(params), { ...defaultOpts, ...opts })).value;

  const getTelemetry = (): HeartbeatCutoverTelemetrySnapshot => ({
    rustHits: telemetry.rustHits, tsFallbacks: telemetry.tsFallbacks,
    indeterminateErrors: telemetry.indeterminateErrors,
    byOperation: {
      claim_wakeup: { ...telemetry.byOperation.claim_wakeup },
      transition_run_fenced: { ...telemetry.byOperation.transition_run_fenced },
    },
    byReason: { ...telemetry.byReason },
  });

  const resetTelemetry = (): void => { telemetry = emptyTelemetry(); };

  return {
    claimWakeup, transitionRunFenced, createClaimWakeupHook,
    createTransitionRunFencedHook, getTelemetry, resetTelemetry,
  };
}

const defaultWiring = createHeartbeatCutoverWiring();
export const wireClaimWakeupWithCutover = defaultWiring.claimWakeup;
export const wireTransitionRunFencedWithCutover = defaultWiring.transitionRunFenced;
export const getHeartbeatCutoverTelemetry = defaultWiring.getTelemetry;
export const resetHeartbeatCutoverTelemetry = defaultWiring.resetTelemetry;
