// server/src/services/heartbeat-overload-backoff.ts
//
// [purpose] LLM provider 429/일시 과부하(overload) 실패의 쿨다운 백오프 재시도 결정 헬퍼.
//   [사용자 원칙 s34-w1] provider HTTP 429 / "Rate limit reached for requests" (예: glm-zcode)는
//   실제 계정 한도 소진이 아니라 일시적 서버 과부하다 — 인간 카드(escalate /
//   dispatch_run_retries_exhausted)로 승격 금지. 쿨다운 백오프 재시도로 흡수하고,
//   재시도 예산 소진 시에도 사람을 호출하지 않고 defer 한다.
//   [호출부] heartbeat.ts 의 두 실패 후처리 지점(adapter run 실패 정산 직후)에서 사용.
//   순수 판정 함수는 heartbeat-stability.ts 의 노브 함수들과 같은 스타일을 따른다.

/** 429/과부하 계열 실패에 허용하는 쿨다운 백오프 재시도 최대 횟수. */
export const OVERLOAD_MAX_COOLDOWN_RETRIES = 5;

const OVERLOAD_BASE_COOLDOWN_SEC = 30;
/** 백오프 상한 — 과부하 정체가 길어져도 한 방 대기가 5분을 넘지 않는다. */
const OVERLOAD_COOLDOWN_CAP_SEC = 300;

/**
 * [판정 근거] 과부하 신호 텍스트 (대소문자 무시).
 *   - 숫자 상태 코드(429/529)는 단어 경계로만 매칭한다 — "14293 bytes" 같은
 *     무관한 숫자 substring 오탐을 막는다(모델명 glm-529x 도 제외).
 *   - "503 Service Unavailable" 은 스펙 지정 대로 구(句) 단위로 매칭한다.
 */
const OVERLOAD_ERROR_SIGNALS: ReadonlyArray<{ kind: "phrase"; value: string } | { kind: "code"; value: string }> = [
  { kind: "code", value: "429" },
  { kind: "phrase", value: "rate limit reached for requests" },
  { kind: "phrase", value: "overloaded" },
  { kind: "code", value: "529" },
  { kind: "phrase", value: "503 service unavailable" },
  { kind: "phrase", value: "too many requests" },
];

/** provider 429/일시 과부하 신호(텍스트) 판정 — null/빈값/무관한 실패는 false. */
export function isTransientServerOverloadError(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const normalized = text.toLowerCase();
  if (normalized.length === 0) return false;
  return OVERLOAD_ERROR_SIGNALS.some((signal) => {
    if (signal.kind === "phrase") return normalized.includes(signal.value);
    // 숫자 상태 코드는 양옆이 숫자·알파벳이 아닐 때만 인정한다(모델명 glm-529x, 로그 바이트 14293 제외).
    const codePattern = new RegExp(`(?<![0-9a-z])${signal.value}(?![0-9a-z])`);
    return codePattern.test(normalized);
  });
}

/**
 * 쿨다운 백오프(초) — 시도 1부터 30/60/120/240 지수 증가, 300초 상한.
 * 0·NaN·음수 같은 무효 시도는 1회차로 간주한다.
 */
export function computeOverloadCooldownSec(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponential = OVERLOAD_BASE_COOLDOWN_SEC * 2 ** (safeAttempt - 1);
  return Math.min(exponential, OVERLOAD_COOLDOWN_CAP_SEC);
}

/**
 * [인간 카드 가드] 실패의 인간 승격 여부.
 *   과부하(isOverload=true)면 재시도 소진 여부와 무관하게 항상 false — 인간 카드 없음.
 *   과부하가 아니면 기존 계약 보존: 재시도 소진 시 true(기존 blocked 정산 경로).
 */
export function shouldEscalateToHumanOnFailure(input: {
  isOverload: boolean;
  retriesExhausted?: boolean;
}): boolean {
  if (input.isOverload === true) return false;
  return input.retriesExhausted === true;
}

export type OverloadFailureHandling = {
  readonly isOverload: boolean;
  /** true 면 호출부가 cooldownSec 후 재시도 run 을 큐잉해야 한다. */
  readonly retryQueued: boolean;
  readonly cooldownSec: number;
  /** 다음 재시도 회차(1 기반). processLossRetryCount + 1. */
  readonly attempt: number;
  readonly escalateToHuman: boolean;
};

/**
 * 단일 실패의 과부하 후처리 결정 — heartbeat.ts 두 실패 지점이 공유하는 계약.
 *   - 과부하 아님 → 기존 동작 보존(재시도 없음, 소진 시 인간 카드 true).
 *   - 과부하 + 예산 내 → 쿨다운 백오프 재시도, 인간 카드 없음.
 *   - 과부하 + 예산 소진(processLossRetryCount >= OVERLOAD_MAX_COOLDOWN_RETRIES)
 *     → defer(재시도 없음), 그래도 인간 카드 없음.
 */
export function resolveOverloadFailureHandling(input: {
  errorText: string | null | undefined;
  processLossRetryCount?: number | null;
}): OverloadFailureHandling {
  const isOverload = isTransientServerOverloadError(input.errorText);
  if (!isOverload) {
    return { isOverload: false, retryQueued: false, cooldownSec: 0, attempt: 0, escalateToHuman: true };
  }
  const attempt = Math.max(0, Math.floor(input.processLossRetryCount ?? 0)) + 1;
  const retriesExhausted = attempt > OVERLOAD_MAX_COOLDOWN_RETRIES;
  if (retriesExhausted) {
    return { isOverload: true, retryQueued: false, cooldownSec: 0, attempt, escalateToHuman: false };
  }
  return {
    isOverload: true,
    retryQueued: true,
    cooldownSec: computeOverloadCooldownSec(attempt),
    attempt,
    escalateToHuman: false,
  };
}

/** heartbeat 런 이벤트용 과부하 백오프 메시지(표시용 — 실행 근거 아님). */
export function overloadBackoffEventMessage(overloadFailure: OverloadFailureHandling): string {
  return overloadFailure.retryQueued
    ? `Run failed (transient server overload) — cooldown ${overloadFailure.cooldownSec}s before automatic retry ${overloadFailure.attempt}/${OVERLOAD_MAX_COOLDOWN_RETRIES}`
    : "Run failed (transient server overload) — cooldown retry budget exhausted; deferred without paging a human";
}

/**
 * 쿨다운 후 재시도 큐잉 예약 — in-process 지연 타이머.
 *   unref 로 서버 종료를 막지 않고, enqueue 실패는 onError 로 격리한다(무응답 rejection 금지).
 *   프로세스 재시작 시 타이머는 사라지지만 그 경우에도 인간 카드 없이
 *   기존 stalled-lock 회수 경로가 defer 를 이어받는다(호출부 계약).
 */
export function scheduleOverloadCooldownRetry(input: {
  cooldownSec: number;
  enqueue: () => Promise<unknown> | unknown;
  onError?: (err: unknown) => void;
}): NodeJS.Timeout {
  const delayMs = Math.max(0, Math.round(input.cooldownSec * 1000));
  const timer = setTimeout(() => {
    void Promise.resolve().then(input.enqueue).catch((err) => {
      input.onError?.(err);
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}
