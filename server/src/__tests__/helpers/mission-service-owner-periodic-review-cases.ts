import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";

// [2026-11-22 주기 리뷰 게이트 회귀] 미션 상대 경과 버킷(월클록 동기 깨움/55P03 제거),
//   30분 초기 유예(신생 즉시 발화 금지), 건강 진행 중 스킵(살아 있는 하트비트 + 열린
//   오너 액션 0 + 실패/블록 단위 0) 검증. 시드의 mission.createdAt 을 명시해 경과를 통제한다.
export function registerMissionOwnerPeriodicReviewCases(getDb: () => ReturnType<typeof createDb>) {
  async function seedPeriodicReviewMission(
    db: ReturnType<typeof createDb>,
    input: { missionCreatedAt: Date; runStatus: string; stepStatus: string; issueStatus?: string; issuePrefix?: string },
  ) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Periodic Review Company", issuePrefix: `${input.issuePrefix ?? "PR"}${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Periodic review mission", status: "active", createdAt: input.missionCreatedAt, startedAt: input.missionCreatedAt });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "periodic-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: input.runStatus, startedAt: input.missionCreatedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: input.issueStatus ?? "in_progress", title: "Produce report" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: input.stepStatus, startedAt: input.missionCreatedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] periodic-review" });
    return { companyId, ownerAgentId, workerAgentId, missionId, workflowRunId, producerIssue };
  }

  it("does not wake a brand-new mission during the initial 30-minute grace period", async () => {
    const db = getDb();
    const f = await seedPeriodicReviewMission(db, {
      missionCreatedAt: new Date("2026-08-18T10:00:00.000Z"),
      runStatus: "running",
      stepStatus: "running",
    });
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();
    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });

    // 생성 1분 뒤(구 월클록 버킷은 즉시 발화했음)와 유예 직전 29분 뒤 — 둘 다 깨우지 않는다.
    await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:01:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:29:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onMissionOwnerPeriodicReviewWakeRequested).not.toHaveBeenCalled();
  });

  it("wakes a stalled mission on mission-relative buckets (bucket-idempotent)", async () => {
    const db = getDb();
    const f = await seedPeriodicReviewMission(db, {
      missionCreatedAt: new Date("2026-08-18T09:00:00.000Z"),
      runStatus: "running",
      stepStatus: "running",
    });
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();
    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });

    // 살아 있는 하트비트가 없는 정체 미션 — 경과 67분(미션 기준 버킷 2)에서 1회 깨움.
    const first = await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:07:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: f.missionId }),
      inFlightUnitLabels: expect.arrayContaining([`native_workflow_run:${f.workflowRunId}:running`]),
    }));

    // 같은 미션 상대 버킷 안의 두 번째 스윕 → 멱등, 추가 깨움 없음.
    const second = await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:12:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);

    // 미션 생성 시각 기준 다음 30분 버킷(경과 98분 → 버킷 3) → 다시 1회.
    const third = await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:38:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(third.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(2);
  });

  it("skips a healthy in-flight mission, then wakes once the heartbeat dies", async () => {
    const db = getDb();
    const f = await seedPeriodicReviewMission(db, {
      missionCreatedAt: new Date("2026-08-18T09:00:00.000Z"),
      runStatus: "running",
      stepStatus: "running",
    });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId, companyId: f.companyId, agentId: f.workerAgentId,
      issueId: f.producerIssue.id, status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z"),
    });
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();
    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });

    // 건강한 진행 중(살아 있는 하트비트 + 열린 오너 액션 0 + 실패/블록 단위 0) → 경과 67분이어도 안 깨운다.
    const first = await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:07:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.findings.join("\n")).not.toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).not.toHaveBeenCalled();

    // 하트비트 사망 → 정체로 재분류 → 다음 미션 상대 버킷에서 깨운다.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date("2026-08-18T10:10:00.000Z") }).where(eq(heartbeatRuns.id, heartbeatRunId));
    const second = await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:38:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);
  });

  it("wakes when a unit failed even while a heartbeat is still live", async () => {
    const db = getDb();
    const f = await seedPeriodicReviewMission(db, {
      missionCreatedAt: new Date("2026-08-18T09:00:00.000Z"),
      runStatus: "failed",
      stepStatus: "failed",
      issueStatus: "blocked",
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: f.companyId, agentId: f.workerAgentId,
      issueId: f.producerIssue.id, status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z"),
    });
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();
    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });

    const result = await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:07:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);
  });

  it("does not wake for periodic review when execution is fully settled", async () => {
    const db = getDb();
    const completedAt = new Date("2026-08-18T11:00:00.000Z");
    const f = await seedPeriodicReviewMission(db, {
      missionCreatedAt: new Date("2026-08-18T09:00:00.000Z"),
      runStatus: "completed",
      stepStatus: "completed",
      issueStatus: "done",
      issuePrefix: "SR",
    });
    await db.update(workflowRuns).set({ completedAt }).where(eq(workflowRuns.id, f.workflowRunId));
    await db.update(workflowStepRuns).set({ completedAt }).where(eq(workflowStepRuns.workflowRunId, f.workflowRunId));
    await db.update(issues).set({ completedAt }).where(eq(issues.id, f.producerIssue.id));
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();
    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });

    await svc.runMainExecutorSupervision({ missionId: f.missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T11:10:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onMissionOwnerPeriodicReviewWakeRequested).not.toHaveBeenCalled();
    // settlement 가 미션을 종결했고 리뷰 대상이 없다.
    await expect(db.select().from(missions).where(eq(missions.id, f.missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });
}
