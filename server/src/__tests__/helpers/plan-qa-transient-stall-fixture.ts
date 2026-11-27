// [s25-planqa-fix] PLAN-QA PASS 이후 일시적 assignee error 로 인한 영구 스톨 판정/무음 스톨 회귀 테스트의
// 공유 fixture(임베디드 PG, 저장소 격리, 시드·조회 헬퍼). 패턴은
// mission-plan-qa-pass-stale-planning-issue.test.ts 를 따른다.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { describe, expect, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  assets,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missionDelegations,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missions,
  plugins,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { hashOwnerPlanDecision } from "../../services/mission-owner-plan-decisions.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";
import { upsertMissionPlanDecisionSubmission } from "../../services/missions/mission-plan-decision-ledger.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";
import { setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

export function describeTransientStallDb(name: string, fn: () => void) {
  return embeddedPostgresSupport.supported ? describe(name, fn) : describe.skip(name, fn);
}

/** recordLatest 가 PLAN-QA manifest 를 StorageService 에 기록하므로 임시 디렉터리로 격리한다. */
export async function stubPlanQaLocalStorage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-planqa-transient-storage-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
  return async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  };
}

/** 실행 단위 1개(mission_plan_unit 소스, assignee 지정)로 assignee 상태 검증을 겨냥한다. */
export function decisionFor(missionId: string, executorAgentId: string, variant: 1 | 2 = 1) {
  return {
    missionId,
    missionGoal: "Ship controlled rollout",
    selectedExecutionUnits: [{
      id: `unit-${variant}`,
      kind: "mission_plan_unit",
      title: variant === 1 ? "Run smoke" : "Run smoke v2",
      reason: "source evidence",
      selectionState: "selected",
      assigneeAgentId: executorAgentId,
      sourceRef: { type: "mission_plan_unit", id: `unit-${variant}` },
    }],
    ruleRefs: ["rule:security"],
    kbRefs: ["kb:rollout"],
    requiredInputs: ["stagingUrl"],
    successCriteria: ["smoke passes"],
    steps: [{ id: "step-1", title: "Verify staging" }],
  };
}

export type TransientStallFixture = Awaited<ReturnType<typeof seedTransientStallFixture>>;

export async function seedTransientStallFixture(
  db: Db,
  opts: { planningIssueStatus?: string } = {},
): Promise<{
  companyId: string; ownerAgentId: string; qaAgentId: string; executorAgentId: string;
  missionId: string; planningIssueId: string;
}> {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const qaAgentId = randomUUID();
  const executorAgentId = randomUUID();
  const missionId = randomUUID();
  const planningIssueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "PlanQA Transient Company", issuePrefix: `PT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    { id: qaAgentId, companyId, name: "Report Validator", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    { id: executorAgentId, companyId, name: "Smoke Runner", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
  ]);
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId,
    title: "Plan QA transient stall mission",
    description: "Select an executable plan for the original business request.",
    status: "active",
  });
  await db.insert(issues).values({
    id: planningIssueId,
    companyId,
    missionId,
    title: "Mission owner planning",
    originKind: "mission_main_executor_plan",
    status: opts.planningIssueStatus ?? "todo",
    assigneeAgentId: ownerAgentId,
  });
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  return { companyId, ownerAgentId, qaAgentId, executorAgentId, missionId, planningIssueId };
}

export async function submitDecisionOnPlanningIssue(db: Db, opts: {
  companyId: string; missionId: string; planningIssueId: string;
  authorAgentId: string; executorAgentId: string; variant?: 1 | 2;
  status?: "submitted" | "plan_qa_pending" | "recorded";
}) {
  const decision = decisionFor(opts.missionId, opts.executorAgentId, opts.variant ?? 1);
  await upsertMissionPlanDecisionSubmission({
    db,
    companyId: opts.companyId,
    missionId: opts.missionId,
    planningIssueId: opts.planningIssueId,
    decision,
    decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
    authorAgentId: opts.authorAgentId,
    status: opts.status ?? "submitted",
  });
  return decision;
}

export async function readActivePlanQa(db: Db, companyId: string, missionId: string) {
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
  const refs = (plan?.refs ?? {}) as Record<string, unknown>;
  return {
    plan,
    planQa: refs.planQa as { issueId?: string; decisionHash?: string; status?: string } | undefined,
    paqoWorkflow: refs.paqoWorkflow as { workflowRunId?: string } | undefined,
  };
}

export async function recordPassVerdict(db: Db, companyId: string, missionId: string, qaAgentId: string) {
  const { planQa } = await readActivePlanQa(db, companyId, missionId);
  if (!planQa?.issueId || !planQa.decisionHash) throw new Error("no active PLAN-QA gate to verdict");
  await recordMissionPlanQaVerdict({
    db,
    companyId,
    missionId,
    planQaIssueId: planQa.issueId,
    decisionHash: planQa.decisionHash,
    verdict: "pass",
    diagnostics: [],
    reviewedBy: { actorType: "agent", actorId: qaAgentId },
  });
  return planQa;
}

export async function countMissionWorkflowRuns(db: Db, missionId: string) {
  const rows = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
  return rows.length;
}

export async function readLedgerRow(db: Db, companyId: string, missionId: string) {
  const [row] = await db
    .select({ status: missionPlanDecisionSubmissions.status, rejectionReason: missionPlanDecisionSubmissions.rejectionReason })
    .from(missionPlanDecisionSubmissions)
    .where(and(eq(missionPlanDecisionSubmissions.companyId, companyId), eq(missionPlanDecisionSubmissions.missionId, missionId)))
    .orderBy(desc(missionPlanDecisionSubmissions.createdAt), desc(missionPlanDecisionSubmissions.id))
    .limit(1);
  return row ?? null;
}

export async function readPlanningIssueRow(db: Db, companyId: string, missionId: string) {
  const [row] = await db
    .select({ id: issues.id, status: issues.status, description: issues.description })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.missionId, missionId), eq(issues.originKind, "mission_main_executor_plan")))
    .orderBy(desc(issues.createdAt), desc(issues.id))
    .limit(1);
  return row ?? null;
}

export async function readDeferredTransientActivity(db: Db, companyId: string, missionId: string) {
  const [row] = await db
    .select({ id: activityLog.id, action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "mission.owner_plan.deferred_transient"),
      eq(activityLog.entityType, "mission"),
      eq(activityLog.entityId, missionId),
    ))
    .limit(1);
  return row ?? null;
}

export async function setAgentStatus(db: Db, agentId: string, status: string) {
  await db.update(agents).set({ status }).where(eq(agents.id, agentId));
}

export async function cleanupTransientStallTables(db: Db) {
  await db.delete(activityLog);
  await db.delete(heartbeatRunEvents);
  await db.delete(heartbeatRuns);
  await db.delete(agentWakeupRequests);
  await db.delete(agentRuntimeState);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(missionDelegations);
  await db.delete(missionPlanArtifacts);
  await db.delete(missionPlanDecisionSubmissions);
  await db.delete(issueComments);
  await db.delete(issues);
  await db.delete(workflowDefinitions);
  await db.delete(plugins);
  await db.delete(missions);
  await db.delete(agents);
  await db.delete(assets);
  await db.delete(companies);
}

export async function startTransientStallDb(prefix: string) {
  const tempDb = await startEmbeddedPostgresTestDatabase(prefix);
  return { tempDb, db: createDb(tempDb.connectionString) };
}

export { expect, vi, setWorkflowToolStepExecutor };
