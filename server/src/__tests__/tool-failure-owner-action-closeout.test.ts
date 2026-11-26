// server/src/__tests__/tool-failure-owner-action-closeout.test.ts
//
// [purpose] 툴 스텝 실패로 만들어진 오너 액션 카드(`[Owner Action] Tool step failed`)의
//   "상황 해소 시 자동 종결" 검증.
//   (1) 링크된 스텝이 이후 completed — 카드 done(재시도/재실행 성공으로 대체됨).
//   (2) 런 completed — 남은 카드 done. (3) 런 cancelled(취소 정리 경로) — 카드 cancelled.
//   (4) 런 failed + 스텝 failed — 카드는 여전히 유효한 에스컬레이션이므로 유지.
//   (5) 툴 실패 카드가 아닌 오너 액션(source 복구 unblock), 다른 런의 카드, 숨김·이미 닫힌 카드,
//       일반 이슈는 건드리지 않는다. 감사 기록(link event)은 보존되고 코멘트·activity log 가 1회씩 남는다(멱등).

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { cancelWorkflowRunWithCleanup } from "../services/workflow/workflow-cancellation.js";
import {
  TOOL_FAILURE_OWNER_ACTION_SETTLED_ACTION,
  TOOL_RECOVERY_TARGET_EVENT_TYPE,
  classifyToolFailureOwnerActionCloseout,
  closeStaleToolFailureOwnerActions,
} from "../services/workflow/tool-failure-owner-action-closeout.js";

type Db = ReturnType<typeof createDb>;
type Tenant = { companyId: string; ownerId: string; missionId: string };
type Seed = Tenant & { runId: string; stepRunId: string; stepIssueId: string; sourceIssueId: string };

const UNBLOCK = "mission_main_executor_unblock";

describe("tool-failure owner action closeout verdict (pure)", () => {
  it("closes as done when the linked step completed, whatever the run status", () => {
    for (const runStatus of ["running", "failed", "completed", "cancelled"]) {
      expect(classifyToolFailureOwnerActionCloseout({ runStatus, stepRunStatus: "completed" }))
        .toEqual({ close: true, status: "done", reason: "step_completed" });
    }
  });

  it("closes as done when the run completed and as cancelled when the run was cancelled", () => {
    for (const stepRunStatus of ["failed", "skipped", "pending", null]) {
      expect(classifyToolFailureOwnerActionCloseout({ runStatus: "completed", stepRunStatus }))
        .toEqual({ close: true, status: "done", reason: "run_completed" });
    }
    expect(classifyToolFailureOwnerActionCloseout({ runStatus: "cancelled", stepRunStatus: "failed" }))
      .toEqual({ close: true, status: "cancelled", reason: "run_cancelled" });
  });

  it.each(["running", "failed", "aborted", "timed-out", "paused"])("keeps the card when the run is %s and the step is unresolved", (runStatus) => {
    for (const stepRunStatus of ["failed", "running", "pending", null]) {
      expect(classifyToolFailureOwnerActionCloseout({ runStatus, stepRunStatus })).toEqual({ close: false });
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip tool-failure owner action closeout tests: ${support.reason ?? "unsupported"}`);

async function seedTenant(db: Db, label: string): Promise<Tenant> {
  const companyId = randomUUID();
  const ownerId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({
    id: companyId, name: `${label} company`, issuePrefix: `TF${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: ownerId, companyId, name: `${label} owner`, role: "mission_owner", status: "active",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: `${label} mission`, status: "active" });
  return { companyId, ownerId, missionId };
}

async function addIssue(db: Db, tenant: Tenant, title: string, status: string, extra: Partial<typeof issues.$inferInsert> = {}) {
  const [row] = await db.insert(issues).values({
    companyId: tenant.companyId, missionId: tenant.missionId, title, status, assigneeAgentId: tenant.ownerId,
    ...(status === "done" ? { completedAt: new Date() } : {}),
    ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
    ...extra,
  }).returning({ id: issues.id });
  return row!.id;
}

async function addToolFailureCard(db: Db, tenant: Tenant, sourceIssueId: string, status = "todo", extra: Partial<typeof issues.$inferInsert> = {}) {
  return addIssue(db, tenant, "[Owner Action] Tool step failed: step-0", status, {
    originKind: UNBLOCK, originId: sourceIssueId, parentId: sourceIssueId, priority: "high", ...extra,
  });
}

async function linkCard(db: Db, tenant: Tenant, runId: string, stepRunId: string | null, cardId: string) {
  await db.insert(workflowTransitionEvents).values({
    companyId: tenant.companyId, missionId: tenant.missionId, issueId: cardId,
    workflowRunId: runId, workflowStepRunId: stepRunId, layer: "mission_owner_recovery",
    eventType: TOOL_RECOVERY_TARGET_EVENT_TYPE, idempotencyKey: `owner-tool-card-test:${randomUUID()}`,
    payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: runId, stepRunId },
  });
}

async function seedRun(db: Db, tenant: Tenant, stepStatus: string, issueStatus: string, runStatus = "running"): Promise<Seed> {
  const sourceIssueId = await addIssue(db, tenant, "oversight", "in_progress", { originKind: "mission_main_executor_oversight" });
  const stepIssueId = await addIssue(db, tenant, "tool step issue", issueStatus);
  const workflowId = randomUUID(), runId = randomUUID();
  await db.insert(workflowDefinitions).values({
    id: workflowId, companyId: tenant.companyId, name: `closeout-${runId}`,
    stepsJson: [{ id: "step-0", name: "Step 0", type: "agent", agentId: tenant.ownerId, dependencies: [] }],
  });
  await db.insert(workflowRuns).values({
    id: runId, workflowId, companyId: tenant.companyId, missionId: tenant.missionId, status: runStatus,
    triggeredBy: "test", startedAt: new Date(),
  });
  const [stepRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "step-0", issueId: stepIssueId, status: stepStatus,
    startedAt: stepStatus === "pending" ? null : new Date(),
    completedAt: ["completed", "failed"].includes(stepStatus) ? new Date() : null,
  }).returning({ id: workflowStepRuns.id });
  return { ...tenant, runId, stepRunId: stepRun!.id, stepIssueId, sourceIssueId };
}

async function readRun(db: Db, runId: string) {
  return (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
}

function runRef(seed: Seed, status: string) {
  return { id: seed.runId, status, companyId: seed.companyId, missionId: seed.missionId };
}

async function statuses(db: Db, ids: string[]) {
  const rows = await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, ids));
  return new Map(rows.map((row) => [row.id, row.status]));
}

async function closeoutRecords(db: Db, companyId: string, issueIds: string[]) {
  const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, issueIds));
  const activities = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, TOOL_FAILURE_OWNER_ACTION_SETTLED_ACTION),
  ));
  return { comments, activities };
}

describeDb("tool-failure owner action closeout", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("tool-failure-closeout-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("closes the card as done through workflow sync once the failed step's issue succeeds, idempotently", async () => {
    const seed = await seedRun(db, await seedTenant(db, "recovered"), "failed", "in_progress");
    const cardId = await addToolFailureCard(db, seed, seed.sourceIssueId);
    await linkCard(db, seed, seed.runId, seed.stepRunId, cardId);

    expect((await syncWorkflowRunState(db, seed.runId)).status).toBe("running");
    expect((await statuses(db, [cardId])).get(cardId)).toBe("todo");

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seed.stepIssueId));
    expect((await syncWorkflowRunState(db, seed.runId)).status).toBe("completed");
    expect((await statuses(db, [cardId])).get(cardId)).toBe("done");

    const first = await closeoutRecords(db, seed.companyId, [cardId]);
    expect(first.comments).toHaveLength(1);
    expect(first.comments[0]!.body).toContain("superseded");
    expect(first.activities).toHaveLength(1);
    expect(first.activities[0]!.details).toEqual(expect.objectContaining({
      reason: "step_completed", previousStatus: "todo", nextStatus: "done", workflowRunId: seed.runId, stepRunIds: [seed.stepRunId],
    }));
    // Audit trail: the structural link that identified the card is preserved.
    const links = await db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.issueId, cardId), eq(workflowTransitionEvents.eventType, TOOL_RECOVERY_TARGET_EVENT_TYPE)));
    expect(links).toHaveLength(1);

    await syncWorkflowRunState(db, seed.runId);
    const second = await closeoutRecords(db, seed.companyId, [cardId]);
    expect(second.comments).toHaveLength(1);
    expect(second.activities).toHaveLength(1);
  });

  it("cancels the card when the run is cancelled and keeps it when the run fails with the step unresolved", async () => {
    const cancelled = await seedRun(db, await seedTenant(db, "cancelled"), "failed", "in_progress");
    const cancelledCard = await addToolFailureCard(db, cancelled, cancelled.sourceIssueId, "blocked");
    await linkCard(db, cancelled, cancelled.runId, cancelled.stepRunId, cancelledCard);
    const failed = await seedRun(db, await seedTenant(db, "failed"), "failed", "cancelled");
    const failedCard = await addToolFailureCard(db, failed, failed.sourceIssueId);
    await linkCard(db, failed, failed.runId, failed.stepRunId, failedCard);

    expect(await cancelWorkflowRunWithCleanup(db, cancelled.runId, cancelled.companyId)).toBe(true);
    expect((await readRun(db, cancelled.runId)).status).toBe("cancelled");
    expect((await syncWorkflowRunState(db, failed.runId)).status).toBe("failed");
    expect((await statuses(db, [cancelledCard, failedCard])).get(cancelledCard)).toBe("cancelled");
    expect((await statuses(db, [cancelledCard, failedCard])).get(failedCard)).toBe("todo");

    const records = await closeoutRecords(db, cancelled.companyId, [cancelledCard]);
    expect(records.activities.map((activity) => activity.details?.reason)).toEqual(["run_cancelled"]);
  });

  it("closes as done when the run completed even if the step was skipped", async () => {
    const seed = await seedRun(db, await seedTenant(db, "skipped"), "skipped", "done");
    const cardId = await addToolFailureCard(db, seed, seed.sourceIssueId);
    await linkCard(db, seed, seed.runId, seed.stepRunId, cardId);

    const result = await closeStaleToolFailureOwnerActions({
      db, run: runRef(seed, "completed"),
      stepRuns: [{ id: seed.stepRunId, workflowRunId: seed.runId, status: "skipped" }],
    });
    expect(result.closed).toEqual([{ issueId: cardId, previousStatus: "todo", status: "done", reason: "run_completed" }]);
  });

  it("leaves source-unblock owner actions, other-run cards, hidden, already-closed cards and plain issues untouched", async () => {
    const tenant = await seedTenant(db, "scope");
    const current = await seedRun(db, tenant, "completed", "done");
    const other = await seedRun(db, await seedTenant(db, "scope-other"), "completed", "done");
    const closed = await addToolFailureCard(db, tenant, current.sourceIssueId);
    await linkCard(db, tenant, current.runId, current.stepRunId, closed);
    const sourceUnblock = await addIssue(db, tenant, "source unblock", "todo", { originKind: UNBLOCK, originId: current.sourceIssueId });
    const otherRunCard = await addToolFailureCard(db, tenant, current.sourceIssueId);
    await linkCard(db, tenant, other.runId, other.stepRunId, otherRunCard);
    const hidden = await addToolFailureCard(db, tenant, current.sourceIssueId, "todo", { hiddenAt: new Date() });
    await linkCard(db, tenant, current.runId, current.stepRunId, hidden);
    const alreadyDone = await addToolFailureCard(db, tenant, current.sourceIssueId, "done");
    await linkCard(db, tenant, current.runId, current.stepRunId, alreadyDone);
    const plainIssue = await addIssue(db, tenant, "plain issue", "todo");

    const result = await closeStaleToolFailureOwnerActions({
      db, run: runRef(current, "completed"),
      stepRuns: [{ id: current.stepRunId, workflowRunId: current.runId, status: "completed" }],
    });
    expect(result.closed.map((entry) => entry.issueId)).toEqual([closed]);

    const rows = await statuses(db, [closed, sourceUnblock, otherRunCard, hidden, alreadyDone, plainIssue]);
    expect(rows.get(closed)).toBe("done");
    expect(rows.get(sourceUnblock)).toBe("todo");
    expect(rows.get(otherRunCard)).toBe("todo");
    expect(rows.get(hidden)).toBe("todo");
    expect(rows.get(alreadyDone)).toBe("done");
    expect(rows.get(plainIssue)).toBe("todo");
  });

  it("returns nothing for a run without a mission and keeps unresolved cards for a running run", async () => {
    const tenant = await seedTenant(db, "guards");
    const seed = await seedRun(db, tenant, "failed", "in_progress");
    const cardId = await addToolFailureCard(db, seed, seed.sourceIssueId);
    await linkCard(db, seed, seed.runId, seed.stepRunId, cardId);

    expect(await closeStaleToolFailureOwnerActions({
      db, run: { ...runRef(seed, "completed"), missionId: null }, stepRuns: [],
    })).toEqual({ closed: [] });
    expect(await closeStaleToolFailureOwnerActions({
      db, run: runRef(seed, "running"), stepRuns: [{ id: seed.stepRunId, workflowRunId: seed.runId, status: "failed" }],
    })).toEqual({ closed: [] });
    expect(await closeStaleToolFailureOwnerActions({
      db, run: runRef(seed, "failed"), stepRuns: [{ id: seed.stepRunId, workflowRunId: seed.runId, status: "failed" }],
    })).toEqual({ closed: [] });
    expect((await statuses(db, [cardId])).get(cardId)).toBe("todo");
  });
});
