// [휴먼카드 남발 수리 2026-11-08] 사람 결정 카드 발행 자격(Admission) 판정.
// R1 계약: 자동 복구 가능한 원인(429/할당량, adapter_failed 재시도, stale/정산 미완,
// 자동 회수 가능한 issue_status_blocked)에는 사람 결정 카드를 발행하지 않는다.
// [Admission v2 2026-11-21] 원인 분류는 human-card-cause-classifier 의 구조화
//   cause 클래스로 위임 — provider_transient/auth_refreshable 은 자동 복구 소유라
//   카드를 억제하고, internal_bug/unknown 은 fail-closed 로 카드를 허용한다.
// 판정은 원천(source) 이슈의 '마지막 terminal 런' 사실만 본다 — 추론·자연어 파싱 없음.
import { and, desc, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  AUTO_RECOVERABLE_ERROR_CODES,
  classifyHumanCardCause,
  type HumanCardCauseClass,
  type HumanCardRecoveryOwner,
} from "./human-card-cause-classifier.js";

/** 자동 복구 경로가 존재하는 error_code — 사람 카드 대신 재시도/정산 회수가 담당한다.
 *  분류기가 provider_transient/auth_refreshable 로 판정하는 구조화 코드와 동일 집합이다. */
export const AUTO_RECOVERABLE_RUN_ERROR_CODES: ReadonlySet<string> = AUTO_RECOVERABLE_ERROR_CODES;

const TERMINAL_FAILURE_STATUSES = ["failed", "cancelled", "timed_out"] as const;

export type SourceTerminalRun = {
  readonly id: string;
  readonly status: string;
  readonly errorCode: string | null;
  /** 자유 텍스트 에러 — 분류기의 bounded 보조 신호(429/timeout/quota 문구 포착용). */
  readonly error?: string | null;
  readonly settledAt: Date | null;
};

export type HumanCardAdmission = {
  /** true = 사람 카드 발행 허용, false = 자동 복구 경로에 맡긴다(카드 없음). */
  readonly admit: boolean;
  readonly cause?: "auto_recoverable_error_code" | "settlement_pending";
  readonly runId?: string;
  readonly errorCode?: string | null;
  /** 분류기의 구조화 원인 클래스·복구 소유자·매칭 신호 — 로그/진단용(원문 아님). */
  readonly causeClass?: HumanCardCauseClass;
  readonly recoveryOwner?: HumanCardRecoveryOwner;
  readonly matchedSignal?: string;
};

/** 원천 이슈의 마지막 terminal 실패 런을 조회한다(실행 런은 원천 이슈에 붙는다). */
export async function loadSourceTerminalRun(
  db: Pick<Db, "select">,
  companyId: string,
  sourceIssueId: string,
): Promise<SourceTerminalRun | null> {
  const [run] = await db.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    error: heartbeatRuns.error,
    settledAt: heartbeatRuns.settledAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.issueId, sourceIssueId),
    inArray(heartbeatRuns.status, [...TERMINAL_FAILURE_STATUSES]),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  return run ?? null;
}

/**
 * 순수 판정 함수.
 * - 런 없음 → 발행 허용(자동 복구 대상이 없는 미지 원인은 사람 판단이 맞다).
 * - 자동 복구 가능 원인(provider_transient·auth_refreshable) → 거부.
 * - terminal 인데 정산 미완(settledAt null) → 거부(정산 회수가 source 를 풀어준다).
 * - 그 외(quota·internal_bug·unknown 등 사람/예산 판단 원인) → 발행 허용(fail-closed).
 */
export function evaluateHumanCardAdmission(run: SourceTerminalRun | null): HumanCardAdmission {
  if (!run) return { admit: true };
  const cause = classifyHumanCardCause({
    errorCode: run.errorCode,
    error: run.error,
    status: run.status,
  });
  const evidence = {
    runId: run.id,
    errorCode: run.errorCode,
    causeClass: cause.causeClass,
    recoveryOwner: cause.recoveryOwner,
    matchedSignal: cause.matchedSignal,
  } as const;
  if (cause.autoRecoverable) {
    return { admit: false, cause: "auto_recoverable_error_code", ...evidence };
  }
  if (run.settledAt == null) {
    return { admit: false, cause: "settlement_pending", ...evidence };
  }
  return { admit: true, ...evidence };
}

/** 조회+판정 한 번의 헬퍼 — 카드 발행 경로(시스템 renewal, 에이전트 제출)에서 같은 기준을 쓴다. */
export async function admitHumanCardForSource(
  db: Pick<Db, "select">,
  companyId: string,
  sourceIssueId: string,
): Promise<HumanCardAdmission> {
  return evaluateHumanCardAdmission(await loadSourceTerminalRun(db, companyId, sourceIssueId));
}
