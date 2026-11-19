/**
 * [purpose] B5(2026-11-16 실운영 확증): 종결(done/cancelled) 앵커 이슈에 묶인 mission_owner_human_input
 *   카드 처리 계약.
 *   - 스윕(sweepTerminalAnchorDeadCards): pending + 종결 앵커 + safety window(60초) 경과 카드만
 *     operator_decision.cancelled(reason anchor-issue-terminal)로 시스템 취소한다. 활성 앵커,
 *     앵커 없음(issueId null), 윈도우 이내 종결, 비-moi 카드, 비-pending 카드는 쓰지 않는다.
 *   - resolve 가드: 종결 앵커 카드의 승인(approve)은 결정 기록만 남기고 승인 파생(revision run)을
 *     실행하지 않는다 — operator_decision.approved_revision_skipped 에 사유를 남긴다.
 *     활성 앵커 대조군은 파생이 실제 workflowRuns 행을 만든다(가드가 정당한 시작을 막지 않음).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { DEAD_CARD_SWEEP_ACTOR_ID, sweepTerminalAnchorDeadCards } from "../services/operator-decision-dead-card-sweep.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skip dead-card sweep tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const SAFETY_WINDOW_MS = 60_000;
const APPROVE_BODY = { actionId: "approve", selectedOptionIds: ["approve"], comment: null };
const PLAN_HASH = "b".repeat(64);

const approveDefinition = {
  options: [{ id: "approve", label: "Approve", description: null, facts: [], evidenceRefs: [] }],
  actions: [
    { id: "approve", label: "Approve", outcome: "approve" as const, tone: "primary" as const, requiresSelection: true },
    { id: "hold", label: "Hold", outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false },
  ],
  selection: { min: 1, max: 1 },
  comment: { mode: "optional" as const, label: "Note", placeholder: null, maxLength: 100 },
  approvedScope: ["internal"],
  forbiddenScope: ["external"],
  humanReview: {
    schemaVersion: "human-review-v1" as const,
    decisionSubject: "Choose the next operation",
    evidence: [{ label: "Linked work", href: "/issues/fixture", location: "Issue detail > evidence" }],
    interpretation: "The operator must choose one bounded continuation.",
    impact: { ifApproved: "The selected continuation runs.", ifRejected: "The continuation remains stopped.", ifWrong: "The wrong continuation could run." },
    unresolvedFacts: [], questions: ["Is the selected continuation correct?"],
    recommendedNextStep: "Open the linked work, verify the evidence, and decide.", requiredReviewer: "Human Operator",
  },
};

describeEmbeddedPostgres("terminal-anchor dead card handling", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let missionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("terminal-anchor-card-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(issueComments);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(missionPlanQaVerdicts);
    await db.delete(missionPlanArtifacts);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    agentId = randomUUID();
    missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "AnchorCo", issuePrefix: `A${companyId.slice(0, 4)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Live mission", status: "active" });
  });

  async function seedAnchor(options: { status: string; terminalAge?: "old" | "fresh" }) {
    const issueId = randomUUID();
    const updatedAt = options.terminalAge === "fresh"
      ? new Date()
      : new Date(Date.now() - SAFETY_WINDOW_MS - 60_000);
    await db.insert(issues).values({
      id: issueId, companyId, missionId, title: "Owner action", status: options.status,
      assigneeAgentId: agentId, updatedAt,
    });
    return issueId;
  }

  async function insertCard(options: {
    issueId: string | null;
    status?: "pending" | "resolved" | "cancelled";
    sourceType?: string;
  }) {
    const cardId = randomUUID();
    const status = options.status ?? "pending";
    await db.insert(operatorDecisions).values({
      id: cardId, companyId, requestKey: randomUUID(), requestHash: "hash", status,
      interactionType: "single_select", title: "Human input", description: "",
      sourceType: options.sourceType ?? "mission_owner_human_input", sourceId: randomUUID(),
      sourceContext: { missionId, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId: options.issueId,
      definition: approveDefinition,
      continuationMode: "issue_current_assignee",
      requestedByAgentId: agentId,
      ...(status === "resolved" ? {
        result: { actionId: "approve", outcome: "approve", selectedOptionIds: ["approve"], comment: null },
        resolvedByUserId: "board", resolvedAt: new Date(),
      } : {}),
      ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
    });
    return cardId;
  }

  const cardRow = (id: string) => db.select().from(operatorDecisions)
    .where(eq(operatorDecisions.id, id)).then((rows) => rows[0] ?? null);
  const cardActivities = (id: string) => db.select().from(activityLog).where(eq(activityLog.entityId, id));

  describe("terminal-anchor dead card sweep", () => {
    it.each(["done", "cancelled"] as const)("cancels a pending moi card on a %s anchor with sweep-authored activity", async (terminalStatus) => {
      const anchorId = await seedAnchor({ status: terminalStatus });
      const cardId = await insertCard({ issueId: anchorId });
      const now = new Date();

      await expect(sweepTerminalAnchorDeadCards(db, now)).resolves.toEqual({ checked: 1, cancelled: 1 });

      expect(await cardRow(cardId)).toMatchObject({ status: "cancelled", cancelledAt: now });
      const [cancelActivity] = (await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled");
      expect(cancelActivity).toMatchObject({ actorType: "user", actorId: DEAD_CARD_SWEEP_ACTOR_ID });
      expect(cancelActivity?.details).toMatchObject({
        cancelledByActorType: "user",
        cancelledByActorId: DEAD_CARD_SWEEP_ACTOR_ID,
        reason: "anchor-issue-terminal",
        issueId: anchorId,
        issueStatus: terminalStatus,
        missionId,
      });
      // 두 번째 스윕은 멱등 — 추가 취소·감사 기록이 생기지 않는다.
      await expect(sweepTerminalAnchorDeadCards(db, now)).resolves.toEqual({ checked: 0, cancelled: 0 });
      expect((await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled")).toHaveLength(1);
    });

    it("keeps a pending moi card whose anchor issue is still active", async () => {
      const anchorId = await seedAnchor({ status: "in_progress" });
      const cardId = await insertCard({ issueId: anchorId });
      await expect(sweepTerminalAnchorDeadCards(db, new Date())).resolves.toEqual({ checked: 0, cancelled: 0 });
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
    });

    it("keeps a pending moi card without an anchor issue", async () => {
      const cardId = await insertCard({ issueId: null });
      await expect(sweepTerminalAnchorDeadCards(db, new Date())).resolves.toEqual({ checked: 0, cancelled: 0 });
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
    });

    it("keeps a pending moi card whose anchor went terminal inside the safety window", async () => {
      const anchorId = await seedAnchor({ status: "done", terminalAge: "fresh" });
      const cardId = await insertCard({ issueId: anchorId });
      await expect(sweepTerminalAnchorDeadCards(db, new Date())).resolves.toEqual({ checked: 0, cancelled: 0 });
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
      // 창을 지나면 다음 틱에서 회수된다.
      await expect(sweepTerminalAnchorDeadCards(db, new Date(Date.now() + SAFETY_WINDOW_MS + 1_000)))
        .resolves.toEqual({ checked: 1, cancelled: 1 });
    });

    it("keeps a pending non-moi card on a terminal anchor (stale sweep's contract)", async () => {
      const anchorId = await seedAnchor({ status: "done" });
      const cardId = await insertCard({ issueId: anchorId, sourceType: "workflow_step" });
      await expect(sweepTerminalAnchorDeadCards(db, new Date())).resolves.toEqual({ checked: 0, cancelled: 0 });
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
    });

    it("keeps an already-resolved moi card on a terminal anchor", async () => {
      const anchorId = await seedAnchor({ status: "done" });
      const cardId = await insertCard({ issueId: anchorId, status: "resolved" });
      await expect(sweepTerminalAnchorDeadCards(db, new Date())).resolves.toEqual({ checked: 0, cancelled: 0 });
      expect(await cardRow(cardId)).toMatchObject({ status: "resolved" });
      expect(await cardActivities(cardId)).toHaveLength(0);
    });
  });

  describe("resolve terminal-anchor guard", () => {
    /** 승인=시작 계약의 board-wait 상태를 만든다(수정 미션 + 통과한 계획 검토 + paqo 정의). */
    async function seedRevisionWait() {
      const sourceMissionId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(missions).values({ id: sourceMissionId, companyId, ownerAgentId: agentId, title: "Source", status: "completed" });
      await db.insert(missions).values({ id: revisionId, companyId, ownerAgentId: agentId, title: "Revision", status: "active", sourceMissionId });
      const [definition] = await db.insert(workflowDefinitions).values({
        companyId, missionId: revisionId, name: "Revision", sourceKind: "paqo",
        definitionHash: "a".repeat(64),
        stepsJson: [{ id: "write", name: "Write", type: "agent", agentId, dependencies: [] }],
      }).returning();
      const qaIssueId = randomUUID();
      await db.insert(issues).values({ id: qaIssueId, companyId, missionId: revisionId, title: "QA", status: "done" });
      await db.insert(missionPlanArtifacts).values({
        companyId, missionId: revisionId, revision: 1, ownerAgentId: agentId, missionGoal: "revise", status: "active",
        refs: {
          ownerPlanDecision: { decisionHash: PLAN_HASH },
          planQa: { issueId: qaIssueId, decisionHash: PLAN_HASH },
          paqoWorkflow: { workflowDefinitionId: definition.id, decisionHash: PLAN_HASH },
        },
      });
      await db.insert(missionPlanQaVerdicts).values({
        companyId, missionId: revisionId, planQaIssueId: qaIssueId, decisionHash: PLAN_HASH,
        verdict: "pass", reviewerUserId: "local-board",
      });
      return { revisionId };
    }

    async function createApprovalCard(anchorId: string, revisionId: string) {
      const service = operatorDecisionWriteService(db);
      return service.create(companyId, {
        schemaVersion: 1 as const,
        requestKey: `moi1:anchor-guard-${randomUUID()}`,
        priority: "high" as const,
        interactionType: "single_select" as const,
        title: "Revision approval",
        description: "Approve the revised plan",
        sourceType: "mission_owner_human_input",
        sourceId: randomUUID(),
        sourceContext: { missionId: revisionId, workflowId: null, workflowRunId: null, artifactRefs: [] },
        definition: approveDefinition,
        issueId: anchorId,
        continuationMode: "issue_current_assignee" as const,
      }, { type: "agent", id: agentId });
    }

    const revisionRuns = (revisionId: string) => db.select().from(workflowRuns)
      .where(eq(workflowRuns.missionId, revisionId));

    it("records the approval on a terminal-anchor card but skips the derived revision start", async () => {
      const { revisionId } = await seedRevisionWait();
      const anchorId = await seedAnchor({ status: "done" });
      const created = await createApprovalCard(anchorId, revisionId);

      const resolved = await operatorDecisionWriteService(db).resolve(created.decision.id, APPROVE_BODY, "board");
      expect(resolved).toMatchObject({ applied: true, decision: { status: "resolved" } });

      // continuation 은 resolve 트랜잭션에서 이미 issue_terminal 로 막힌다(기존 계약 재확인).
      expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
      expect(await db.select().from(operatorDecisionContinuations).then((rows) => rows[0]))
        .toMatchObject({ state: "blocked", errorCode: "issue_terminal" });
      // 승인 파생(revision run)은 시작되지 않고 스킵 사유만 남는다.
      expect(await revisionRuns(revisionId)).toHaveLength(0);
      const activities = await cardActivities(created.decision.id);
      const [skipped] = activities.filter((row) => row.action === "operator_decision.approved_revision_skipped");
      expect(skipped?.details).toMatchObject({
        reason: "anchor-issue-terminal", issueId: anchorId, issueStatus: "done", missionId: revisionId,
      });
      expect(activities.filter((row) => row.action === "operator_decision.continuation_blocked")).toHaveLength(1);
      expect(activities.filter((row) => row.action === "operator_decision.resolved")).toHaveLength(1);
    });

    it("starts the derived revision run for the same approval on a live anchor (guard is not a blanket block)", async () => {
      const { revisionId } = await seedRevisionWait();
      const anchorId = await seedAnchor({ status: "in_progress" });
      const created = await createApprovalCard(anchorId, revisionId);

      const resolved = await operatorDecisionWriteService(db).resolve(created.decision.id, APPROVE_BODY, "board");
      expect(resolved).toMatchObject({ applied: true });

      // 파생은 커밋 후 비동기(void)로 시작된다 — 내구 행이 생길 때까지 짧게 기다린다.
      let runs = await revisionRuns(revisionId);
      for (let attempt = 0; attempt < 50 && runs.length === 0; attempt += 1) {
        await new Promise((sleep) => setTimeout(sleep, 100));
        runs = await revisionRuns(revisionId);
      }
      expect(runs).toHaveLength(1);
      const activities = await cardActivities(created.decision.id);
      expect(activities.filter((row) => row.action === "operator_decision.approved_revision_skipped")).toHaveLength(0);
    });
  });
});
