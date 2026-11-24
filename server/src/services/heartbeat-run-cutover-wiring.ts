// [파일 목적] Wave 6e — heartbeat.run_agent 컷오버 배선 + 구조화 텔레메트리 계층.
//   PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를 해석해
//   컷오버 어댑터(heartbeat-run-cutover)에 위임하고, 그 외에는 TS 러너를 그대로
//   호출한다. indeterminate 는 절대 TS 폴백 없이 전파하고, unreaped handoff
//   (unreaped_pid/reap_handoff_pending) 결과는 호출부가 wait/reap 을 독점 소유하므로
//   그대로 반환한다(재실행·폴백·시그널 금지).
// [외부 연결] heartbeat-run-cutover(어댑터), paperwork-engine-heartbeat-run
//   (hasUnreapedChild), paperwork-engine-runtime(공유 클라이언트), logger. 호출부는
//   createHeartbeatRunCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만
//   바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  HeartbeatRunCutoverIndeterminateError,
  isHeartbeatRunCutoverEnabled,
  runHeartbeatAgentWithCutover,
  type HeartbeatRunCutoverCallOpts,
  type HeartbeatRunCutoverResult,
} from "./heartbeat-run-cutover.js";
import {
  hasUnreapedChild,
  type HeartbeatRunAgentParams,
  type HeartbeatRunAgentResult,
} from "./paperwork-engine-heartbeat-run.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export { HeartbeatRunCutoverIndeterminateError };
export type {
  HeartbeatRunAgentParams,
  HeartbeatRunAgentResult,
  HeartbeatRunCutoverCallOpts,
  HeartbeatRunCutoverResult,
};

/** 텔레메트리가 다루는 컷오버 대상 — run_agent 단일 오퍼레이션. */
export type HeartbeatRunWiredOperation = "run_agent";

export type HeartbeatRunCutoverOutcome =
  | "rust_ok" | "fallback" | "indeterminate"
  | "unreaped_handoff" | "ts_bypass" | "ts_error";

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface HeartbeatRunCutoverTelemetryEvent {
  operation: HeartbeatRunWiredOperation;
  outcome: HeartbeatRunCutoverOutcome;
  source: "rust" | "ts" | null;
  durationMs: number;
  error?: unknown;
}

export interface HeartbeatRunCutoverOperationMetrics {
  rustOk: number;
  fallback: number;
  indeterminate: number;
  unreapedHandoff: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type HeartbeatRunCutoverMetricsSnapshot = Readonly<
  Record<HeartbeatRunWiredOperation, Readonly<HeartbeatRunCutoverOperationMetrics>>>;

export interface HeartbeatRunCutoverWiringOpts extends HeartbeatRunCutoverCallOpts {
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: HeartbeatRunCutoverTelemetryEvent) => void;
}

type Meter = Record<HeartbeatRunWiredOperation, HeartbeatRunCutoverOperationMetrics>;

const emptyOperationMetrics = (): HeartbeatRunCutoverOperationMetrics => ({
  rustOk: 0, fallback: 0, indeterminate: 0, unreapedHandoff: 0,
  totalCalls: 0, totalDurationMs: 0,
});
const emptyMeter = (): Meter => ({ run_agent: emptyOperationMetrics() });
const snapshotMeter = (meter: Meter): HeartbeatRunCutoverMetricsSnapshot => ({
  run_agent: { ...meter.run_agent },
});

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: Pino serialization of hostile Error getters must never mask cutover outcomes.
  }
}

interface CutoverJob {
  params: HeartbeatRunAgentParams;
  tsFallback: () => Promise<HeartbeatRunAgentResult>;
  opts: HeartbeatRunCutoverWiringOpts;
  meter: Meter;
}

async function executeHeartbeatRunCutover(
  job: CutoverJob,
): Promise<HeartbeatRunCutoverResult<HeartbeatRunAgentResult>> {
  const { params, tsFallback, opts, meter } = job;
  const metrics = meter.run_agent;
  metrics.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (outcome: HeartbeatRunCutoverOutcome,
    source: "rust" | "ts" | null, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    metrics.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ operation: "run_agent", outcome, source, durationMs, error }))
        .catch((observerError) => safeWarn({ operation: "run_agent", err: observerError },
          "heartbeat run cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ operation: "run_agent", err: observerError },
        "heartbeat run cutover onEvent observer threw; ignoring");
    }
  };

  // 플래그 OFF·클라이언트 부재 경로: 어댑터에 가지 않고 곧바로 TS 러너를 호출한다.
  // tsFallback 이 던지면 ts_error 이벤트 후 그대로 rethrow — RPC 카운터는 건드리지 않는다.
  const runTsBypass = async (): Promise<HeartbeatRunCutoverResult<HeartbeatRunAgentResult>> => {
    try {
      const value = await tsFallback();
      emit("ts_bypass", "ts");
      return { source: "ts", value };
    } catch (error) {
      emit("ts_error", "ts", error);
      throw error;
    }
  };

  const env = opts.env ?? process.env;
  if (!isHeartbeatRunCutoverEnabled(env)) return runTsBypass();

  let client: PaperworkEngineClient | null;
  try {
    client = (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ operation: "run_agent", err: error },
      "paperwork-engine client resolution failed; bypassing to TS");
    return runTsBypass();
  }
  if (client === null) {
    safeWarn({ operation: "run_agent" },
      "paperwork-engine client unavailable; bypassing to TS runner");
    return runTsBypass();
  }

  try {
    const result = await runHeartbeatAgentWithCutover(
      client, params, tsFallback, { timeoutMs: opts.timeoutMs, env });
    if (result.source === "rust") {
      if (hasUnreapedChild(result.value)) {
        // unreaped_pid / reap_handoff_pending: 엔진이 살아있는 자식의 wait/reap
        // 소유권을 호출부에 넘겼다. 결과를 AS-IS 로 반환 — 재실행·폴백·시그널 금지.
        metrics.unreapedHandoff += 1;
        emit("unreaped_handoff", "rust");
      } else {
        metrics.rustOk += 1;
        emit("rust_ok", "rust");
      }
    } else {
      // 어댑터가 TS 경로를 택했다: not_committed 분류 폴백 또는 엔진 표현 불가 파라미터.
      metrics.fallback += 1;
      emit("fallback", "ts");
    }
    return result;
  } catch (error) {
    if (error instanceof HeartbeatRunCutoverIndeterminateError) {
      // indeterminate: 엔진이 자식을 이미 스폰했을 수 있어 TS 재실행은 이중 스폰이다.
      metrics.indeterminate += 1;
      emit("indeterminate", null, error);
    } else {
      // 어댑터가 던지는 비-indeterminate 오류는 tsFallback 자체의 실패다.
      emit("ts_error", null, error);
    }
    throw error;
  }
}

const moduleMeter = emptyMeter();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getHeartbeatRunCutoverMetrics(): HeartbeatRunCutoverMetricsSnapshot {
  return snapshotMeter(moduleMeter);
}

export function resetHeartbeatRunCutoverMetricsForTests(): void {
  moduleMeter.run_agent = emptyOperationMetrics();
}

export function wireRunHeartbeatAgentCutover(
  params: HeartbeatRunAgentParams,
  tsFallback: () => Promise<HeartbeatRunAgentResult>,
  opts: HeartbeatRunCutoverWiringOpts = {},
): Promise<HeartbeatRunCutoverResult<HeartbeatRunAgentResult>> {
  return executeHeartbeatRunCutover({ params, tsFallback, opts, meter: moduleMeter });
}

export interface HeartbeatRunCutoverHooks {
  runHeartbeatAgent: typeof wireRunHeartbeatAgentCutover;
  getMetrics: () => HeartbeatRunCutoverMetricsSnapshot;
}

/** env/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createHeartbeatRunCutoverHooks(
  defaultOpts: HeartbeatRunCutoverWiringOpts = {},
): HeartbeatRunCutoverHooks {
  const meter = emptyMeter();
  const merged = (opts: HeartbeatRunCutoverWiringOpts): HeartbeatRunCutoverWiringOpts => ({
    ...defaultOpts, ...opts,
  });
  return {
    runHeartbeatAgent: (params, tsFallback, opts = {}) =>
      executeHeartbeatRunCutover({ params, tsFallback, opts: merged(opts), meter }),
    getMetrics: () => snapshotMeter(meter),
  };
}
