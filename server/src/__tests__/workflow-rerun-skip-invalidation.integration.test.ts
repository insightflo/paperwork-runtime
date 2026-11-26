import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { companies, toolDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import {
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  type WorkflowToolStepExecutionRequest,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { useControlNodeFixture } from "./helpers/workflow-control-node-fixture.js";

const fixture = useControlNodeFixture();

afterEach(async () => {
  vi.restoreAllMocks();
  setWorkflowToolStepExecutor(null);
  await fixture.db.delete(toolDefinitions);
});

async function getStep(runId: string, stepId: string) {
  const [row] = await fixture.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId),
    eq(workflowStepRuns.stepId, stepId),
  ));
  expect(row, `missing step run ${stepId}`).toBeTruthy();
  return row!;
}

async function getRunStatus(runId: string) {
  const [row] = await fixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  return row?.status;
}

function controlFlowSkipped(metadata: unknown) {
  return Boolean((metadata as Record<string, unknown> | null | undefined)?.controlFlowSkipped);
}

it("rerunning a failed upstream tool revives the selected IF branch instead of false-completing", async () => {
  const db = fixture.db;
  const companyId = randomUUID();
  const runId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Rerun Skip Invalidation",
    issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  for (const name of ["collect-tool", "branch-tool"]) {
    await db.insert(toolDefinitions).values({
      companyId,
      name,
      description: "rerun regression tool",
      adapterType: "http",
      adapterConfig: { url: "https://example.invalid/tool", method: "POST" },
      enabled: true,
    });
  }
  const requests: WorkflowToolStepExecutionRequest[] = [];
  setWorkflowToolStepExecutor(async (request) => {
    requests.push(request);
    return { accepted: true };
  });
  const definition = await workflowService.createDefinition(db, {
    companyId,
    name: "Rerun skip invalidation",
    steps: [
      { id: "collect", name: "Collect", type: "tool", toolNames: ["collect-tool"], dependencies: [] },
      {
        id: "gate",
        name: "Gate",
        type: "if",
        dependencies: ["collect"],
        conditionGroup: {
          combinator: "all",
          conditions: [{
            source: { kind: "work_product_json", stepId: "collect", title: "collect.json", path: "$.status" },
            dataType: "string",
            operator: "equals",
            rightValue: "selected",
          }],
        },
      },
      {
        id: "true-branch",
        name: "True branch",
        type: "tool",
        toolNames: ["branch-tool"],
        dependencies: [],
        conditionalDependencies: [{ stepId: "gate", when: "condition_true" }],
      },
      {
        id: "false-branch",
        name: "False branch",
        type: "tool",
        toolNames: ["branch-tool"],
        dependencies: [],
        conditionalDependencies: [{ stepId: "gate", when: "condition_false" }],
      },
    ] as never,
  });
  await db.insert(workflowRuns).values({
    id: runId,
    workflowId: definition.id,
    companyId,
    triggeredBy: "board",
    status: "pending",
    runDate: "2026-07-21",
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "test-board" } as typeof req.actor;
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);

  await executeWorkflowRun(db, runId);
  let collect = await getStep(runId, "collect");
  expect(collect.status).toBe("running");
  await processQueuedWorkflowToolStepRuns(db);
  const failedCollectRequest = requests.at(-1)!;
  expect(failedCollectRequest).toMatchObject({ stepId: "collect", workflowRunId: runId });
  const failedCompletion = await completeWorkflowToolStepFromResult(db, {
    companyId,
    stepRunId: collect.id,
    requestId: failedCollectRequest.requestId,
    success: false,
    error: "simulated upstream failure",
  });
  expect(failedCompletion?.status).toBe("failed");

  collect = await getStep(runId, "collect");
  const gate = await getStep(runId, "gate");
  const trueBefore = await getStep(runId, "true-branch");
  const falseBefore = await getStep(runId, "false-branch");
  expect(collect.status).toBe("failed");
  for (const row of [gate, trueBefore, falseBefore]) {
    expect(row.status).toBe("skipped");
    expect(controlFlowSkipped(row.metadata)).toBe(true);
  }
  expect(await getRunStatus(runId)).toBe("failed");

  const rerun = await request(app).post(`/api/workflow-step-runs/${collect.id}/rerun`).send({});
  expect(rerun.status).toBe(200);
  expect((await getStep(runId, "collect")).status).toBe("running");
  expect(await getRunStatus(runId)).toBe("running");

  await processQueuedWorkflowToolStepRuns(db);
  const collectRetryRequest = requests.at(-1)!;
  expect(collectRetryRequest).toMatchObject({ stepId: "collect", workflowRunId: runId });
  const artifactPath = path.join(fixture.artifactRoot, `${runId}-collect.json`);
  await writeFile(artifactPath, JSON.stringify({ status: "selected" }), "utf8");
  const recoveredCompletion = await completeWorkflowToolStepFromResult(db, {
    companyId,
    stepRunId: collect.id,
    requestId: collectRetryRequest.requestId,
    success: true,
    artifactPath,
    data: { ok: true },
  });

  expect(recoveredCompletion?.status).toBe("running");
  const trueAfter = await getStep(runId, "true-branch");
  const falseAfter = await getStep(runId, "false-branch");
  const gateAfter = await getStep(runId, "gate");
  expect((gateAfter.metadata as Record<string, unknown>).controlNodeResult).toMatchObject({
    nodeType: "if",
    outcome: "condition_true",
  });
  expect(trueAfter.status).toBe("running");
  expect(controlFlowSkipped(trueAfter.metadata)).toBe(false);
  expect((trueAfter.metadata as Record<string, unknown>).toolQueue).toMatchObject({ status: "queued" });
  expect(falseAfter.status).toBe("skipped");
  expect(controlFlowSkipped(falseAfter.metadata)).toBe(true);
  expect(await getRunStatus(runId)).toBe("running");

  const beforeBranchRequests = requests.length;
  await processQueuedWorkflowToolStepRuns(db);
  expect(requests.length).toBe(beforeBranchRequests + 1);
  expect(requests.at(-1)).toMatchObject({ stepId: "true-branch", toolName: "branch-tool" });
});
