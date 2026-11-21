// server/src/services/missions/supervision-single-lane-relax.ts
//
// [single-lane relax 2026-11-21] pending 사람 결정 카드가 있어도, 그 카드가 정상-흐름
//   선택(choice) 카드도 아니고 비가역(irreversible) 표시도 아니며, 소스 이슈의 최신 terminal
//   실패가 자동 복구 원인(provider_transient/auth_refreshable)으로 분류되면 단일-경로 보류를
//   완화해 기존 stale-source 자동 wakeup 회구 경로를 다시 연다.
//   배경: R4 이중 경로 규칙은 '회구 run → 새 오류 → 새 카드' 루프를 끊기 위해 pending 카드
//   대기 중 wakeup 을 무조건 보류했다. 그런데 admission v2 로 429/timeout/token_expired 같은
//   자동 복구 원인에는 사람 카드 자체가 억제되므로, 이미 열린 카드(레거시/회수 대기)가 있어도
//   실패 원인이 자동 복구 소유면 사람 응답 없이 재시도가 정상 회구다 — 미션 회복 후
//   mission-work-settlement 가 pending 카드를 정산으로 닫는다.
// [수정시 주의] 완화는 절대 fail-closed 다 — internal_bug·unknown·quota·미조회 런,
//   choice 카드, irreversible 카드, dry-run(applySafeActions !== true)이면 relax=false 로
//   기존 보류를 그대로 유지한다. 앵커 상한(MAX_SOURCE_ANCHORS)·멱등·진단 게이트 등
//   runaway 보호는 이 모듈을 우회하지 않고 그대로 적용된다.
//   판정은 구조화 필드(operator_decisions.sourceContext, heartbeat_runs 구조 컬럼)만 읽고
//   카드 본문 자연어는 authority 로 쓰지 않는다(규칙 9).
import { and, eq, inArray } from "drizzle-orm";
import { operatorDecisions, type Db } from "@paperclipai/db";
import { classifyHumanCardCause, type HumanCardCauseClass } from "./human-card-cause-classifier.js";
import { loadSourceTerminalRun } from "./human-card-admission.js";

/** pending 카드 sourceContext 에서 완화 게이트가 읽는 구조 힌트(TTL 모듈과 같은 계약). */
export type SingleLaneRelaxCardContext = {
  /** "choice" 이면 정상-흐름 선택 카드 — 절대 완화하지 않는다. */
  readonly decisionKind?: string | null;
  /** true 이면 비가역 카드 — 절대 완화하지 않는다. */
  readonly irreversible?: boolean | null;
};

export type SingleLaneRelaxResult = {
  /** true 면 단일-경로 보류를 풀고 기존 wakeup 회구 경로를 진행한다. */
  readonly relax: boolean;
  /** 완화 근거가 된 분류(런이 없거나 카드 게이트가 막으면 null). */
  readonly causeClass: HumanCardCauseClass | null;
  /** 분류기가 매칭한 신호 토큰(code:<name>/text:<pattern>/status:<name>) — 원문 아님. */
  readonly matchedSignal: string | null;
  /** 판정 사유 토큰 — findings/diagnostics 용 machine token. */
  readonly reason:
    | "auto_recoverable"
    | "dry_run"
    | "no_pending_cards"
    | "card_blocks_relax"
    | "no_terminal_run"
    | "cause_not_auto_recoverable";
};

const RELAXED: Omit<SingleLaneRelaxResult, "causeClass" | "matchedSignal"> = {
  relax: true,
  reason: "auto_recoverable",
};

function blocked(reason: SingleLaneRelaxResult["reason"], extra: Partial<SingleLaneRelaxResult> = {}): SingleLaneRelaxResult {
  return { relax: false, causeClass: null, matchedSignal: null, reason, ...extra };
}

function cardBlocksRelax(ctx: SingleLaneRelaxCardContext): boolean {
  return (ctx.decisionKind ?? "").trim().toLowerCase() === "choice" || ctx.irreversible === true;
}

/**
 * 순수 판정 — 카드 컨텍스트 목록과 최신 terminal 실패 런(없을 수 있음)만으로 완화 여부를 결정한다.
 * (a) 모든 pending 카드가 choice 아님 + irreversible 아님, 그리고
 * (b) 소스 이슈 최신 terminal 실패 런이 autoRecoverable(provider_transient/auth_refreshable)일 때만
 * relax=true. 런 부재·비자동복구 원인·카드 게이트 위반은 전부 fail-closed(relax=false).
 */
export function evaluateSingleLaneRelax(input: {
  readonly pendingCards: ReadonlyArray<SingleLaneRelaxCardContext>;
  readonly failedRun: { readonly errorCode?: string | null; readonly error?: string | null; readonly status?: string | null } | null;
}): SingleLaneRelaxResult {
  if (input.pendingCards.some(cardBlocksRelax)) return blocked("card_blocks_relax");
  const run = input.failedRun;
  if (!run) return blocked("no_terminal_run");
  const cause = classifyHumanCardCause({ errorCode: run.errorCode, error: run.error, status: run.status });
  if (!cause.autoRecoverable) {
    return blocked("cause_not_auto_recoverable", { causeClass: cause.causeClass, matchedSignal: cause.matchedSignal });
  }
  return { ...RELAXED, causeClass: cause.causeClass, matchedSignal: cause.matchedSignal };
}

/**
 * stale-source wakeup 보류 완화 판정(DB 조회 래퍼).
 * - applySafeActions !== true(dry-run)면 즉시 relax=false — 읽기 전용 틱에서 보류 정책을 바꾸지 않는다.
 * - pendingDecisionIds(마커가 수집한 미션 pending 카드) 중 하나라도 choice/irreversible 이면 relax=false.
 * - 마지막으로 소스 이슈의 최신 terminal 실패 런을 조회해 분류한다(admission 과 동일한 런 선택 계약).
 * 카드 행이 마커 수집 이후 resolve/cancel 됐어도 보수적으로 컨텍스트를 검사한다(누락 행은 무시).
 */
export async function canRelaxSingleLaneForAutoRecoverableSource(input: {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly sourceIssueId: string;
  readonly pendingDecisionIds: ReadonlyArray<string>;
  readonly applySafeActions?: boolean;
}): Promise<SingleLaneRelaxResult> {
  if (input.applySafeActions !== true) return blocked("dry_run");
  const ids = Array.from(new Set(input.pendingDecisionIds.filter((id) => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) return blocked("no_pending_cards");
  const cardRows = await input.db.select({
    id: operatorDecisions.id,
    sourceContext: operatorDecisions.sourceContext,
  }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId),
    inArray(operatorDecisions.id, ids),
  ));
  const pendingCards = cardRows.map((row) => {
    const ctx = (row.sourceContext ?? {}) as SingleLaneRelaxCardContext;
    const cardCtx: SingleLaneRelaxCardContext = {
      decisionKind: typeof ctx.decisionKind === "string" ? ctx.decisionKind : null,
      irreversible: ctx.irreversible === true,
    };
    return cardCtx;
  });
  const failedRun = await loadSourceTerminalRun(input.db, input.companyId, input.sourceIssueId);
  return evaluateSingleLaneRelax({ pendingCards, failedRun });
}
