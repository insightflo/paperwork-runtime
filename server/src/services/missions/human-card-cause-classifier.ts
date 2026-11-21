// [Admission v2 2026-11-21] 휴먼카드 원인 분류기 — 순수 함수, DB·I/O·로깅 없음.
// terminal 실패의 원인을 구조화된 클래스로 판정해 사람 결정 카드 발행 게이트의 근거로 쓴다.
// 판정은 구조화 신호(error_code·run status)와 bounded 에러 텍스트 패턴만 본다 —
//   자연어 추론·코멘트 파싱은 authority 로 쓰지 않는다(계약 9).
//
// 원인 클래스와 복구 소유자:
//   - provider_transient: 429·속도제한·과부하·타임아웃·네트워크/5xx·adapter_failed·
//     stale_queued·issue_status_blocked — 재시도/폴백/정산 회수가 담당(자동 복구).
//   - auth_refreshable: 만료 토큰 등 갱신으로 회복되는 인증 실패 — refresh/재시도가 담당(자동 복구).
//   - quota: 쿼터·예산 소진 — 예산/쿼터 결정 소유. 자동 재시도는 무의미하고 generic
//     에러 덤프도 아니다(명시적 예산 결정 에스컬레이션만 카드를 연다).
//   - internal_bug: assertion·invariant·schema 위반 — fail-closed, 사람 카드 허용.
//   - unknown: 미분류 — fail-closed, 사람 카드 허용.

export type HumanCardCauseClass =
  | "provider_transient"
  | "auth_refreshable"
  | "quota"
  | "internal_bug"
  | "unknown";

/** 누가 이 원인을 회수하는가 — 사람 카드가 필요한 경우에만 "human". */
export type HumanCardRecoveryOwner = "retry" | "refresh" | "budget" | "human";

export type HumanCardCauseInput = {
  /** heartbeat run 의 구조화 error_code(가장 신뢰도 높은 신호). */
  readonly errorCode?: string | null;
  /** 자유 텍스트 에러(run.error 등) — bounded 패턴 매칭에만 쓴다. */
  readonly error?: string | null;
  /** terminal run 상태(failed/timed_out/cancelled) — timed_out 은 transient 신호. */
  readonly status?: string | null;
};

export type HumanCardCause = {
  readonly causeClass: HumanCardCauseClass;
  /** true 이면 재시도/갱신이 사람 없이 회수한다 — 사람 카드 발행 게이트가 억제한다. */
  readonly autoRecoverable: boolean;
  readonly recoveryOwner: HumanCardRecoveryOwner;
  /** 매칭된 신호 토큰(code:<name>, text:<pattern>, status:<name>, none) — 로그·증거용. 원문 아님. */
  readonly matchedSignal: string;
};

// ── 구조화 error_code 테이블(정규화된 exact match — 최우선 신호) ────────────────
const PROVIDER_TRANSIENT_ERROR_CODES = new Set([
  // adapter_failed: 429/속도제한/일시 adapter 장애 — heartbeat 재시도·폴백이 회수
  "adapter_failed",
  // stale_queued: 큐 승급 지연 — 감독 wakeup/재큐 경로가 회수
  "stale_queued",
  // issue_status_blocked: 런 취소 후 이슈 상태 정산 누락 — 정산 회수가 담당
  "issue_status_blocked",
]);

const AUTH_REFRESHABLE_ERROR_CODES = new Set([
  "token_expired",
  "auth_refreshable",
]);

const QUOTA_ERROR_CODES = new Set([
  "quota_exceeded",
  "budget_exhausted",
  "insufficient_quota",
]);

const INTERNAL_BUG_ERROR_CODES = new Set([
  "assertion_failed",
  "invariant_violation",
  "schema_violation",
  "unhandled_exception",
]);

/** 자동 복구 소유 코드 전체(provider_transient ∪ auth_refreshable) — 외부 계약용 집합. */
export const AUTO_RECOVERABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PROVIDER_TRANSIENT_ERROR_CODES,
  ...AUTH_REFRESHABLE_ERROR_CODES,
]);

// ── 자유 텍스트 패턴(error_code 가 미등록이거나 비어 있을 때만 보조 신호) ───────
// 우선순위: internal_bug > quota > auth_refreshable > provider_transient.
//   버그 어휘가 명시되면 일시 장애로 억제하지 않고 fail-closed 로 사람에게 연다.
//   쿼터 소진은 속도제한보다 우선한다(429 라도 insufficient_quota 면 재시도 무의미).
const INTERNAL_BUG_TEXT = /\b(assertion(?:[_ -]?failed)?|invariant(?:[_ -]?violation)?|schema[_ -]?violation|unhandled[_ -]?exception)\b/i;
const QUOTA_TEXT = /\b(insufficient[_ -]?quota|quota[_ -]?exceeded|exceeded[_ -]?your[_ -]?(?:current[_ -]?)?quota|budget[_ -]?exhausted|billing(?:[_ -]?hard)?[_ -]?limit|credits?[_ -]?exhausted)\b/i;
const AUTH_REFRESHABLE_TEXT = /\b(token[_ -]?expired|session[_ -]?expired|auth[_ -]?refreshable|access[_ -]?token[_ -]?expired|id[_ -]?token[_ -]?expired)\b|\b401\b[^\n]{0,80}\b(?:expired|refreshable)\b|\b(?:expired|refreshable)\b[^\n]{0,80}\b401\b/i;
const PROVIDER_TRANSIENT_TEXT = /\b(429|rate[_ -]?limit(?:ed)?|overloaded|timeout|timed[_ -]?out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket[_ -]?hang[_ -]?up|network|50[2349]|service[_ -]?unavailable|bad[_ -]?gateway|gateway[_ -]?timeout)\b/i;

// 텍스트 매칭은 bounded — 원문은 결과/로그에 남기지 않는다.
const TEXT_SCAN_MAX = 2_000;

const CAUSE_META: Record<Exclude<HumanCardCauseClass, "unknown">, { autoRecoverable: boolean; recoveryOwner: HumanCardRecoveryOwner }> = {
  provider_transient: { autoRecoverable: true, recoveryOwner: "retry" },
  auth_refreshable: { autoRecoverable: true, recoveryOwner: "refresh" },
  quota: { autoRecoverable: false, recoveryOwner: "budget" },
  internal_bug: { autoRecoverable: false, recoveryOwner: "human" },
};

function hit(causeClass: Exclude<HumanCardCauseClass, "unknown">, matchedSignal: string): HumanCardCause {
  return { causeClass, ...CAUSE_META[causeClass], matchedSignal };
}

/** 매칭 토큰을 bounded sanitized 형태로 돌려준다(원문·제어문자·긴 조각 금지). */
function matchedTextToken(match: RegExpExecArray | null): string {
  const token = (match?.[1] ?? match?.[0] ?? "")
    .replace(/[\x00-\x1F\x7F{}[\]"`\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return token ? `text:${token.toLowerCase().replace(/ /g, "_")}` : "text:unknown";
}

/**
 * terminal 실패 원인 분류 — 순수 판정.
 * 1) 등록된 error_code exact match(가장 신뢰도 높은 신호, 어느 클래스든 먼저 결정).
 * 2) bounded 텍스트 패턴 — internal_bug > quota > auth_refreshable > provider_transient 순.
 * 3) status timed_out → provider_transient(타임아웃은 재시도 소유).
 * 4) 그 외 → unknown(fail-closed, 사람 카드 허용).
 */
export function classifyHumanCardCause(input: HumanCardCauseInput): HumanCardCause {
  const code = (input.errorCode ?? "").trim().toLowerCase();
  if (code) {
    if (INTERNAL_BUG_ERROR_CODES.has(code)) return hit("internal_bug", `code:${code}`);
    if (QUOTA_ERROR_CODES.has(code)) return hit("quota", `code:${code}`);
    if (AUTH_REFRESHABLE_ERROR_CODES.has(code)) return hit("auth_refreshable", `code:${code}`);
    if (PROVIDER_TRANSIENT_ERROR_CODES.has(code)) return hit("provider_transient", `code:${code}`);
  }
  const haystack = `${code}\n${(input.error ?? "").slice(0, TEXT_SCAN_MAX)}`;
  let match = INTERNAL_BUG_TEXT.exec(haystack);
  if (match) return hit("internal_bug", matchedTextToken(match));
  match = QUOTA_TEXT.exec(haystack);
  if (match) return hit("quota", matchedTextToken(match));
  match = AUTH_REFRESHABLE_TEXT.exec(haystack);
  if (match) return hit("auth_refreshable", matchedTextToken(match));
  match = PROVIDER_TRANSIENT_TEXT.exec(haystack);
  if (match) return hit("provider_transient", matchedTextToken(match));
  if ((input.status ?? "").trim().toLowerCase() === "timed_out") {
    return hit("provider_transient", "status:timed_out");
  }
  return { causeClass: "unknown", autoRecoverable: false, recoveryOwner: "human", matchedSignal: "none" };
}
