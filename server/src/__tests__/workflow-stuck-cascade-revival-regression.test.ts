import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceSettings, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { createCascadeHarness, insertUnblock, observe, snapshot, trigger } from "./helpers/failure-cascade-atomicity-fixture.js";
import { seedBoundaryIntegrationRun } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { settleStuckFailureCascade } from "../services/workflow/failure-cascade-finalization.js";
import { currentTransition, permitsRecordedCascadeRecovery } from "../services/workflow/failure-cascade-provenance.js";
import { acceptSourceIssueRecovery } from "../services/workflow/source-issue-recovery-accept.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

describe("stuck cascade records recoverable causes and never falsely completes", () => {
  let owned: Awaited<ReturnType<typeof createCascadeHarness>>;
  beforeAll(async () => { owned = await createCascadeHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  async function flags(boundaryEnabled: boolean) {
    await owned.db.delete(instanceSettings);
    await owned.db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: {
      enableRunTerminalBoundaryV1: boundaryEnabled, enableRunReopenGuardV1: true, enableRunRecoveryServiceV1: true,
    } });
  }

  async function seed() {
    const world = await seedBoundaryIntegrationRun(owned.db, { steps: [
      { stepId: "upstream", status: "pending", issueStatus: "blocked" },
      { stepId: "after", status: "pending", dependencies: ["upstream"], metadata: { keep: "first" } },
      { stepId: "last", status: "pending", dependencies: ["after"], metadata: { keep: "second" } },
    ] });
    await owned.db.transaction(async tx => {
      await tx.update(workflowRuns).set({ status: "pending", startedAt: null, metadata: { executionDefinitionVersion: 1 } })
        .where(eq(workflowRuns.id, world.runId));
      await captureExecutionDefinition(tx, world.runId);
      await tx.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, world.runId));
      await tx.update(workflowStepRuns).set({ status: "running", startedAt: new Date(), completedAt: null })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep.upstream!));
    });
    return world;
  }

  async function settle(world: Awaited<ReturnType<typeof seed>>, boundaryEnabled: boolean) {
    const observation = await observe(owned.db, world, boundaryEnabled ? "stuck-on" : "stuck-off");
    return settleStuckFailureCascade(owned.db, { run: observation.run, pendingSteps: observation.pending,
      boundaryStepRuns: observation.steps, boundaryEnabled });
  }

  it("records the running failure before skipping and revives the entire chain", async () => {
    await flags(true);
    const world = await seed(), before = await snapshot(owned.peer, world);
    expect(await settle(world, true)).toMatchObject({ action: "recovered" });
    const failed = await snapshot(owned.peer, world);
    expect(failed.run.status).toBe("failed");
    expect(failed.decisions).toHaveLength(1);
    const cause = failed.steps.find(row => row.stepId === "upstream")!;
    expect(cause.status).toBe("failed");
    const event = currentTransition(failed.transitions, failed.run, cause);
    expect(event).toMatchObject({ fromStatus: "running", toStatus: "failed", reasonCode: "workflow_reconciler",
      payload: expect.objectContaining({ transitionVersion: cause.statusTransitionVersion }) });
    expect(event!.executionGeneration === null || event!.executionGeneration === cause.executionGeneration - 1).toBe(true);
    for (const row of failed.steps) {
      expect(row.executionGeneration).toBe(before.steps.find(prior => prior.id === row.id)!.executionGeneration + 1);
      if (row.id === cause.id) continue;
      const proof = row.metadata.failureCascadeProvenance as { definitionHash: string };
      expect(row).toMatchObject({ status: "skipped", metadata: { failureCascadeSkipped: true,
        failureCascadeProvenance: { complete: true, causes: [{ stepRunId: cause.id, stepId: "upstream",
          issueId: cause.issueId, executionGeneration: cause.executionGeneration - 1,
          statusTransitionVersion: cause.statusTransitionVersion, dispatchRequestId: cause.lastDispatchRequestId }] } } });
      // Recovery adds exactly one generation before checking this persisted proof.
      expect(permitsRecordedCascadeRecovery({ ...row, executionGeneration: row.executionGeneration + 1 },
        cause, failed.run, proof.definitionHash, "workflow_reconciler")).toBe(true);
    }
    await insertUnblock(owned.db, world, cause.issueId!);
    expect(await acceptSourceIssueRecovery(owned.db, { run: failed.run, stepRunId: cause.id,
      issueId: cause.issueId! })).toMatchObject({ official: true, run: { status: "running" } });
    const recovered = await snapshot(owned.peer, world);
    expect(recovered.run).toMatchObject({ status: "running", dispatchAuthorityVersion: failed.run.dispatchAuthorityVersion + 1 });
    for (const row of recovered.steps) {
      expect(row.executionGeneration).toBe(failed.steps.find(prior => prior.id === row.id)!.executionGeneration + 1);
      if (row.id === cause.id) expect(row.status).toBe("running");
      else expect(row).toMatchObject({ status: "pending", startedAt: null, completedAt: null,
        metadata: { failureCascadeSkipped: false, keep: row.stepId === "after" ? "first" : "second" } });
    }
    expect(recovered.effects).toEqual(failed.effects);
    expect(recovered.wakes).toEqual(failed.wakes);
  });

  it("also records the settled cause on the legacy terminal path", async () => {
    await flags(false);
    const world = await seed();
    expect(await settle(world, false)).toMatchObject({ action: "recovered" });
    const state = await snapshot(owned.peer, world);
    expect(state.run.status).toBe("failed");
    expect(state.decisions).toHaveLength(0);
    for (const row of state.steps.filter(row => row.stepId !== "upstream")) {
      expect(row.metadata).toMatchObject({ failureCascadeProvenance: { complete: true,
        causes: [expect.objectContaining({ stepRunId: world.stepRunIdsByStep.upstream })] } });
    }
  });

  it("rolls back settlement, skips and provenance when a late recovery channel cancels finalization", async () => {
    await flags(true);
    const world = await seed(), before = await snapshot(owned.peer, world);
    const remove = await trigger(owned.db, "workflow_step_runs", "AFTER UPDATE",
      `NEW.id = '${world.stepRunIdsByStep.after}'::uuid AND OLD.status = 'pending' AND NEW.status = 'skipped'`,
      `INSERT INTO issues (company_id, mission_id, title, status, origin_kind, origin_id)
       VALUES ('${world.companyId}', '${world.missionId}', 'Late recovery', 'todo',
       'mission_main_executor_unblock', '${world.issueIdsByStep.upstream}');`);
    try {
      expect(await settle(world, true)).toMatchObject({ action: "deferred" });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    } finally { await remove(); }
  });

  it.each([true, false].flatMap(boundaryEnabled => [true, false].map(complete => ({ boundaryEnabled, complete }))))(
    "fails with completed upstream and unrevived provenance (boundary=$boundaryEnabled, complete=$complete)",
    async ({ boundaryEnabled, complete }) => {
      await flags(boundaryEnabled);
      const world = await seedBoundaryIntegrationRun(owned.db, { steps: [
        { stepId: "upstream", status: "completed" },
        { stepId: "after", status: "skipped", dependencies: ["upstream"], metadata: {
          failureCascadeSkipped: true, failureCascadeProvenance: { schemaVersion: 1, complete, causes: [] },
        } },
      ] });
      for (let pass = 0; pass < 2; pass++) {
        await syncWorkflowRunState(owned.db, world.runId);
        const state = await snapshot(owned.peer, world);
        expect(state.run.status).toBe("failed");
        expect(state.steps.find(row => row.stepId === "after")?.status).toBe("skipped");
      }
    });
});
