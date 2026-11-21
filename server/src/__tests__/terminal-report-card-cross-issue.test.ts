// [교차 이슈 회귀 2026-11-21] mission.owner.human_input_card_failed 132건(422
// owner_human_target_scope_unproven) 재현: terminal report 결정 이벤트가 claim 당시의
// owner-action 이슈에 묶인 채 남고, supervision 이 새 owner-action 이슈를 고르면
// snapshot-already-reported 재사용으로 카드가 새 이슈에 붙어 이벤트 issue_id 와 어긋난다.
//   - 양성: 이벤트 이슈(이전 owner-action, 종결)와 카드 앵커(현재 owner-action)가 달라도
//     결속이 증명되면 카드가 생성돼야 한다.
//   - 음성: 다른 moi1 생산자(owner-decision/dead-target)의 교차 이슈와, owner-action 이
//     아닌 이슈에 묶인 terminal 이벤트는 여전히 거부돼야 한다(위조 방지 유지).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  operatorDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { emitTerminalMissionHumanOperatorReport } from "../services/missions/terminal-mission-human-operator-alert.js";
import {
  createMissionOwnerHumanInputDecisionCard,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
} from "../services/missions/mission-owner-human-input-card.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const REPORT_EVENT_TYPE = "terminal_mission_human_operator_report";
const CARD_FAILED_ACTION = "mission.owner.human_input_card_failed";

type Seed = {
  companyId: string;
  ownerAgentId: string;
  workerAgentId: string;
  missionId: string;
  sourceAId: string;
  sourceBId: string;
  ownerActionAId: string;
  ownerActionBId: string;
  failedRunId: string;
};

async function seed(db: ReturnType<typeof createDb>): Promise<Seed> {
  const s: Seed = {
    companyId: randomUUID(), ownerAgentId: randomUUID(), workerAgentId: randomUUID(),
    missionId: randomUUID(), sourceAId: randomUUID(), sourceBId: randomUUID(),
    ownerActionAId: randomUUID(), ownerActionBId: randomUUID(), failedRunId: randomUUID(),
  };
  await db.insert(companies).values({
    id: s.companyId, name: "Cross-issue Co", issuePrefix: randomUUID(),
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    { id: s.ownerAgentId, companyId: s.companyId, name: "Mission Owner", role: "operator", status: "active" },
    { id: s.workerAgentId, companyId: s.companyId, name: "Worker", role: "writer", status: "active" },
  ]);
  await db.insert(missions).values({
    id: s.missionId, companyId: s.companyId, ownerAgentId: s.ownerAgentId,
    title: "Cross-issue mission", status: "active",
  });
  await db.insert(issues).values([
    { id: s.sourceAId, companyId: s.companyId, missionId: s.missionId, title: "Source A",
      status: "blocked", assigneeAgentId: s.workerAgentId, originKind: "workflow_execution" },
    { id: s.sourceBId, companyId: s.companyId, missionId: s.missionId, title: "Source B",
      status: "blocked", assigneeAgentId: s.workerAgentId, originKind: "workflow_execution" },
    { id: s.ownerActionAId, companyId: s.companyId, missionId: s.missionId, title: "[Unblock] A",
      identifier: `T-${s.ownerActionAId.slice(0, 8)}`, status: "blocked", assigneeAgentId: s.ownerAgentId,
      originKind: "mission_main_executor_unblock", originId: s.sourceAId },
    { id: s.ownerActionBId, companyId: s.companyId, missionId: s.missionId, title: "[Owner Action] B",
      identifier: `T-${s.ownerActionBId.slice(0, 8)}`, status: "blocked", assigneeAgentId: s.ownerAgentId,
      originKind: "mission_main_executor_unblock", originId: s.sourceBId },
  ]);
  await db.insert(heartbeatRuns).values({
    id: s.failedRunId, companyId: s.companyId, agentId: s.ownerAgentId, issueId: s.ownerActionAId,
    status: "failed", errorCode: "process_lost", error: "crash",
    startedAt: new Date("2026-07-01T00:01:00.000Z"), finishedAt: new Date("2026-07-01T00:02:00.000Z"),
  });
  return s;
}

describeDb("terminal report card — cross-issue owner-action anchor", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-card-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(operatorDecisions);
    await db.delete(workflowTransitionEvents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  const emit = (s: Seed, issueId: string, originId: string, identifier: string) =>
    emitTerminalMissionHumanOperatorReport(db, {
      issue: {
        id: issueId, companyId: s.companyId, missionId: s.missionId,
        originKind: "mission_main_executor_unblock", originId,
        title: "[Unblock]", identifier,
      },
      expectedCompanyId: s.companyId,
      expectedMissionId: s.missionId,
      missionTitle: "m",
      sourceIssueIdentifier: "S",
      workflowRunId: null,
      failedRuns: [{ id: s.failedRunId, status: "failed", errorCode: "process_lost" }],
    });

  it("re-anchors the card on the current owner-action issue when the stored event's issue closed", async () => {
    const s = await seed(db);

    const first = await emit(s, s.ownerActionAId, s.sourceAId, `T-${s.ownerActionAId.slice(0, 8)}`);
    expect(first).toMatchObject({ emitted: true, card: { ensured: true, reason: "card-created" } });
    const [reportEvent] = await db
      .select({ id: workflowTransitionEvents.id, issueId: workflowTransitionEvents.issueId })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.eventType, REPORT_EVENT_TYPE));
    expect(reportEvent!.issueId).toBe(s.ownerActionAId);

    // 카드 유실(브리지 없던 배포) + owner-action 교체 — 실패 폭주의 실제 조건.
    await db.delete(operatorDecisions).where(eq(operatorDecisions.companyId, s.companyId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.ownerActionAId));

    const second = await emit(s, s.ownerActionBId, s.sourceBId, `T-${s.ownerActionBId.slice(0, 8)}`);
    expect(second).toMatchObject({
      emitted: false,
      reason: "snapshot-already-reported",
      decisionEventId: reportEvent!.id,
      card: { ensured: true, reason: "card-created" },
    });

    const cards = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, s.companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      requestKey: `moi1:${reportEvent!.id}`,
      sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
      sourceId: reportEvent!.id,
      issueId: s.ownerActionBId,
      requestedByAgentId: s.ownerAgentId,
      status: "pending",
    });
    const failures = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, s.companyId),
      eq(activityLog.action, CARD_FAILED_ACTION),
    ));
    expect(failures).toHaveLength(0);
  });

  const cardSpec = (s: Seed, issueId: string, decisionEventId: string) => ({
    companyId: s.companyId,
    missionId: s.missionId,
    decisionEventId,
    decision: "escalate" as const,
    ownerActionIssueId: issueId,
    ownerActionIssueStatus: "blocked",
    requestedByAgentId: s.ownerAgentId,
    actorType: "system" as const,
    reason: "terminal failure",
    nextAction: "choose a recovery path",
    evidence: "failed-runs=failed",
  });

  it("still rejects a cross-issue card for owner-decision events (strict producer unchanged)", async () => {
    const s = await seed(db);
    const heartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatId, companyId: s.companyId, agentId: s.ownerAgentId,
      issueId: s.ownerActionAId, status: "succeeded",
      startedAt: new Date(), finishedAt: new Date(),
    });
    const [event] = await db.insert(workflowTransitionEvents).values({
      companyId: s.companyId,
      missionId: s.missionId,
      issueId: s.ownerActionAId,
      heartbeatRunId: heartbeatId,
      eventType: "mission_owner_decision",
      layer: "mission_owner_recovery",
      decision: "escalate",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `owner-decision:test:${randomUUID()}`,
      payload: {
        kind: "mission_owner_decision",
        source: "owner_recovery_api",
        ownerActionIssueId: s.ownerActionAId,
        sourceIssueId: s.sourceAId,
        decision: "escalate",
      },
    }).returning({ id: workflowTransitionEvents.id });

    await expect(createMissionOwnerHumanInputDecisionCard(db, cardSpec(s, s.ownerActionBId, event!.id)))
      .rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "owner_human_target_scope_unproven" }),
      });
  });

  it("still rejects a cross-issue card for dead-target escalation events (strict producer unchanged)", async () => {
    const s = await seed(db);
    const [event] = await db.insert(workflowTransitionEvents).values({
      companyId: s.companyId,
      missionId: s.missionId,
      issueId: s.ownerActionAId,
      eventType: "mission_owner_dead_target_escalation",
      layer: "mission_owner_recovery",
      toStatus: "escalated",
      decision: "escalate",
      reason: "dead target",
      reasonCode: "mission_owner_dead_target_escalation",
      correlationId: s.ownerActionAId,
      idempotencyKey: `dead-target:test:${randomUUID()}`,
      payload: {
        kind: "mission_owner_dead_target_escalation",
        ownerActionIssueId: s.ownerActionAId,
        anchorIssueId: s.ownerActionAId,
        sourceIssueId: s.sourceAId,
        loopKey: "retry_source_issue",
      },
    }).returning({ id: workflowTransitionEvents.id });

    await expect(createMissionOwnerHumanInputDecisionCard(db, cardSpec(s, s.ownerActionBId, event!.id)))
      .rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "owner_human_target_scope_unproven" }),
      });
  });

  it("rejects a terminal report event whose recorded issue is not an owner-action issue", async () => {
    const s = await seed(db);
    const [forged] = await db.insert(workflowTransitionEvents).values({
      companyId: s.companyId,
      missionId: s.missionId,
      issueId: s.sourceAId,
      eventType: REPORT_EVENT_TYPE,
      layer: "workflow_validation",
      fromStatus: "failed",
      toStatus: "blocked",
      decision: "escalate",
      reason: "terminal_mission_no_continuation",
      reasonCode: REPORT_EVENT_TYPE,
      correlationId: s.sourceAId,
      idempotencyKey: `terminal-mission-report:test:${randomUUID()}`,
      payload: {
        ownerActionIssueId: s.sourceAId,
        workflowRunId: null,
        failedRuns: [{ id: s.failedRunId, status: "failed", errorCode: null }],
        status: "reported",
      },
    }).returning({ id: workflowTransitionEvents.id });

    await expect(createMissionOwnerHumanInputDecisionCard(db, cardSpec(s, s.ownerActionBId, forged!.id)))
      .rejects.toMatchObject({
        status: 422,
        details: expect.objectContaining({ code: "owner_human_target_scope_unproven" }),
      });
  });
});
