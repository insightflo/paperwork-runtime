import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanQaVerdicts,
  missionQualityVerdicts,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowQaRebindClaims,
  workflowRecoveryAuthorities,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ensureDeadTargetHumanEscalation } from "../services/missions/mission-owner-dead-target-loop.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

async function snapshotDeadTargetState(db: ReturnType<typeof createDb>, companyId: string, decisionId: string) {
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId))
    .orderBy(asc(workflowRuns.id));
  const runIds = runs.map((run) => run.id);
  const [decisions, issueRows, stepRuns, invocations, products, events, continuations, wakeups,
    heartbeats, comments, activity, planQa, missionQa, rebindClaims, terminalDecisions, terminalEffects,
    recoveryAuthorities] = await Promise.all([
    db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId)).orderBy(asc(operatorDecisions.id)),
    db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(asc(issues.id)),
    db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runIds)).orderBy(asc(workflowStepRuns.id)),
    db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId)).orderBy(asc(workflowStepInvocations.id)),
    db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)).orderBy(asc(issueWorkProducts.id)),
    db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)).orderBy(asc(workflowTransitionEvents.id)),
    db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId))
      .orderBy(asc(operatorDecisionContinuations.id)),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)).orderBy(asc(agentWakeupRequests.id)),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(asc(heartbeatRuns.id)),
    db.select().from(issueComments).where(eq(issueComments.companyId, companyId)).orderBy(asc(issueComments.id)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(asc(activityLog.id)),
    db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.companyId, companyId)).orderBy(asc(missionPlanQaVerdicts.id)),
    db.select().from(missionQualityVerdicts).where(eq(missionQualityVerdicts.companyId, companyId)).orderBy(asc(missionQualityVerdicts.id)),
    db.select().from(workflowQaRebindClaims).where(eq(workflowQaRebindClaims.companyId, companyId)).orderBy(asc(workflowQaRebindClaims.id)),
    db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.companyId, companyId)).orderBy(asc(workflowTerminalDecisions.id)),
    db.select().from(workflowTerminalEffectIntents).where(eq(workflowTerminalEffectIntents.companyId, companyId)).orderBy(asc(workflowTerminalEffectIntents.id)),
    db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, companyId)).orderBy(asc(workflowRecoveryAuthorities.id)),
  ]);
  return { decisions, issues: issueRows, runs, stepRuns, invocations, products, events, continuations, wakeups,
    heartbeats, comments, activity, planQa, missionQa, rebindClaims, terminalDecisions, terminalEffects,
    recoveryAuthorities };
}

describe("dead-target card structured restart binding", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("dead-target-binding-");
    db = createDb(pg.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await pg?.cleanup();
  });

  // [B4 2026-11-15] 정책 변경 — 해시 검증 카드 + 해시로 잠긴 재시작 범위(approvedScope) + 사람의
  //   명시적 옵션 선택이면 권한 원본으로 인정한다. #457 이후 workflow_restart_request_v1 카드의
  //   생산자가 없어 모든 UI 재시작이 구조적으로 409였던 회귀(godsvg 2026-11-14)를 연다.
  //   보존 검증(실패한 최상위 런만·대체 실행 중복 금지)은 startWorkflowRestartFromOperatorDecision 이 유지한다.
  it("executes the owner-selected restart from the failed-run-bound escalation and still holds tampered cards", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID();
    const workflowId = randomUUID(), workflowRunId = randomUUID();
    const sourceIssueId = randomUUID(), anchorIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dead target binding", issuePrefix: "DTB" });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId,
      title: "Recover dead source", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId,
      name: "Recovery workflow", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId,
      status: "failed", triggeredBy: "test", completedAt: new Date() });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, title: "Dead source", status: "done",
        originKind: "workflow_execution", assigneeAgentId: ownerAgentId },
      { id: anchorIssueId, companyId, missionId, title: "Recovery oversight", status: "blocked",
        originKind: "mission_main_executor_oversight", assigneeAgentId: ownerAgentId },
    ]);
    await db.insert(workflowStepRuns).values({ workflowRunId, stepId: "collect", status: "failed",
      issueId: sourceIssueId });

    const result = await ensureDeadTargetHumanEscalation(db, {
      companyId, missionId, ownerAgentId, loopKey: "retry_source_issue",
      anchors: [{ id: anchorIssueId, status: "blocked", title: "Recovery oversight", identifier: null }],
      ownerActionIssueId: anchorIssueId, sourceIssueId,
      reason: "dead target", evidence: "source_terminal",
    });
    expect(result).toEqual({ ensured: true, reason: "card-created" });
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, companyId));
    expect(card.sourceContext.workflowRunId).toBe(workflowRunId);
    expect(card.definition.options.map((option) => option.id)).toEqual([
      WORKFLOW_RESTART_FROM_START_OPTION_ID,
      "replan-mission",
      "reassign-owner",
      "cancel-mission",
    ]);
    expect(card.definition.approvedScope).toContain("workflow_run.restart_from_start");
    expect(card.definition.options.some((option) => option.id === "retry-a-different-live-source"))
      .toBe(false);
    expect(card.definition.options.some((option) => option.id === "missing-recovery-target"))
      .toBe(false);

    const before = await snapshotDeadTargetState(db, companyId, card.id);
    const resolved = await operatorDecisionWriteService(db).resolve(card.id, {
      actionId: "submit",
      selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID],
      comment: "restart with the bound failed run",
    }, "board-user");
    expect(resolved.applied).toBe(true);

    const after = await snapshotDeadTargetState(db, companyId, card.id);
    // 결정은 적용됐고 소스 실행·이슈는 그대로(보존) — 새 최상위 대체 실행만 추가된다.
    expect(after.decisions[0]!.status).toBe("resolved");
    expect(after.decisions[0]!.result!.selectedOptionIds).toEqual([WORKFLOW_RESTART_FROM_START_OPTION_ID]);
    expect(after.issues.find((issue) => issue.id === sourceIssueId)!.status).toBe("done");
    expect(after.runs.find((run) => run.id === workflowRunId)!.status).toBe("failed");
    expect(after.runs).toHaveLength(before.runs.length + 1);
    const replacement = after.runs.find((run) => run.id !== workflowRunId)!;
    expect(replacement.metadata).toMatchObject({ operatorDecisionRestart: {
      operatorDecisionId: card.id, sourceWorkflowRunId: workflowRunId,
    } });
    // blocked 였던 앵커 이슈는 재시작으로 재오픈(todo)된다.
    expect(after.issues.find((issue) => issue.id === anchorIssueId)!.status).toBe("todo");
    expect(after.activity.some((entry) => entry.action === "workflow_run.created"
      && entry.details?.operatorDecisionId === card.id)).toBe(true);
    // direct 재시작 경로는 continuation 을 만들지 않는다(기존 계약 유지).
    expect(after.continuations).toHaveLength(0);
    // 변조행(원본·해시 불일치) 홀드 회귀는 operator-decision-recovery-advice.integration.test.ts 의
    //   hashMismatchId 단언이 담당한다 — 여기서는 dead-target 바인딩 실행 계약만 검증한다.
  });
});
