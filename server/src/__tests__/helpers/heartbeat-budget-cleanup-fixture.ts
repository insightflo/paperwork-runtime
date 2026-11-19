import { inArray } from "drizzle-orm";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import {
  type createDb,
  agents,
  agentInstructionInjections,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  assets,
  companies,
  companySecretVersions,
  companySecrets,
  companySkills,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  workflowTransitionEvents,
  knowledgeBases,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  issueExecutionCards,
  missionPlanArtifacts,
  missions,
  missionSessions,
  projects,
  qualityReviewItems,
  toolDefinitions,
  agentKbGrants,
  agentTaskSessions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workspaceRuntimeServices,
  heartbeatRunFinalizations,
  heartbeatRunFinalizationSteps,
} from "@paperclipai/db";

async function cleanupHeartbeatRunRecords(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    // finalization tables reference heartbeat_runs via FK — delete before runs.
    // [2026-11-15 FK 경합 수선] 비동기 finalization-steps 작성자가 steps 삭제 → finalizations 삭제
    //   사이 틈에 하위행을 새로 쓰면 FK 위반으로 afterEach 전체가 중단되고, 잔여 데이터가 다음
    //   테스트(companies.issue_prefix 유일 충돌)까지 격파한다(heartbeat-context-budget-preflight
    //   CI 2연속 실패 원인). steps→finalizations 쌍을 같은 재시도 루프 안에서 삭제한다.
    try {
      await db.delete(heartbeatRunFinalizationSteps);
      await db.delete(heartbeatRunFinalizations);
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function deleteAgentsAfterLateIssueSideEffects(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cleanupHeartbeatRunRecords(db);
    await db.delete(agentWakeupRequests);
    try {
      // Late heartbeat side-effects can recreate agent_runtime_state (agentId FK
      // pins agents). Re-delete before every agents delete/retry, mirroring
      // agentWakeupRequests above, so a recreated row cannot block cleanup.
      await db.delete(agentRuntimeState);
      await db.delete(agents);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await cleanupHeartbeatRunRecords(db);
      await db.delete(issueWorkProducts);
      await db.delete(issueDocuments);
      await db.delete(issueComments);
      await db.delete(issues);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function cleanupHeartbeatBudgetFixture(db: ReturnType<typeof createDb>) {
  // [플레이크 RCA 2026-11-15·재현 입증] 종말 상태 기록 뒤에도 executeRun 프라미스 내부에서 정산
  //   (finalization + steps 순차 기록, attemptFullSettlement)이 계속된다. 아래 상태 폴링
  //   (queued/running 부재 + 정착 500ms)은 이 기록자를 프라미스로 기다리지 못해 CI 경합 시
  //   삭제 창과 겹치고, steps 삭제 → finalizations 삭제 사이 재기입이 FK 위반으로 afterEach 를
  //   중단시켜 잔여 companies 가 다음 테스트를 issue_prefix 유일 충돌로 격파한다(관측된 2연속 실패).
  //   삭제 전에 추적된 실행(trackHeartbeatExecution)을 프라미스 기반으로 결정적으로 드레인한다.
  //   드레인 타임아웃 시에도 아래 폴링·재시도 루프가 폴백으로 정리를 이어간다.
  await waitForHeartbeatExecutionsToDrain(db, 30_000).catch(() => undefined);
  // Drain/stop in-flight heartbeat work before deleting rows so residual adapter.execute
  // and secret materialization cannot pollute the next test (Hermes Ops spy / company_secrets FK).
  // We also wait for terminal runs' fire-and-forget post-processing to settle: executeRun
  // continues writing DB rows (comments, events, runtime, handoff) AFTER setting terminal
  // status. Polling queued/running alone misses this window. We wait until no runs have been
  // updated in the last 500ms, then hold one more settle window before row deletion.
  const idleDeadline = Date.now() + 5_000;
  let settleSince: number | null = null;
  while (Date.now() < idleDeadline) {
    const activeRuns = await db
      .select({ id: heartbeatRuns.id, updatedAt: heartbeatRuns.updatedAt })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]))
      .limit(1);
    if (activeRuns.length === 0) {
      const recentMs = Date.now() - (settleSince ?? Date.now());
      if (recentMs >= 500) break;
      if (settleSince === null) settleSince = Date.now();
    } else {
      settleSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await db
    .update(heartbeatRuns)
    .set({ status: "failed", finishedAt: new Date(), error: "test-teardown-drain" })
    .where(inArray(heartbeatRuns.status, ["queued", "running"]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await db.delete(agentTaskSessions);
  // Transition events can pin heartbeat_runs (owner recovery ledger). Delete before runs.
  await db.delete(workflowTransitionEvents);
  await db.update(heartbeatRuns).set({ wakeupRequestId: null });
  await cleanupHeartbeatRunRecords(db);
  // [AREA: wakeup queue] 새 skip→queued 동작이 agent_wakeup_requests 를 pending 상태로 남긴다.
  // 이전 test 의 queued wakeup 이 다음 test 의 resumeQueuedRuns 에 의해 promote 되어 공유
  // executeSpy 카운트를 오염시키지 않도록 매 test 마다 전체 삭제(격리). 반드시 runs 정리 뒤(FK).
  await db.delete(agentWakeupRequests);
  await db.delete(workspaceRuntimeServices);
  await db.delete(issueWorkProducts);
  await db.delete(agentInstructionInjections);
  await db.delete(issueExecutionCards);
  await db.delete(issueDocuments);
  await db.delete(documentRevisions);
  await db.delete(documents);
  await db.delete(issueComments);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(missionPlanArtifacts);
  await db.update(issues).set({ parentId: null });
  await db.delete(issues);
  await db.delete(qualityReviewItems);
  await db.delete(toolDefinitions);
  await db.delete(agentKbGrants);
  await db.delete(knowledgeBases);
  await db.delete(missionSessions);
  await db.delete(missions);
  await db.delete(companySecretVersions);
  await db.delete(companySecrets);
  await db.delete(agentRuntimeState);
  await deleteAgentsAfterLateIssueSideEffects(db);
  // Late heartbeat side-effects can recreate secrets after the first delete.
  await db.delete(companySecretVersions);
  await db.delete(companySecrets);
  await db.delete(projects);
  await db.delete(companySkills);
  // [T7 fixture] PLAN-QA manifest attachments create assets rows (company FK cascade 없음).
  await db.delete(assets);
  await db.delete(companies);
}
