import { randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  missions,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ACTION = "workflow_run.operator_corrected_false_completed";
const REASON = "Source run was marked complete without producing the required work product.";
const COMPLETED_AT = new Date("2026-11-20T09:00:00.000Z");
type MissionStatus = "planning" | "active" | "completed" | "cancelled";

describe("operator correction for false-completed workflow runs", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("operator-correction-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); });

  async function seedRun(
    status: "pending" | "running" | "completed" = "completed",
    missionStatus: MissionStatus = "active",
    stepsJson: Record<string, unknown>[] = [],
  ) {
    const companyId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const ownerAgentId = randomUUID();
    const prefix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    await db.insert(companies).values({ id: companyId, name: "Operator correction", issuePrefix: prefix });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission owner", role: "operator" });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId, title: "False completed mission", status: missionStatus,
      completedAt: missionStatus === "completed" ? COMPLETED_AT : null,
    });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Correction workflow", stepsJson });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      missionId,
      companyId,
      status,
      triggeredBy: "test",
      runDate: "2026-11-26",
      completedAt: status === "completed" ? new Date() : null,
      metadata: {
        carriedInput: "source-value",
        operatorDecisionRestart: { stale: true },
        executionDefinitionVersion: 999,
      },
    });
    return { companyId, missionId, workflowId, runId, ownerAgentId };
  }

  function app(actor: Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", workflowRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  function operatorActor(companyId: string): Request["actor"] {
    return { type: "board", source: "session", userId: "operator-1", isInstanceAdmin: false, companyIds: [companyId] };
  }

  const pathFor = (world: { companyId: string; runId: string }) =>
    `/api/companies/${world.companyId}/workflow-runs/${world.runId}/operator-correction`;

  async function correctionActivity(companyId: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, ACTION)));
  }

  it("creates a fresh same-mission run with audit metadata and no owner restart decision", async () => {
    const world = await seedRun();
    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send({ reason: REASON });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.sourceRunId).toBe(world.runId);
    expect(response.body.replacementRunId).toBe(response.body.runId);
    expect(response.body.replacementRunId).not.toBe(world.runId);
    expect(response.body.missionReopenedFromCompleted).toBe(false);

    const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, world.missionId));
    expect(rows).toHaveLength(2);
    const source = rows.find((row) => row.id === world.runId)!;
    const replacement = rows.find((row) => row.id !== world.runId)!;
    expect(source.status).toBe("completed");
    expect(replacement.missionId).toBe(world.missionId);
    expect(replacement.workflowId).toBe(world.workflowId);
    expect(replacement.triggeredBy).toBe("operator_correction");
    expect(replacement.triggerSource).toBe("operator_correction");
    expect(["pending", "running", "completed"]).toContain(replacement.status);

    const sourceCorrection = source.metadata?.operatorFalseCompletedCorrection as Record<string, unknown>;
    expect(sourceCorrection).toMatchObject({
      schemaVersion: 1,
      reason: REASON,
      correctedByUserId: "operator-1",
      sourceWorkflowRunId: world.runId,
      replacementWorkflowRunId: replacement.id,
    });
    expect(typeof sourceCorrection.correctedAt).toBe("string");
    expect(replacement.metadata?.carriedInput).toBe("source-value");
    expect(replacement.metadata?.operatorDecisionRestart).toBeUndefined();
    const replacementCorrection = replacement.metadata?.operatorFalseCompletedCorrection as Record<string, unknown>;
    expect(replacementCorrection).toMatchObject({ sourceWorkflowRunId: world.runId, reason: REASON });
    expect(replacementCorrection.replacementWorkflowRunId).toBeUndefined();

    const logs = await correctionActivity(world.companyId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorType: "user", actorId: "operator-1", entityType: "workflow_run", entityId: world.runId });
    expect(logs[0].details).toMatchObject({
      reason: REASON,
      missionId: world.missionId,
      workflowId: world.workflowId,
      replacementWorkflowRunId: replacement.id,
    });
    expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(eq(operatorDecisions.companyId, world.companyId))).toEqual([]);
  });

  it("reopens a completed mission to active in the same transaction so the replacement run can start", async () => {
    const world = await seedRun("completed", "completed");
    const [before] = await db.select().from(missions).where(eq(missions.id, world.missionId));
    expect(before.status).toBe("completed");
    expect(before.completedAt).toEqual(COMPLETED_AT);

    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send({ reason: REASON });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.missionReopenedFromCompleted).toBe(true);
    expect(response.body.correction.missionReopenedFromCompleted).toBe(true);

    const [mission] = await db.select().from(missions).where(eq(missions.id, world.missionId));
    expect(mission).toMatchObject({ status: "active", completedAt: null });
    expect(mission.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    // Inside the same transaction trigger creates the run issue and then claimPlainWorkflowStart reads
    // mission status: both reject a completed mission, so the replacement only leaves `pending`
    // (startedAt set) because the reopen preceded the trigger.
    const replacement = (await db.select().from(workflowRuns)
      .where(eq(workflowRuns.id, response.body.replacementRunId)))[0];
    expect(replacement.startedAt).not.toBeNull();
    expect(["running", "completed"]).toContain(replacement.status);
    expect((replacement.metadata?.operatorFalseCompletedCorrection as Record<string, unknown>).missionReopenedFromCompleted).toBe(true);
    const source = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId)))[0];
    expect(source.status).toBe("completed");
    expect((source.metadata?.operatorFalseCompletedCorrection as Record<string, unknown>).missionReopenedFromCompleted).toBe(true);
    const logs = await correctionActivity(world.companyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ missionId: world.missionId, missionReopenedFromCompleted: true });
  });

  it("rolls the mission reopen back together with a failed replacement run creation", async () => {
    // A tool step fails run preparation (tools readiness, else the producer-less structural gate),
    // i.e. after the reopen and before commit: nothing may survive that failure.
    const world = await seedRun("completed", "completed", [
      { id: "gate", name: "Gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], dependencies: [] },
    ]);

    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send({ reason: REASON });
    expect(response.status, JSON.stringify(response.body)).toBe(500);

    const missionsAfter = await db.select().from(missions).where(eq(missions.id, world.missionId));
    expect(missionsAfter).toHaveLength(1);
    expect(missionsAfter[0]).toMatchObject({ status: "completed", completedAt: COMPLETED_AT });
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, world.missionId))).toHaveLength(1);
    expect(await correctionActivity(world.companyId)).toEqual([]);
  });

  it.each(["active", "planning"] as const)("leaves a %s mission untouched (missionReopenedFromCompleted: false)", async (missionStatus) => {
    const world = await seedRun("completed", missionStatus);
    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send({ reason: REASON });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.missionReopenedFromCompleted).toBe(false);
    expect(response.body.correction.missionReopenedFromCompleted).toBe(false);

    const [mission] = await db.select().from(missions).where(eq(missions.id, world.missionId));
    expect(mission.completedAt).toBeNull();
    // A planning mission is activated by the run-start hook, not by the correction itself.
    expect(mission.status).toBe(missionStatus === "planning" ? "active" : missionStatus);
    const logs = await correctionActivity(world.companyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ missionReopenedFromCompleted: false });
  });

  it("rejects a cancelled mission with 409 without mutating the source run or creating a replacement", async () => {
    const world = await seedRun("completed", "cancelled");
    const sourceBefore = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId)))[0];

    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send({ reason: REASON });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("workflow_operator_correction_mission_cancelled");

    const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, world.missionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(sourceBefore);
    expect((await db.select().from(missions).where(eq(missions.id, world.missionId)))[0].status).toBe("cancelled");
    expect(await correctionActivity(world.companyId)).toEqual([]);
  });

  it.each([{}, { reason: "   \n\t  " }])("rejects a blank correction reason with 400 and no writes", async (body) => {
    const world = await seedRun();
    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send(body);
    expect(response.status).toBe(400);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, world.missionId))).toHaveLength(1);
    expect(await correctionActivity(world.companyId)).toEqual([]);
  });

  it("rejects unauthenticated and non-operator callers without creating a replacement", async () => {
    const world = await seedRun();
    const unauthenticated = await request(app({ type: "none", source: "none" })).post(pathFor(world)).send({ reason: REASON });
    expect(unauthenticated.status).toBe(401);
    const agent = await request(app({ type: "agent", source: "agent_key", agentId: world.ownerAgentId, companyId: world.companyId }))
      .post(pathFor(world)).send({ reason: REASON });
    expect(agent.status).toBe(403);
    const boardWithoutCompany = await request(app({ type: "board", source: "session", userId: "outsider", companyIds: [] }))
      .post(pathFor(world)).send({ reason: REASON });
    expect(boardWithoutCompany.status).toBe(403);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, world.missionId))).toHaveLength(1);
    expect(await correctionActivity(world.companyId)).toEqual([]);
  });

  it.each(["pending", "running"] as const)("rejects a still-active %s source run with 409", async (status) => {
    const world = await seedRun(status);
    const response = await request(app(operatorActor(world.companyId))).post(pathFor(world)).send({ reason: REASON });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("workflow_operator_correction_run_active");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, world.missionId))).toHaveLength(1);
    expect(await correctionActivity(world.companyId)).toEqual([]);
  });
});
