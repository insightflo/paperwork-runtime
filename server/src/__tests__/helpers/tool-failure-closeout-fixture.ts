// server/src/__tests__/helpers/tool-failure-closeout-fixture.ts
//
// [purpose] 툴 실패 오너 액션 종결 테스트(`tool-failure-owner-action-closeout*.test.ts`)의 공유 픽스처.
//   임베디드 PG 라이프사이클(startEmbeddedPostgresTestDatabase)은 각 테스트 파일이 소유한다.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions,
  operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  TOOL_FAILURE_OWNER_ACTION_SETTLED_ACTION,
  TOOL_RECOVERY_TARGET_EVENT_TYPE,
} from "../../services/workflow/tool-failure-owner-action-closeout.js";

export type Db = ReturnType<typeof createDb>;
export type Tenant = { companyId: string; ownerId: string; missionId: string };
export type Seed = Tenant & { runId: string; stepRunId: string; stepIssueId: string; sourceIssueId: string };

export const UNBLOCK = "mission_main_executor_unblock";

export async function seedTenant(db: Db, label: string): Promise<Tenant> {
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

export async function addIssue(db: Db, tenant: Tenant, title: string, status: string, extra: Partial<typeof issues.$inferInsert> = {}) {
  const [row] = await db.insert(issues).values({
    companyId: tenant.companyId, missionId: tenant.missionId, title, status, assigneeAgentId: tenant.ownerId,
    ...(status === "done" ? { completedAt: new Date() } : {}),
    ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
    ...extra,
  }).returning({ id: issues.id });
  return row!.id;
}

export async function addToolFailureCard(db: Db, tenant: Tenant, sourceIssueId: string, status = "todo", extra: Partial<typeof issues.$inferInsert> = {}) {
  return addIssue(db, tenant, "[Owner Action] Tool step failed: step-0", status, {
    originKind: UNBLOCK, originId: sourceIssueId, parentId: sourceIssueId, priority: "high", ...extra,
  });
}

export async function linkCard(db: Db, tenant: Tenant, runId: string, stepRunId: string | null, cardId: string) {
  await db.insert(workflowTransitionEvents).values({
    companyId: tenant.companyId, missionId: tenant.missionId, issueId: cardId,
    workflowRunId: runId, workflowStepRunId: stepRunId, layer: "mission_owner_recovery",
    eventType: TOOL_RECOVERY_TARGET_EVENT_TYPE, idempotencyKey: `owner-tool-card-test:${randomUUID()}`,
    payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: runId, stepRunId },
  });
}

/** 사람 입력 카드(operator decision) — 앵커는 `issueId`(오너 액션 카드 이스)다. */
export async function addDecision(db: Db, tenant: Tenant, issueId: string, extra: Partial<typeof operatorDecisions.$inferInsert> = {}) {
  const [row] = await db.insert(operatorDecisions).values({
    companyId: tenant.companyId, requestKey: `od:${randomUUID()}`, requestHash: randomUUID(), interactionType: "single_select",
    title: "pick one", sourceType: "mission_owner_human_input", sourceId: randomUUID(), issueId,
    sourceContext: { missionId: tenant.missionId, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition: { options: [], actions: [], selection: null, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
      approvedScope: [], forbiddenScope: [] },
    ...extra,
  }).returning();
  return row!;
}

export async function decisionStatuses(db: Db, ids: string[]) {
  const rows = await db.select({ id: operatorDecisions.id, status: operatorDecisions.status, cancelledAt: operatorDecisions.cancelledAt })
    .from(operatorDecisions).where(inArray(operatorDecisions.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function seedRun(db: Db, tenant: Tenant, stepStatus: string, issueStatus: string, runStatus = "running"): Promise<Seed> {
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

export async function readRun(db: Db, runId: string) {
  return (await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
}

export function runRef(seed: Seed, status: string) {
  return { id: seed.runId, status, companyId: seed.companyId, missionId: seed.missionId };
}

export async function statuses(db: Db, ids: string[]) {
  const rows = await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, ids));
  return new Map(rows.map((row) => [row.id, row.status]));
}

export async function closeoutRecords(db: Db, companyId: string, issueIds: string[]) {
  const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, issueIds));
  const activities = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.action, TOOL_FAILURE_OWNER_ACTION_SETTLED_ACTION),
  ));
  return { comments, activities };
}
