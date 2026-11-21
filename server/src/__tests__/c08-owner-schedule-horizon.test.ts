// [R4 2026-11-21] 스케줄 지평 게이트: oversight 이슈에서 미션이 스케줄 구동(triggerSource='schedule'/
// scheduledSlotId 런 → 활성 스케줄 정의)이고 다음 예정 실행이 있으며 같은 워크플로 시리즈의 연속
// 실패 사이클이 2 미만이면 새 사람 상정을 422(mission_owner_premature_human_submission)로 거부한다.
// replay·현재 lifetime 명시 CAS 교체는 기존 중복 게이트와 동일 판정으로 면제된다.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string; issueId: string; runId: string; workflowId: string };
const keyed = (requestKey = "A", expectedCurrentLifetimeId: string | null = null,
  reason = "blocked"): MissionOwnerDecisionSubmit => ({ decision: "request_input", reason,
  nextAction: "사람 확인", evidence: "원천 근거",
  humanRequest: { schemaVersion: 1, requestKey, expectedCurrentLifetimeId } });

describeDb("C08 schedule-horizon gate on owner human submissions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-sched-horizon-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function world(opts: {
    workflowSchedule?: string | null;
    priorFailedRuns?: number;
    currentRunTriggerSource?: string | null;
    currentRunStatus?: string;
  } = {}): Promise<World> {
    const { workflowSchedule = "0 6 * * *", priorFailedRuns = 0,
      currentRunTriggerSource = "schedule", currentRunStatus = "failed" } = opts;
    const w: World = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      issueId: randomUUID(), runId: randomUUID(), workflowId: randomUUID() };
    const now = Date.now();
    await db.insert(companies).values({ id: w.companyId, name: "Horizon",
      issuePrefix: randomUUID(), timezone: "Asia/Seoul" });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(workflowDefinitions).values({ id: w.workflowId, companyId: w.companyId,
      name: "Daily news", status: "active", schedule: workflowSchedule, timezone: "Asia/Seoul",
      stepsJson: [{ id: "collect", name: "Collect", agentId: w.agentId, dependencies: [] }] });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "Horizon", status: "active" });
    await db.insert(issues).values({ id: w.issueId, companyId: w.companyId, missionId: w.missionId,
      title: "Owner action", status: "in_progress", assigneeAgentId: w.agentId,
      originKind: "mission_main_executor_oversight", originId: null });
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values([oldRunId, w.runId].map((id) => ({ id,
      companyId: w.companyId, agentId: w.agentId, issueId: w.issueId,
      status: id === w.runId ? "running" : "succeeded" })));
    await db.update(issues).set({ checkoutRunId: oldRunId }).where(eq(issues.id, w.issueId));
    // 현재 사이클 런 — 이 미션에 붙는 최신 실행.
    await db.insert(workflowRuns).values({ id: randomUUID(), workflowId: w.workflowId,
      companyId: w.companyId, missionId: w.missionId, triggeredBy: "scheduler",
      triggerSource: currentRunTriggerSource, runDate: "2026-11-21",
      status: currentRunStatus, createdAt: new Date(now) });
    // 이전 사이클들 — 같은 워크플로 시리즈의 과거 스케줄 런(사이클마다 별개 미션).
    for (let i = 0; i < priorFailedRuns; i += 1) {
      const priorMissionId = randomUUID();
      await db.insert(missions).values({ id: priorMissionId, companyId: w.companyId,
        ownerAgentId: w.agentId, title: `Prior ${i}`, status: "active" });
      await db.insert(workflowRuns).values({ id: randomUUID(), workflowId: w.workflowId,
        companyId: w.companyId, missionId: priorMissionId, triggeredBy: "scheduler",
        triggerSource: "schedule", runDate: "2026-11-20",
        status: "failed", createdAt: new Date(now - (i + 1) * 86_400_000) });
    }
    return w;
  }
  function app(w: World) {
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: w.agentId, companyId: w.companyId, runId: w.runId,
        isHermesOpsLiaison: false, hermesOpsMode: "advisor" }; next();
    });
    server.use("/api", workflowAgentApiRoutes(db)); server.use(errorHandler); return server;
  }
  const url = (w: World) => `/api/issues/${w.issueId}/owner-recovery/decision`;
  const post = (w: World, data: MissionOwnerDecisionSubmit) => request(app(w)).post(url(w)).send(data);
  const get = (w: World) => request(app(w)).get(`${url(w)}/current`);
  async function answerPendingCard(w: World) {
    const [pending] = (await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, w.companyId)))
      .filter((row) => row.status === "pending");
    if (!pending) throw new Error("expected a pending human card");
    await operatorDecisionWriteService(db).resolve(pending.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "테스트 응답" }, "board");
  }

  it("rejects a first-failure escalation while the schedule still recreates runs (422)", async () => {
    const w = await world();
    const res = await post(w, keyed("sched-1"));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("mission_owner_premature_human_submission");
    expect(res.body.details).toMatchObject({ issueId: w.issueId, missionId: w.missionId,
      workflowId: w.workflowId, consecutiveFailures: 1, suggestedDecision: "no_action_waiting" });
    expect(res.body.details.nextScheduledRun).toEqual(expect.any(String));
  });

  it("accepts the escalation once two consecutive scheduled cycles failed (201)", async () => {
    const w = await world({ priorFailedRuns: 1 });
    const res = await post(w, keyed("sched-1"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.eventId).toEqual(expect.any(String));
  });

  it("does not gate missions whose current run was not schedule-driven (201)", async () => {
    const w = await world({ currentRunTriggerSource: "manual" });
    const res = await post(w, keyed("sched-1"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("does not gate when the workflow schedule is no longer active (201)", async () => {
    const w = await world();
    await db.update(workflowDefinitions).set({ status: "paused" })
      .where(eq(workflowDefinitions.id, w.workflowId));
    const res = await post(w, keyed("sched-1"));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("keeps exact replay exempt after the schedule turns on (201)", async () => {
    const w = await world({ workflowSchedule: null });
    const first = await post(w, keyed("sched-1"));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // 정의에 스케줄이 없던 시점에 제출됐더라도, 이후 스케줄이 켜지면 지평이 생긴다.
    await db.update(workflowDefinitions).set({ schedule: "0 6 * * *" })
      .where(eq(workflowDefinitions.id, w.workflowId));
    const current = await get(w);
    expect(current.body.recoveryNeeded).toBe(true);
    const replay = await post(w, current.body.resubmit);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toEqual(first.body);
  });

  it("keeps keyed CAS replacement naming the current lifetime exempt while gated (201)", async () => {
    const w = await world({ workflowSchedule: null });
    const first = await post(w, keyed("sched-1"));
    expect(first.status).toBe(201);
    await db.update(workflowDefinitions).set({ schedule: "0 6 * * *" })
      .where(eq(workflowDefinitions.id, w.workflowId));
    await answerPendingCard(w);
    const replaced = await post(w, keyed("sched-2", first.body.lifetimeId));
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.lifetimeId).not.toBe(first.body.lifetimeId);
  });
});
