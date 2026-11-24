// [파일 목적] Phase 1 Step 2f-cutover — 시크릿 리덕션 opt-in Rust 컷오버 + 구조화
//   텔레메트리. PAPERWORK_RUST_REDACTOR_CUTOVER=1(기본 OFF)일 때만 엔진 클라이언트를
//   지연 해석해 fail-closed 리덕터 클라이언트(redactTextFailClosed)로 라우팅하고,
//   그 외에는 주입된 legacy TS 리덕터를 그대로 호출한다. 모든 실패 경로는 정확한
//   [redacted-unscanned] 센티널로 수렴하며 미스캔 원문은 어떤 경로에서도 반환·로깅되지
//   않는다. 이 PR 에는 프로덕션 호출부가 없다(순수 추가, 기본 OFF).
// [외부 연결] paperwork-engine-redactor(fail-closed 클라이언트·센티널·바이트 한도),
//   paperwork-engine-runtime(공유 클라이언트), logger. 호출부는
//   createRedactorCutoverHooks 로 env/getClient/timeoutMs/onEvent 를 한 번만 바인드한다.
import { logger } from "../middleware/logger.js";
import type { PaperworkEngineClient } from "./paperwork-engine-client.js";
import {
  REDACTED_UNSCANNED, REDACTOR_MAX_TEXT_BYTES, redactTextFailClosed,
} from "./paperwork-engine-redactor.js";
import { getSharedPaperworkEngineClient } from "./paperwork-engine-runtime.js";

export type RedactorCutoverSource = "rust" | "fail-closed" | "legacy";
export type RedactorCutoverOutcome = "rust_ok" | "fail_closed" | "legacy";
/** 센티널 수렴 사유 — 고정 문자열만 사용하며 원문 텍스트는 절대 담지 않는다. */
export type RedactorCutoverFailClosedReason =
  "invalid_input" | "engine_unavailable" | "unscanned_result";

export interface RedactorCutoverResult {
  source: RedactorCutoverSource;
  value: string;
}

/** 한 번의 컷오버 호출이 끝날 때 발행되는 구조화 이벤트 — outcome별 카운터와 1:1 대응. */
export interface RedactorCutoverTelemetryEvent {
  source: RedactorCutoverSource;
  outcome: RedactorCutoverOutcome;
  durationMs: number;
  reason?: RedactorCutoverFailClosedReason;
  error?: unknown;
}

export interface RedactorCutoverMetrics {
  rustOk: number;
  failClosed: number;
  legacy: number;
  totalCalls: number;
  totalDurationMs: number;
}

export type RedactorCutoverMetricsSnapshot = Readonly<RedactorCutoverMetrics>;

type CutoverEnv = Readonly<Record<string, string | undefined>>;

export interface RedactorCutoverCallOpts {
  timeoutMs?: number;
  env?: CutoverEnv;
  engineClient?: PaperworkEngineClient | null;
  getClient?: () => PaperworkEngineClient | null;
  onEvent?: (event: RedactorCutoverTelemetryEvent) => void;
}

/** Opt-in only: the literal "1" enables the Rust redactor path; anything else is OFF. */
export function isRustRedactorCutoverEnabled(env: CutoverEnv = process.env): boolean {
  return env.PAPERWORK_RUST_REDACTOR_CUTOVER === "1";
}

const emptyMetrics = (): RedactorCutoverMetrics => ({
  rustOk: 0, failClosed: 0, legacy: 0, totalCalls: 0, totalDurationMs: 0,
});

function safeWarn(context: Record<string, unknown>, message: string): void {
  try {
    logger.warn(context, message);
  } catch {
    // Best-effort logging: a throwing logger must never mask the cutover outcome.
  }
}

// Node 20+ ships ES2024 String.isWellFormed but the repo's ES2023 lib types lack it.
const wellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed();

interface CutoverJob {
  text: unknown;
  legacyRedactor: (text: string) => string;
  opts: RedactorCutoverCallOpts;
  meter: RedactorCutoverMetrics;
}

async function executeCutover(job: CutoverJob): Promise<RedactorCutoverResult> {
  const { text, legacyRedactor, opts, meter } = job;
  meter.totalCalls += 1;
  const startedAt = Date.now();
  const emit = (source: RedactorCutoverSource, outcome: RedactorCutoverOutcome,
    reason?: RedactorCutoverFailClosedReason, error?: unknown): void => {
    const durationMs = Date.now() - startedAt;
    meter.totalDurationMs += durationMs;
    if (opts.onEvent === undefined) return;
    try {
      Promise.resolve(opts.onEvent({ source, outcome, durationMs, reason, error }))
        .catch((observerError) => safeWarn({ err: observerError },
          "redactor cutover onEvent observer rejected; ignoring"));
    } catch (observerError) {
      safeWarn({ err: observerError },
        "redactor cutover onEvent observer threw; ignoring");
    }
  };
  const failClosed = (reason: RedactorCutoverFailClosedReason): RedactorCutoverResult => {
    meter.failClosed += 1;
    emit("fail-closed", "fail_closed", reason);
    return { source: "fail-closed", value: REDACTED_UNSCANNED };
  };

  // Non-string input is a caller bug: fail closed regardless of the flag — never
  // coerced, never forwarded to the legacy path, never sent to the engine.
  if (typeof text !== "string") {
    safeWarn({ inputType: typeof text },
      "redactor cutover received non-string input; failing closed");
    return failClosed("invalid_input");
  }

  // 플래그 OFF: 클라이언트 해석·RPC 없이 곧바로 legacy TS 경로를 호출한다.
  // legacyRedactor 가 던지면 그대로 rethrow 하되 이벤트에 error 를 남긴다.
  if (!isRustRedactorCutoverEnabled(opts.env ?? process.env)) {
    meter.legacy += 1;
    try {
      const value = legacyRedactor(text);
      emit("legacy", "legacy");
      return { source: "legacy", value };
    } catch (error) {
      emit("legacy", "legacy", undefined, error);
      throw error;
    }
  }

  // Oversized/ill-formed inputs degrade before client resolution — the shared client
  // is never resolved and no RPC is issued (mirrors redactTextFailClosed's own gate).
  if (!wellFormed(text) || Buffer.byteLength(text, "utf8") > REDACTOR_MAX_TEXT_BYTES) {
    return failClosed("invalid_input");
  }

  let client: PaperworkEngineClient | null;
  try {
    client = opts.engineClient !== undefined
      ? opts.engineClient
      : (opts.getClient ?? getSharedPaperworkEngineClient)();
  } catch (error) {
    safeWarn({ err: error },
      "paperwork-engine client resolution failed; failing closed");
    return failClosed("engine_unavailable");
  }
  if (client === null) {
    safeWarn({}, "paperwork-engine client unavailable; failing closed");
    return failClosed("engine_unavailable");
  }

  let value: string;
  try {
    value = await redactTextFailClosed(text,
      { engineClient: client, timeoutMs: opts.timeoutMs });
  } catch (error) {
    // redactTextFailClosed never throws for well-formed strings; keep the contract
    // absolute anyway — every failure path converges to the sentinel.
    safeWarn({ err: error }, "redactor engine call threw unexpectedly; failing closed");
    return failClosed("unscanned_result");
  }
  if (value === REDACTED_UNSCANNED) return failClosed("unscanned_result");
  meter.rustOk += 1;
  emit("rust", "rust_ok");
  return { source: "rust", value };
}

const moduleMeter = emptyMetrics();

/** 모듈 수준 텔레메트리의 깊은 복사본 — 반환 객체를 바꿔도 내부 카운터는 보존된다. */
export function getRedactorCutoverMetrics(): RedactorCutoverMetricsSnapshot {
  return { ...moduleMeter };
}

export function resetRedactorCutoverMetricsForTests(): void {
  Object.assign(moduleMeter, emptyMetrics());
}

/**
 * Opt-in redactor cutover entry. Flag OFF routes to the injected legacy TS redactor
 * (no client resolution, no RPC); flag ON routes through the fail-closed engine
 * redactor. Every failure path returns `{ source: "fail-closed", value:
 * [redacted-unscanned] }` — unscanned raw text is never returned or logged.
 */
export function redactTextWithCutover(
  text: unknown,
  legacyRedactor: (text: string) => string,
  opts: RedactorCutoverCallOpts = {},
): Promise<RedactorCutoverResult> {
  return executeCutover({ text, legacyRedactor, opts, meter: moduleMeter });
}

export interface RedactorCutoverHooks {
  redactText: (
    text: unknown,
    legacyRedactor: (text: string) => string,
    opts?: RedactorCutoverCallOpts,
  ) => Promise<RedactorCutoverResult>;
  getMetrics: () => RedactorCutoverMetricsSnapshot;
}

/** env/engineClient/getClient/timeoutMs/onEvent 를 한 번 바인드해 재사용하는 훅 묶음.
 *  훅별 독립 미터를 가지며, 호출당 opts 는 바인드된 기본값 위에 병합된다. */
export function createRedactorCutoverHooks(
  defaultOpts: RedactorCutoverCallOpts = {},
): RedactorCutoverHooks {
  const meter = emptyMetrics();
  return {
    redactText: (text, legacyRedactor, opts = {}) =>
      executeCutover({ text, legacyRedactor,
        opts: { ...defaultOpts, ...opts }, meter }),
    getMetrics: () => ({ ...meter }),
  };
}
