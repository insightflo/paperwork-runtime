// [stage26 s26-w4] workflow step-run 에 인간 대기(human_wait) 결정 메타데이터를 읽기 전용으로 덧입히는
//   배치 오버레이. step-run 행은 절대 갱신하지 않고 복사본에 optional humanWaitDecision 을 붙여 반환한다.
//   status 는 원본 DB 문자열이 아니라 fail-closed 분류기 classifyHumanWaitDecisionRow 에 structured
//   (status, result) 를 넣어 파생한 표시용 상태다: pause→pending, resume→approved,
//   fail(expired)→expired, fail(rejected)→rejected. 자연어 파싱 없음, 실행 권한 판정 근거 아님.
//   매칭 키: operator_decisions.issue_id (컬럼) 또는 sourceContext->>'workflowRunId' (jsonb) —
//   단일 inArray 배치 쿼리(0 N+1)로 조회하고 companyId 로 강제 스코프해 타사 결정이 유출되지 않게 한다.
//   참고: operator_decisions 에 paused_at 컬럼은 없으므로 카드 생성 시점(createdAt)을 인간 대기 시작
//   (pausedAt)으로 매핑한다. 표시/요약 전용 오버레이이며 실행 권한 판정 근거로 읽히지 않는다.
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { operatorDecisions, type Db, type OperatorDecisionResultJson } from "@paperclipai/db";
import { classifyHumanWaitDecisionRow } from "./control-flow/human-wait-gate.js";

/** classifyHumanWaitDecisionRow 파생 결과의 표시용 상태(UI GraphRunTimeline 계약과 동일). */
export type StepRunHumanWaitStatus = "pending" | "approved" | "rejected" | "expired";

/** step-run 에 덧입힐 인간 대기 결정 메타데이터(표시 전용). status 는 파생 표시 상태다. */
export interface StepRunHumanWaitDecision {
  decisionId: string;
  status: StepRunHumanWaitStatus;
  pausedAt: string | null;
  resolvedAt: string | null;
}

/** 오버레이가 매칭에 사용하는 step-run 최소 필드. */
export interface StepRunDecisionOverlayTarget {
  workflowRunId: string;
  issueId?: string | null;
}

export interface OperatorDecisionOverlayRow {
  decisionId: string;
  issueId: string | null;
  workflowRunId: string | null;
  status: string;
  result: OperatorDecisionResultJson | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

const workflowRunIdExpression = sql<string | null>`${operatorDecisions.sourceContext} ->> 'workflowRunId'`;

/** structured (status, result) → 표시용 상태. pause→pending, resume→approved, fail→resolution. */
function toDisplayStatus(row: Pick<OperatorDecisionOverlayRow, "status" | "result">): StepRunHumanWaitStatus {
  const outcome = classifyHumanWaitDecisionRow(row);
  if (outcome.action === "pause") return "pending";
  if (outcome.action === "resume") return "approved";
  return outcome.resolution;
}

function toHumanWaitDecision(row: OperatorDecisionOverlayRow): StepRunHumanWaitDecision {
  return {
    decisionId: row.decisionId,
    status: toDisplayStatus(row),
    pausedAt: row.createdAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * step-run 배열을 배치 조회 한 번으로 오버레이한 새 배열을 반환한다(입력 행 비변경).
 * - 빈 입력은 DB 쿼리 없이 [] 를 반환한다(빠른 경로).
 * - 결정 매칭 우선순위는 issue_id 정확 매치 > sourceContext.workflowRunId 매치다.
 * - 여러 결정이 한 step-run 에 매치되면 createdAt 기준 최신(내림차순 정렬상 첫 행)이 이긴다;
 *   동률 tie-break 은 id 내림차순으로 결정적을 유지한다.
 */
export async function attachStepRunHumanWaitDecisions<T extends StepRunDecisionOverlayTarget>(
  db: Pick<Db, "select">,
  companyId: string,
  stepRuns: readonly T[],
): Promise<Array<T & { humanWaitDecision?: StepRunHumanWaitDecision }>> {
  if (stepRuns.length === 0) return [];

  const issueIds = [...new Set(stepRuns
    .map((run) => run.issueId)
    .filter((v): v is string => typeof v === "string" && v.length > 0))];
  const workflowRunIds = [...new Set(stepRuns.map((run) => run.workflowRunId).filter((v) => v.length > 0))];
  if (issueIds.length === 0 && workflowRunIds.length === 0) {
    return stepRuns.map((run) => ({ ...run }));
  }

  const matchConditions: SQL[] = [];
  if (issueIds.length > 0) matchConditions.push(inArray(operatorDecisions.issueId, issueIds));
  if (workflowRunIds.length > 0) matchConditions.push(inArray(workflowRunIdExpression, workflowRunIds));

  const rows = await db
    .select({
      decisionId: operatorDecisions.id,
      issueId: operatorDecisions.issueId,
      workflowRunId: workflowRunIdExpression,
      status: operatorDecisions.status,
      result: operatorDecisions.result,
      createdAt: operatorDecisions.createdAt,
      resolvedAt: operatorDecisions.resolvedAt,
    })
    .from(operatorDecisions)
    .where(and(eq(operatorDecisions.companyId, companyId), or(...matchConditions)))
    .orderBy(desc(operatorDecisions.createdAt), desc(operatorDecisions.id));

  // 최신 결정 우선: 정렬된 행을 순회하며 키별 첫 등장만 기록한다.
  const byIssue = new Map<string, OperatorDecisionOverlayRow>();
  const byRun = new Map<string, OperatorDecisionOverlayRow>();
  for (const row of rows) {
    if (row.issueId !== null && row.issueId !== "" && !byIssue.has(row.issueId)) byIssue.set(row.issueId, row);
    if (row.workflowRunId !== null && row.workflowRunId !== "" && !byRun.has(row.workflowRunId)) {
      byRun.set(row.workflowRunId, row);
    }
  }

  return stepRuns.map((run) => {
    const issueMatch = run.issueId ? byIssue.get(run.issueId) : undefined;
    const decision = issueMatch ?? byRun.get(run.workflowRunId);
    if (!decision) return { ...run };
    return { ...run, humanWaitDecision: toHumanWaitDecision(decision) };
  });
}
