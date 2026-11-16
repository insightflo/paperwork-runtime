import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkflowRestartFromOperatorDecision } from "../services/missions/approved-workflow-restart.js";
import { workflowRestartDb } from "./helpers/operator-decision-restart-fixture.js";
import { workflowService } from "../services/workflow/engine.js";

vi.mock("../services/workflow/engine.js", () => ({ workflowService: { trigger: vi.fn() } }));

const trigger = vi.mocked(workflowService.trigger);
const ids = () => ({
  companyId: randomUUID(), missionId: randomUUID(), sourceWorkflowRunId: randomUUID(),
  operatorDecisionId: randomUUID(), issueId: randomUUID(), resolvedByUserId: "board-user",
});

describe("approved workflow restart", () => {
  beforeEach(() => {
    trigger.mockReset();
  });

  it("starts a fresh top-level run and reopens blocked oversight from the approved source run", async () => {
    const input = ids();
    const workflowId = randomUUID();
    const fixture = workflowRestartDb(input, {
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId, parentRunId: null, status: "failed", runDate: "2026-10-25",
      metadata: {
        url: "https://www.algumon.com/n", slug: "algumon-com",
        section: "manuals", visibility: "public",
      },
    });
    trigger.mockResolvedValue({ runId: randomUUID(), status: "running", stepRuns: [] });

    const { db, updateSet, updateWhere, insertValues } = fixture;
    const result = await startWorkflowRestartFromOperatorDecision(db, fixture.input);

    expect(trigger).toHaveBeenCalledWith(db, expect.objectContaining({
      companyId: input.companyId, missionId: input.missionId, workflowId,
      runDate: "2026-10-25", triggeredBy: "operator_decision_approval",
      triggerSource: "operator_decision",
      metadata: {
        url: "https://www.algumon.com/n", slug: "algumon-com",
        section: "manuals", visibility: "public",
        operatorDecisionRestart: {
          schemaVersion: 1,
          operatorDecisionId: input.operatorDecisionId,
          sourceWorkflowRunId: input.sourceWorkflowRunId,
        },
      },
    }), { actor: { type: "none" } });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "todo" }));
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "workflow_run.created", entityId: result.runId,
    }));
  });

  it("replaces a prior restart marker and drops runtime stamps while carrying caller metadata", async () => {
    const input = ids();
    const fixture = workflowRestartDb(input, {
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId: randomUUID(), parentRunId: null, status: "failed", runDate: "2026-10-25",
      metadata: {
        url: "https://www.algumon.com/n",
        operatorDecisionRestart: {
          schemaVersion: 1, operatorDecisionId: randomUUID(), sourceWorkflowRunId: randomUUID(),
        },
        executionDefinitionVersion: 1,
        replacementAuthorityId: randomUUID(),
        replacementStart: { schemaVersion: 1, authorityId: randomUUID(), deliveredAt: "2026-11-01T00:00:00.000Z" },
        resumeRequestId: randomUUID(),
        resumeAuthorityVersion: 2,
        ownerPlanExecution: { actionId: randomUUID(), decisionHash: "stale" },
      },
    });
    trigger.mockResolvedValue({ runId: randomUUID(), status: "running", stepRuns: [] });

    await startWorkflowRestartFromOperatorDecision(fixture.db, fixture.input);

    expect(trigger).toHaveBeenCalledWith(fixture.db, expect.objectContaining({
      metadata: {
        url: "https://www.algumon.com/n",
        operatorDecisionRestart: {
          schemaVersion: 1,
          operatorDecisionId: input.operatorDecisionId,
          sourceWorkflowRunId: input.sourceWorkflowRunId,
        },
      },
    }), { actor: { type: "none" } });
  });

  it("restarts with the marker alone when the source run has null metadata", async () => {
    const input = ids();
    const fixture = workflowRestartDb(input, {
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId: randomUUID(), parentRunId: null, status: "failed", runDate: "2026-10-25",
      metadata: null,
    });
    trigger.mockResolvedValue({ runId: randomUUID(), status: "running", stepRuns: [] });

    await startWorkflowRestartFromOperatorDecision(fixture.db, fixture.input);

    expect(trigger).toHaveBeenCalledWith(fixture.db, expect.objectContaining({
      metadata: { operatorDecisionRestart: {
        schemaVersion: 1,
        operatorDecisionId: input.operatorDecisionId,
        sourceWorkflowRunId: input.sourceWorkflowRunId,
      } },
    }), { actor: { type: "none" } });
  });

  it("fails closed when the bound source run is no longer failed", async () => {
    const input = ids();
    const fixture = workflowRestartDb(input, {
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId: randomUUID(), parentRunId: null, status: "completed", runDate: "2026-10-25",
    });
    await expect(startWorkflowRestartFromOperatorDecision(fixture.db, fixture.input))
      .rejects.toThrow("workflow_restart_source_not_failed");
    expect(trigger).not.toHaveBeenCalled();
    expect(fixture.updateSet).not.toHaveBeenCalled();
    expect(fixture.insertValues).not.toHaveBeenCalled();
  });

  it.each(["missing", "mismatched"] as const)("rejects %s supplied decision binding before effects", async (damage) => {
    const input = ids();
    const fixture = workflowRestartDb(input, {
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId: randomUUID(), parentRunId: null, status: "failed", runDate: "2026-10-25",
    });
    const supplied = damage === "missing"
      ? { ...fixture.input, decisionRequestHash: undefined, decisionResult: undefined }
      : { ...fixture.input, decisionResult: { ...fixture.decisionResult, comment: "changed" } };
    await expect(startWorkflowRestartFromOperatorDecision(fixture.db, supplied)).rejects.toMatchObject({
      status: 409, details: { code: "workflow_restart_decision_binding_invalid" },
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(fixture.updateSet).not.toHaveBeenCalled();
    expect(fixture.insertValues).not.toHaveBeenCalled();
  });
});
