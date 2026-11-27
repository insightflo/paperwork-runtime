import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { lifecycleInFlightClause } from "../services/heartbeat-finalization/lifecycle-active.js";
import { recoverTerminalUnsettledRuns } from "../services/heartbeat-finalization/recovery.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip pre-invocation recovery tests: ${support.reason ?? "unsupported"}`);

async function seedRun(db: ReturnType<typeof createDb>, companyId: string, agentId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const issueId = (overrides.issueId as string | undefined) ?? randomUUID();
  await db.insert(issues).values({ id: issueId, companyId, title: "Pre-invocation recovery issue" });
  await db.insert(heartbeatRuns).values({
    id, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
    executionScopeKind: "issue_nonworkflow", finalizationVersion: 1, executionEpoch: 0,
    executionToken: randomUUID(), executorOwnerId: "default", executorOwnerLeaseEpoch: 1,
    executorOwnerLeaseToken: randomUUID(), executorOwnerReleasedAt: new Date(),
    terminalOutcome: "succeeded", terminalDecisionSource: "adapter_success",
    processPid: null, issueId, ...overrides,
  } as never);
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
  return run!;
}

describeEP("terminal-unsettled pre-invocation failure recovery (s25-unsettled-terminal-fix)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pre-invocation-recovery-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PreInvocationCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Pre-invocation agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
  });
  afterAll(() => { tempDb = null; });

  /**
   * 사전호출 실패 run 시드: 어댑터 시작 전 검증(kb/tool contract) 실패로 종결된
   * workflow_step run. processPid 는 어댑터가 시작된 적 없다는 뜻으로 NULL 이어야 한다.
   */
  async function seedPreInvocationFailureRun(input: {
    agentId: string;
    missionId: string;
    withHeldMissionRuntime: boolean;
  }) {
    const finishedAt = new Date("2026-03-20T00:00:00.000Z");
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const workflowStepRunId = randomUUID();
    await db.insert(missions).values({
      id: input.missionId, companyId, ownerAgentId: input.agentId, title: "Kb contract recovery mission", status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "Kb contract workflow", stepsJson: [{ id: "step" }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId, companyId, workflowId, missionId: input.missionId, status: "running", triggeredBy: "test",
    });
    await db.insert(workflowStepRuns).values({
      id: workflowStepRunId, workflowRunId, stepId: "step", status: "running", metadata: {}, executionGeneration: 0,
    });
    const run = await seedRun(db, companyId, input.agentId, {
      status: "failed",
      errorCode: "workflow_step_kb_contract_invalid",
      terminalOutcome: "failed",
      terminalDecisionSource: "heartbeat_status:failed:workflow_step_kb_contract_invalid",
      executionScopeKind: "workflow_step",
      workflowStepRunId,
      workflowExecutionGeneration: 0,
      processPid: null,
      executorOwnerReleasedAt: new Date(finishedAt.getTime() - 1000),
      finishedAt,
      updatedAt: finishedAt,
      settledAt: null,
      contextSnapshot: { missionId: input.missionId },
    });
    if (input.withHeldMissionRuntime) {
      await db.insert(missionAgentRuntimes).values({
        companyId,
        missionId: input.missionId,
        agentId: input.agentId,
        adapterType: "codex_local",
        runtimeKey: `test:${input.missionId}:${input.agentId}`,
        status: "starting",
        lastRunId: run.id,
        stoppedAt: null,
      });
    }
    return run;
  }

  /** heartbeat-enqueue-wakeup.ts / heartbeat-followup-queue.ts 의 같은 미션 dedup 조건 재현. */
  async function missionDedupInFlightRunCount(agentId: string, missionId: string) {
    const inFlightClause = await lifecycleInFlightClause(db);
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, agentId),
      inFlightClause,
      sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionId}`,
    ));
    return rows.length;
  }

  it("recovers a workflow_step_kb_contract_invalid pre-invocation failure with a held mission runtime so mission-dedup wakeups proceed", async () => {
    const recoveryAgentId = randomUUID();
    await db.insert(agents).values({
      id: recoveryAgentId, companyId, name: "Kb contract held agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const missionId = randomUUID();
    const run = await seedPreInvocationFailureRun({ agentId: recoveryAgentId, missionId, withHeldMissionRuntime: true });

    // 데드락 재현: terminal-unsettled fv=1 run 이 lifecycle-in-flight 로 판정되어 같은 미션 wakeup 이 defer 된다.
    expect(run.settledAt).toBeNull();
    expect(await missionDedupInFlightRunCount(recoveryAgentId, missionId)).toBe(1);

    await recoverTerminalUnsettledRuns(db, new Date("2026-03-20T00:10:00.000Z"), 5 * 60 * 1000);

    const [recovered] = await db
      .select({ settledAt: heartbeatRuns.settledAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(recovered?.settledAt).not.toBeNull();
    const [heldRuntime] = await db.select().from(missionAgentRuntimes)
      .where(eq(missionAgentRuntimes.lastRunId, run.id));
    expect(heldRuntime?.status).toBe("crashed");
    // 정산 후 run 은 lifecycle-in-flight 가 아니므로 후속 wakeup dedup 이 더 이상 defer 하지 않는다.
    expect(await missionDedupInFlightRunCount(recoveryAgentId, missionId)).toBe(0);
  });

  it("recovers an already-terminal workflow_step_kb_contract_invalid run that finished in the past without a held runtime", async () => {
    const recoveryAgentId = randomUUID();
    await db.insert(agents).values({
      id: recoveryAgentId, companyId, name: "Kb contract plain agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const missionId = randomUUID();
    const run = await seedPreInvocationFailureRun({ agentId: recoveryAgentId, missionId, withHeldMissionRuntime: false });

    expect(run.settledAt).toBeNull();
    expect(await missionDedupInFlightRunCount(recoveryAgentId, missionId)).toBe(1);

    await recoverTerminalUnsettledRuns(db, new Date("2026-03-20T00:10:00.000Z"), 5 * 60 * 1000);

    const [recovered] = await db
      .select({ settledAt: heartbeatRuns.settledAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(recovered?.settledAt).not.toBeNull();
    expect(await missionDedupInFlightRunCount(recoveryAgentId, missionId)).toBe(0);
  });
});
