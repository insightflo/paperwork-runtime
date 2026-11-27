// [s25-planqa-fix P0] PLAN-QA PASS 이후 일시적 assignee error 로 인한 영구 스톨 방지 회귀 테스트.
// Fix A: assignee 상태가 일시적 error 면 영구 rejected 원장 오염 대신 noop(plan_decision_transiently_blocked)
//        으로 지연하고, agent 회복 시 동일 결정이 정상 게이트로 회복된다. paused 등 운영자 통제
//        상태는 기존 hard rejection 을 유지한다.
// Fix B: PASS verdict + refs.planQa pending + 유일 제출 rejected(구 빌드 오염) 시그니처를 스윕이
//        멱등 rework wake 으로 회복한다(무음 스톨 제거). assignee error 주기는 blocked 로 보류.
import { and, eq } from "drizzle-orm";
import { missionPlanDecisionSubmissions } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanupTransientStallTables,
  countMissionWorkflowRuns,
  describeTransientStallDb,
  readActivePlanQa,
  readDeferredTransientActivity,
  readLedgerRow,
  readPlanningIssueRow,
  recordPassVerdict,
  seedTransientStallFixture,
  setAgentStatus,
  setWorkflowToolStepExecutor,
  startTransientStallDb,
  stubPlanQaLocalStorage,
  submitDecisionOnPlanningIssue,
} from "./helpers/plan-qa-transient-stall-fixture.js";
import {
  findLatestAuthorizedMissionOwnerPlanDecision,
  recordLatestAuthorizedMissionOwnerPlanDecision,
  sweepStalledPlanQaPassRecords,
} from "../services/mission-owner-plan-decisions.js";
import { createPlanningIssueWakeupHandler } from "../services/missions/plan-qa-wakeup.js";

describeTransientStallDb("mission owner plan decision transient stall recovery", () => {
  let db!: Awaited<ReturnType<typeof startTransientStallDb>>["db"];
  let tempDb: Awaited<ReturnType<typeof startTransientStallDb>>["tempDb"] | null = null;
  let cleanupStorage: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    cleanupStorage = await stubPlanQaLocalStorage();
    const started = await startTransientStallDb("paperclip-planqa-transient-");
    tempDb = started.tempDb;
    db = started.db;
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await cleanupTransientStallTables(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await cleanupStorage?.();
  });

  /** 제출 → 게이트 오픈(refs.planQa pending, hash 고정)까지의 공통 전제. */
  async function seedThroughGateOpen(planningIssueStatus = "todo") {
    const fixture = await seedTransientStallFixture(db, { planningIssueStatus });
    await submitDecisionOnPlanningIssue(db, {
      companyId: fixture.companyId,
      missionId: fixture.missionId,
      planningIssueId: fixture.planningIssueId,
      authorAgentId: fixture.ownerAgentId,
      executorAgentId: fixture.executorAgentId,
    });
    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(first.status).toBe("plan_qa_pending");
    const { planQa } = await readActivePlanQa(db, fixture.companyId, fixture.missionId);
    expect(planQa?.status).toBe("pending");
    expect(planQa?.decisionHash).toBeTruthy();
    return fixture;
  }

  /** production 배선과 동일한 idempotencyKey 를 만드는 handler stub(createPlanningIssueWakeupHandler 경유). */
  function recordStallWakeup() {
    const wakeups: Array<{ agentId: string; idempotencyKey: string | null | undefined }> = [];
    const handler = createPlanningIssueWakeupHandler({
      wakeup: async (agentId, opts) => {
        wakeups.push({ agentId, idempotencyKey: opts.idempotencyKey });
        return { accepted: true };
      },
    });
    return { wakeups, handler };
  }

  it("T-A1 defers a decision blocked only by a transiently errored assignee and recovers once active", async () => {
    const fixture = await seedThroughGateOpen();
    await setAgentStatus(db, fixture.executorAgentId, "error");
    const blocked = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(blocked.status).toBe("noop");
    if (blocked.status === "noop") {
      expect(blocked.reason).toBe("plan_decision_transiently_blocked");
      expect(blocked.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["agent_status_transiently_unavailable"]);
    }
    // 원장은 영구 rejected 로 오염되지 않는다(직전 'submitted' 유지 → 다음 수집에서 여전히 authorized).
    expect(await readLedgerRow(db, fixture.companyId, fixture.missionId)).toMatchObject({ status: "submitted", rejectionReason: null });
    expect(await readDeferredTransientActivity(db, fixture.companyId, fixture.missionId)).not.toBeNull();
    expect(await countMissionWorkflowRuns(db, fixture.missionId)).toBe(0);
    // agent 회복 → 동일 결정이 정상 게이트로 재진입한다.
    await setAgentStatus(db, fixture.executorAgentId, "active");
    const recovered = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(recovered.status).toBe("plan_qa_pending");
    expect(await readLedgerRow(db, fixture.companyId, fixture.missionId)).toMatchObject({ status: "plan_qa_pending" });
  });

  it("T-A2 recovers a stalled PASS after the transient error clears and the sweep stays idempotent", async () => {
    const fixture = await seedThroughGateOpen();
    await recordPassVerdict(db, fixture.companyId, fixture.missionId, fixture.qaAgentId);
    await setAgentStatus(db, fixture.executorAgentId, "error");
    const blocked = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(blocked.status).toBe("noop");
    if (blocked.status === "noop") expect(blocked.reason).toBe("plan_decision_transiently_blocked");
    expect(await readLedgerRow(db, fixture.companyId, fixture.missionId)).toMatchObject({ status: "submitted" });
    expect(await countMissionWorkflowRuns(db, fixture.missionId)).toBe(0);

    await setAgentStatus(db, fixture.executorAgentId, "active");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const firstSweep = await sweepStalledPlanQaPassRecords(db);
    expect(firstSweep.stalled).toBe(1);
    expect(firstSweep.recovered).toBe(1);
    expect(firstSweep.woken).toBe(0);
    expect(firstSweep.blocked).toBe(0);
    expect(firstSweep.failures).toEqual([]);
    const { planQa, paqoWorkflow } = await readActivePlanQa(db, fixture.companyId, fixture.missionId);
    expect(planQa?.status).toBe("pass");
    expect(paqoWorkflow?.workflowRunId).toBeTruthy();
    expect(await readLedgerRow(db, fixture.companyId, fixture.missionId)).toMatchObject({ status: "recorded" });
    const runsAfterFirst = await countMissionWorkflowRuns(db, fixture.missionId);
    expect(runsAfterFirst).toBeGreaterThan(0);

    // 2회차 스윕은 멱등: 새 스톨 없음, 중복 런 미생성.
    const secondSweep = await sweepStalledPlanQaPassRecords(db);
    expect(secondSweep.stalled).toBe(0);
    expect(secondSweep.recovered).toBe(0);
    expect(await countMissionWorkflowRuns(db, fixture.missionId)).toBe(runsAfterFirst);
    setWorkflowToolStepExecutor(null);
  });

  it("T-A3 keeps the hard rejection path for operator-controlled paused status", async () => {
    const fixture = await seedTransientStallFixture(db);
    await submitDecisionOnPlanningIssue(db, {
      companyId: fixture.companyId,
      missionId: fixture.missionId,
      planningIssueId: fixture.planningIssueId,
      authorAgentId: fixture.ownerAgentId,
      executorAgentId: fixture.executorAgentId,
    });
    await setAgentStatus(db, fixture.executorAgentId, "paused");
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toBe("invalid_selected_execution_unit_source_ref");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["assignee_agent_not_runnable"]);
    }
    expect(await readLedgerRow(db, fixture.companyId, fixture.missionId))
      .toMatchObject({ status: "rejected", rejectionReason: "invalid_selected_execution_unit_source_ref" });
    const found = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toBe("no_authorized_decision");
  });

  it("T-B1 wakes a polluted rejected ledger idempotently and defers while the assignee is errored", async () => {
    // planning issue 를 in_progress(체크아웃 없음)로 시드해 reopen(status→todo)을 확인한다.
    const fixture = await seedThroughGateOpen("in_progress");
    const pass = await recordPassVerdict(db, fixture.companyId, fixture.missionId, fixture.qaAgentId);
    // 구 빌드가 남긴 오염 상태 재현: 유일 제출을 영구 rejected 로 강제한다.
    await db.update(missionPlanDecisionSubmissions).set({
      status: "rejected",
      rejectionReason: "invalid_selected_execution_unit_source_ref",
      diagnostics: [{ code: "assignee_agent_not_runnable", message: "assignee not runnable (status=error)" }],
    }).where(and(
      eq(missionPlanDecisionSubmissions.companyId, fixture.companyId),
      eq(missionPlanDecisionSubmissions.missionId, fixture.missionId),
    ));
    const { wakeups, handler } = recordStallWakeup();

    // (i) handler 미제공: woken 0 + 이슈 무변경(하위호환).
    const noHandlerSweep = await sweepStalledPlanQaPassRecords(db);
    expect(noHandlerSweep.stalled).toBe(1);
    expect(noHandlerSweep.woken).toBe(0);
    expect(noHandlerSweep.recovered).toBe(0);
    const untouched = await readPlanningIssueRow(db, fixture.companyId, fixture.missionId);
    expect(untouched?.description ?? "").not.toContain("paperclip-plan-revision-baseline-start");

    // (ii) production-shape handler: 1회 wake, 이슈 reopen(todo), 거절 진단 baseline 부착.
    const firstSweep = await sweepStalledPlanQaPassRecords(db, { enqueuePlanningIssueWakeup: handler });
    expect(firstSweep.stalled).toBe(1);
    expect(firstSweep.woken).toBe(1);
    expect(firstSweep.recovered).toBe(0);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: fixture.ownerAgentId,
      idempotencyKey: `mission-owner-plan-rework:${fixture.planningIssueId}:${pass.decisionHash}`,
    });
    const reopened = await readPlanningIssueRow(db, fixture.companyId, fixture.missionId);
    expect(reopened?.status).toBe("todo");
    expect(reopened?.description ?? "").toContain("paperclip-plan-revision-baseline-start");
    expect(reopened?.description ?? "").toContain("assignee_agent_not_runnable");

    // (iii) 2주기: 동일 idempotency key 재호출 — heartbeat dedupe 계약이 중복 wake 을 흡수한다.
    const secondSweep = await sweepStalledPlanQaPassRecords(db, { enqueuePlanningIssueWakeup: handler });
    expect(secondSweep.woken).toBe(1);
    expect(wakeups).toHaveLength(2);
    expect(wakeups[1]?.idempotencyKey).toBe(wakeups[0]?.idempotencyKey);

    // (iv) assignee error 주기: blocked 로 보류하고 이슈를 변경하지 않는다.
    await setAgentStatus(db, fixture.ownerAgentId, "error");
    const blockedSweep = await sweepStalledPlanQaPassRecords(db, { enqueuePlanningIssueWakeup: handler });
    expect(blockedSweep.blocked).toBe(1);
    expect(blockedSweep.woken).toBe(0);
    expect(wakeups).toHaveLength(2);
  });

  it("T-B2 structurally ignores stalls without a pinned PASS verdict", async () => {
    const fixture = await seedTransientStallFixture(db);
    await submitDecisionOnPlanningIssue(db, {
      companyId: fixture.companyId,
      missionId: fixture.missionId,
      planningIssueId: fixture.planningIssueId,
      authorAgentId: fixture.ownerAgentId,
      executorAgentId: fixture.executorAgentId,
    });
    const { wakeups, handler } = recordStallWakeup();
    const sweep = await sweepStalledPlanQaPassRecords(db, { enqueuePlanningIssueWakeup: handler });
    expect(sweep.stalled).toBe(0);
    expect(sweep.woken).toBe(0);
    expect(wakeups).toHaveLength(0);
  });
});
