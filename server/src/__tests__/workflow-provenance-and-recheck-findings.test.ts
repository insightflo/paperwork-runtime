import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  issueWorkProducts,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { wakeExistingWorkflowStepIssue } from "../services/workflow/workflow-step-wake.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping provenance/recheck-findings integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let db!: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let dir: string;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("prov-recheck-");
  db = createDb(tempDb.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "prov-recheck-"));
}, 60_000);

afterEach(async () => {
  await waitForHeartbeatExecutionsToDrain(db);
  await db.delete(missionAgentRuntimes);
  await db.delete(agentRuntimeState);
  await db.delete(activityLog);
  await db.delete(heartbeatRuns);
  await db.delete(agentWakeupRequests);
  await db.delete(issueComments);
  await db.delete(issueWorkProducts);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(issues);
});

afterAll(async () => {
  await tempDb?.cleanup();
  await rm(dir, { recursive: true, force: true });
});

const RECHECK_INSTRUCTION = "재검수(recheck) 판정 원칙: 직전 회차 findings 해소 여부와 회귀(regression) 여부 중심으로 판정하고, 기존 범위 밖 새 기준으로 골대를 이동하지 마세요.";

describe("runtime brief — validation recheck findings injection (#10)", () => {
  const findings = [
    { id: "kr-data-missing", summary: "observations.kr_index absent in source data", layer: "source_data" },
    { id: "mobile-overflow", summary: "Narrative s05 table overflows 328px", layer: "artifact" },
  ];

  it("renders prior findings with the recheck judgment principle", () => {
    const brief = buildPaperclipRuntimeBrief({ issueId: "issue-1", priorQaFindings: findings });
    expect(brief).toContain("[source_data] kr-data-missing");
    expect(brief).toContain("mobile-overflow");
    expect(brief).toContain(RECHECK_INSTRUCTION);
  });

  it("omits the recheck section when no prior findings exist", () => {
    const brief = buildPaperclipRuntimeBrief({ issueId: "issue-1" });
    expect(brief).not.toContain("재검수(recheck) 판정 원칙");
    expect(brief).not.toContain("kr-data-missing");
  });
});

describeEP("validation recheck wake — prior findings contextSnapshot propagation (#10)", () => {
  it("carries priorQaFindings in both the wake payload and the run contextSnapshot", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recheck Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "QA Agent", role: "qa",
      status: "idle", adapterType: "process", adapterConfig: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId,
      title: "Recheck Mission", status: "active",
    });
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = "build-report";
    const qaStepId = "qa-report";
    const steps = [
      { id: producerStepId, name: "Produce report", agentId, dependencies: [], graphWorkProductRequired: true },
      { id: qaStepId, type: "qa", name: "[QA] Inspection", agentId, dependencies: [producerStepId], graphWorkProductRequired: false },
    ];
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: `wf-${wfId.slice(0, 8)}`, stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const t0 = new Date(Date.now() - 3 * 60 * 60_000);
    const producerIssue = await db.insert(issues).values({
      companyId, missionId, title: "Produce report", status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId, startedAt: t0, completedAt: new Date(Date.now() - 60 * 60_000),
    }).returning();
    const qaIssue = await db.insert(issues).values({
      companyId, missionId, title: "[QA] Inspection", status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId, startedAt: t0,
    }).returning();
    const stepRuns = await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: producerStepId, status: "completed", issueId: producerIssue[0]!.id, iterationIndex: 1, completedAt: new Date(Date.now() - 60 * 60_000) },
      { workflowRunId: runId, stepId: qaStepId, status: "failed", issueId: qaIssue[0]!.id, iterationIndex: 0, completedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    ]).returning();
    const qaStepRun = stepRuns.find((row) => row.stepId === qaStepId)!;

    const queued = await wakeExistingWorkflowStepIssue({
      db,
      run: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!,
      definition: (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wfId)))[0]!,
      step: steps[1]!,
      stepRunId: qaStepRun.id,
      stepRunMetadata: qaStepRun.metadata ?? {},
      issueId: qaIssue[0]!.id,
      allowCompletedIssue: true,
      allowBlockedIssue: true,
      forceFreshSession: true,
      priorFindings: [
        { id: "kr-data-missing", summary: "observations.kr_index absent in source data", layer: "source_data" },
      ],
    });
    expect(queued).toBe(true);

    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, qaIssue[0]!.id));
    expect(wake).toBeDefined();
    const payload = (wake!.payload ?? {}) as Record<string, unknown>;
    expect(payload.priorQaFindings).toMatchObject([{ id: "kr-data-missing" }]);
    // The heartbeat run context is built from the run's contextSnapshot (the wake row's
    // own contextSnapshot column may legitimately be null on immediate-queue paths and
    // rides under the deferred-wake context key otherwise); either way the promoted run
    // must carry prior findings — the brief can only ever see them there.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, qaIssue[0]!.id));
    expect(runs.length).toBeGreaterThan(0);
    const snapshot = (runs[0]!.contextSnapshot ?? {}) as Record<string, unknown>;
    expect(snapshot.priorQaFindings).toMatchObject([{ id: "kr-data-missing" }]);
  });
});

describeEP("same-run selector — createdByRunId provenance re-derivation (#3)", () => {
  const PRODUCER_STEP_ID = "build-service-report-content";

  async function seedDegradedProducerProduct(input: { linkHeartbeatToStep: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const wakeId = randomUUID();
    const heartbeatId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Prov Co", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Producer" });
    await db.insert(missions).values({ id: missionId, companyId, title: "Prov Mission", ownerAgentId: agentId, status: "active" });
    await db.insert(issues).values({
      id: issueId, companyId, missionId, title: "Build report",
      originKind: "workflow_execution", originRunId: runId, status: "done",
    });
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: `wf-${wfId.slice(0, 8)}`,
      stepsJson: [{ id: PRODUCER_STEP_ID, name: "Build", agentId, dependencies: [], graphWorkProductRequired: true }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      id: stepRunId, workflowRunId: runId, stepId: PRODUCER_STEP_ID, issueId,
      status: "completed", executionGeneration: 0, retryCount: 0, iterationIndex: 0,
    });

    const attemptProof = {
      schemaVersion: 1 as const,
      companyId,
      agentId,
      issueId,
      missionId,
      workflowRunId: runId,
      stepRunId,
      executionGeneration: 0,
      retryCount: 0,
      iterationIndex: 0,
      wakeupRequestId: wakeId,
      parentHeartbeatRunId: null,
    };
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      requestKind: "workflow_step_runnable",
      issueId,
      missionId,
      workflowRunId: runId,
      workflowStepRunId: input.linkHeartbeatToStep ? stepRunId : null,
      workflowExecutionGeneration: input.linkHeartbeatToStep ? 0 : null,
      status: "claimed",
      runId: heartbeatId,
      requestedAt: new Date("2026-11-28T00:00:01.000Z"),
      requestedByActorType: "system",
      requestedByActorId: "test-seed",
      payload: {
        issueId,
        workflowRunId: runId,
        workflowStepRunId: input.linkHeartbeatToStep ? stepRunId : null,
        __paperclipWorkflowProducerAttempt: input.linkHeartbeatToStep ? attemptProof : null,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatId,
      companyId,
      agentId,
      issueId,
      status: "succeeded",
      startedAt: new Date("2026-11-28T00:00:02.000Z"),
      wakeupRequestId: wakeId,
      workflowStepRunId: input.linkHeartbeatToStep ? stepRunId : null,
      workflowExecutionGeneration: input.linkHeartbeatToStep ? 0 : null,
    });

    const file = path.join(dir, `${issueId}.json`);
    await writeFile(file, "{}");
    const [product] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      provider: "local_file",
      type: "document",
      title: "content.json",
      status: "active",
      metadata: { path: file },
      createdByRunId: heartbeatId,
    }).returning();

    return { companyId, missionId, runId, stepRunId, heartbeatId, productId: product!.id };
  }

  const select = (companyId: string, runId: string) => selectOfficialWorkProduct(db, {
    companyId, workflowRunId: runId, stepId: PRODUCER_STEP_ID,
    selector: { type: "document", title: "content.json" },
  });

  it("resolves a producer-step product whose workflowProducer stamp is missing when createdByRunId proves the same dispatch chain", async () => {
    const f = await seedDegradedProducerProduct({ linkHeartbeatToStep: true });
    const selected = await select(f.companyId, f.runId);
    expect(selected.product.id).toBe(f.productId);
    expect(selected.producer.heartbeatRunId).toBe(f.heartbeatId);
    expect(selected.producer.stepRunId).toBe(f.stepRunId);
    expect(selected.producer.executionGeneration).toBe(0);
    expect(selected.file).toBeTruthy();
  });

  it("keeps fencing the product when the createdByRunId heartbeat is not linked to the producer step run", async () => {
    const f = await seedDegradedProducerProduct({ linkHeartbeatToStep: false });
    await expect(select(f.companyId, f.runId)).rejects.toThrow("workproduct_selector_provenance_missing");
  });
});
