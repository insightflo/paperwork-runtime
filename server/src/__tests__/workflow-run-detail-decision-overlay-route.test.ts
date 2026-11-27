// [stage26 s26-w4] workflow run detail 라우트의 stepRuns human_wait 결정 오버레이 시험.
//   operator_decisions 행이 매치되면 해당 step run 응답에 humanWaitDecision
//   {decisionId,status,pausedAt,resolvedAt} 이 붙고, 매치가 없으면 humanWaitDecision 키
//   없이 기존 step run 필드가 전부 보존된다(읽기 전용, 실행 권한 판정 아님).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, issues, operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";

const decisionDefinition = {
  options: [{ id: "approve", label: "Approve", description: null, facts: [], evidenceRefs: [] }],
  actions: [],
  selection: { min: 1, max: 1 },
  comment: { mode: "disabled" as const, label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
};

const T0 = new Date("2026-12-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip run-detail overlay route tests: ${support.reason ?? "unsupported"}`);

describeDb("GET /workflow-runs/:runId/detail step-run human wait decision overlay", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-detail-overlay-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "operator-1", source: "local_implicit" };
      next();
    });
    app.use("/api", workflowRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedWorld() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Route overlay ${companyId.slice(0, 6)}`, issuePrefix: randomUUID() });
    const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Overlay detail flow", stepsJson: [] }).returning();
    const [runWithDecision] = await db.insert(workflowRuns).values({ companyId, workflowId: definition.id, triggeredBy: "manual" }).returning();
    const [runWithoutDecision] = await db.insert(workflowRuns).values({ companyId, workflowId: definition.id, triggeredBy: "manual" }).returning();
    const [issueA, issueB] = await db.insert(issues).values([
      { companyId, title: "Gate step A" }, { companyId, title: "Plain step B" },
    ]).returning();
    const [matchedStep] = await db.insert(workflowStepRuns).values({ workflowRunId: runWithDecision.id, stepId: "gate", issueId: issueA.id, status: "pending" }).returning();
    const [unmatchedStep] = await db.insert(workflowStepRuns).values({ workflowRunId: runWithoutDecision.id, stepId: "plain", issueId: issueB.id, status: "running" }).returning();
    const [decision] = await db.insert(operatorDecisions).values({
      companyId,
      requestKey: randomUUID(),
      requestHash: randomUUID(),
      interactionType: "single_select",
      title: "Human wait gate",
      description: "",
      sourceType: "workflow_step_human_wait",
      sourceId: runWithDecision.id,
      sourceContext: { missionId: null, workflowId: null, workflowRunId: runWithDecision.id, artifactRefs: [] },
      issueId: issueA.id,
      status: "resolved",
      resolvedAt: at(5_000),
      createdAt: at(4_000),
      resolvedByUserId: "operator-1",
      result: { actionId: "approve", outcome: "approve", selectedOptionIds: ["approve"], comment: null },
      definition: decisionDefinition,
    }).returning();
    return { runWithDecision, runWithoutDecision, matchedStep, unmatchedStep, decision };
  }

  it("attaches humanWaitDecision to the matching step run in the run detail response", async () => {
    const world = await seedWorld();
    const res = await request(app).get(`/api/workflow-runs/${world.runWithDecision.id}/detail`);
    expect(res.status).toBe(200);
    const stepRun = res.body.stepRuns[0];
    expect(stepRun.id).toBe(world.matchedStep.id);
    expect(stepRun.humanWaitDecision).toEqual({
      decisionId: world.decision.id,
      status: "resolved",
      pausedAt: at(4_000).toISOString(),
      resolvedAt: at(5_000).toISOString(),
    });
    expect(stepRun.workflowRunId).toBe(world.runWithDecision.id);
    expect(stepRun.issueId).toBe(world.matchedStep.issueId);
  });

  it("preserves every existing step-run field and adds no humanWaitDecision when nothing matches", async () => {
    const world = await seedWorld();
    const res = await request(app).get(`/api/workflow-runs/${world.runWithoutDecision.id}/detail`);
    expect(res.status).toBe(200);
    const stepRun = res.body.stepRuns[0];
    expect(stepRun.id).toBe(world.unmatchedStep.id);
    expect("humanWaitDecision" in stepRun).toBe(false);
    // 보존 검증: 응답 step run 의 모든 기존 필드(라우트 파생 4개 제외)가 DB 행과 동일해야 한다.
    const routeDerivedKeys = new Set(["stepTitle", "stepType", "issueIdentifier", "workProducts"]);
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, world.unmatchedStep.id)).limit(1);
    const rowByIdKey = row as Record<string, unknown>;
    for (const [key, value] of Object.entries(stepRun)) {
      if (routeDerivedKeys.has(key)) continue;
      const rowValue = rowByIdKey[key];
      expect(rowValue).toBeDefined();
      expect(value).toEqual(rowValue instanceof Date ? rowValue.toISOString() : rowValue);
    }
  });
});
