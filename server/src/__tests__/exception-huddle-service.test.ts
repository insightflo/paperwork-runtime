// [파일 목적] Stage 42 W6 — exception huddle 서비스·REST 라우트 통합 테스트(실제 PGlite DB).
// [범위] 분류기 부적합 시 쓰기 0건, 첫 QA 반려 huddle 개최/wake-up, 2라운드 상한·5분 타임아웃,
//        비참여자 409, Owner 전용 구조화 결정 403/200 및 스레드 resolved 영속화.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  collabChannels,
  collabMessages,
  collabThreads,
  companies,
  type Db,
} from "@paperclipai/db";
import { collabChannelsRoutes } from "../routes/collab-channels.js";
import { errorHandler } from "../middleware/index.js";
import {
  conveneExceptionHuddle,
  type ConveneExceptionHuddleInput,
} from "../services/missions/exception-huddle-service.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

type TestActor = { type: "board" | "agent" | "none"; userId?: string; companyId?: string; agentId?: string };

function createApp(db: Db, actor: TestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = { source: "local_implicit", ...actor };
    next();
  });
  app.use("/api", collabChannelsRoutes(db));
  app.use(errorHandler);
  return app;
}

let db: Db;
let closeDb: () => void = () => undefined;
beforeAll(async () => {
  const terminal = await terminalDatabase();
  db = terminal.db;
  closeDb = terminal.close;
}, 60_000);
afterAll(() => closeDb());

async function seedWorld() {
  const [company] = await db.insert(companies).values({ name: `Huddle-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [owner] = await db.insert(agents).values({ companyId: company.id, name: `owner-${randomUUID()}`, status: "running" }).returning();
  const [producer] = await db.insert(agents).values({ companyId: company.id, name: `producer-${randomUUID()}`, status: "running" }).returning();
  const [validator] = await db.insert(agents).values({ companyId: company.id, name: `validator-${randomUUID()}`, status: "running" }).returning();
  const [outsider] = await db.insert(agents).values({ companyId: company.id, name: `outsider-${randomUUID()}`, status: "running" }).returning();
  return { company, owner, producer, validator, outsider };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

function huddleInput(world: World, overrides: Partial<ConveneExceptionHuddleInput> = {}): ConveneExceptionHuddleInput {
  return {
    companyId: world.company.id,
    missionId: randomUUID(),
    workflowRunId: randomUUID(),
    sourceStepId: "qa-review",
    sourceIssueId: randomUUID(),
    ownerAgentId: world.owner.id,
    producerAgentId: world.producer.id,
    validatorAgentId: world.validator.id,
    workProductLinks: ["work-product://draft-report"],
    failureSummary: "QA rejected unsupported claims in the draft",
    verdict: "REQUEST_CHANGES",
    failureKind: "qa_rejection",
    qaFailureCount: 1,
    now: new Date("2026-11-28T01:00:00.000Z"),
    ...overrides,
  };
}

function huddlePayload(world: World, overrides: Record<string, unknown> = {}) {
  const input = huddleInput(world);
  const { companyId: _companyId, now: _now, maxRounds: _maxRounds, timeoutMs: _timeoutMs, ...body } = input;
  return { ...body, ...overrides };
}

const boardActor = (companyId: string) => ({ type: "board" as const, userId: "local-board", companyId });
const huddlesPath = (companyId: string) => `/api/companies/${companyId}/collab-channels/huddles`;

async function writeRowCounts() {
  const rows = await Promise.all([
    db.select().from(collabChannels),
    db.select().from(collabThreads),
    db.select().from(collabMessages),
    db.select().from(agentWakeupRequests),
  ]);
  return rows.map((row) => row.length);
}

async function wakeupsForThread(threadId: string) {
  const rows = await db.select().from(agentWakeupRequests);
  return rows.filter((row) => (row.payload as { threadId?: string } | null)?.threadId === threadId);
}

describe("exception huddle service persistence", () => {
  it("rejects runtime, selector, and quota failures without any database writes", async () => {
    const world = await seedWorld();
    const before = await writeRowCounts();
    for (const errorCode of ["tool_execution_failed", "workproduct_selector_stale_producer", "429"]) {
      const result = await conveneExceptionHuddle(db, huddleInput(world, { errorCode }));
      expect(result.convened).toBe(false);
      if (!result.convened) expect(result.eligibility.eligible).toBe(false);
    }
    expect(await writeRowCounts()).toEqual(before);
  });

  it("convenes the first QA rejection with channel, seed metadata, and three deduped wakeups", async () => {
    const world = await seedWorld();
    const input = huddleInput(world);
    const result = await conveneExceptionHuddle(db, input);
    expect(result.convened).toBe(true);
    if (!result.convened) throw new Error("expected huddle to convene");
    const [channel] = await db.select().from(collabChannels).where(eq(collabChannels.id, result.channelId));
    expect(channel).toMatchObject({
      slug: `mission-huddle-${input.missionId.slice(0, 8)}`,
      memberAgentIds: [world.owner.id, world.producer.id, world.validator.id],
      leadAgentId: world.owner.id,
    });
    const [thread] = await db.select().from(collabThreads).where(eq(collabThreads.id, result.threadId));
    expect(thread).toMatchObject({
      status: "open",
      ownerAgentId: world.owner.id,
      rootIssueId: input.sourceIssueId,
    });
    expect(thread.title).toContain("[Huddle] qa-review:");
    const messages = await db.select().from(collabMessages).where(eq(collabMessages.threadId, result.threadId));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ authorType: "system", actionKind: "message", expectsReply: true });
    expect(messages[0].metadata).toMatchObject({
      schemaVersion: "workflow.exception-huddle.v1",
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      sourceStepId: input.sourceStepId,
      sourceIssueId: input.sourceIssueId,
      workProductLinks: input.workProductLinks,
      failureSummary: input.failureSummary,
      currentRound: 1,
      maxRounds: 2,
      status: "open",
      roundTurns: { "1": [], "2": [] },
    });
    const wakes = await wakeupsForThread(result.threadId);
    expect(wakes).toHaveLength(3);
    expect(wakes.map((wake) => wake.agentId).sort()).toEqual([world.owner.id, world.producer.id, world.validator.id].sort());
    for (const wake of wakes) {
      expect(wake).toMatchObject({
        source: "on_demand",
        triggerDetail: "exception_huddle_convened",
        missionId: input.missionId,
        workflowRunId: input.workflowRunId,
      });
    }
  });
});

describe("exception huddle routes", () => {
  async function conveneThroughRoute(world: World) {
    const res = await request(createApp(db, boardActor(world.company.id)))
      .post(huddlesPath(world.company.id))
      .send(huddlePayload(world));
    expect(res.status).toBe(201);
    return res.body as { threadId: string; channelId: string };
  }

  it("creates, reads, validates, and returns 404 for missing huddles", async () => {
    const world = await seedWorld();
    const bad = await request(createApp(db, boardActor(world.company.id)))
      .post(huddlesPath(world.company.id))
      .send({ ...huddlePayload(world), failureSummary: "" });
    expect(bad.status).toBe(400);
    const created = await conveneThroughRoute(world);
    const res = await request(createApp(db, boardActor(world.company.id)))
      .get(`${huddlesPath(world.company.id)}/${created.threadId}`);
    expect(res.status).toBe(200);
    expect(res.body.thread.status).toBe("open");
    expect(res.body.huddle.schemaVersion).toBe("workflow.exception-huddle.v1");
    expect(res.body.messages[0].metadata.failureSummary).toContain("QA rejected");
    const missing = await request(createApp(db, boardActor(world.company.id)))
      .get(`${huddlesPath(world.company.id)}/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("returns 409 for non-participants and after the two-round cap", async () => {
    const world = await seedWorld();
    const created = await conveneThroughRoute(world);
    const postTurn = (actorAgentId: string) => request(createApp(db, boardActor(world.company.id)))
      .post(`${huddlesPath(world.company.id)}/${created.threadId}/turns`)
      .send({ actorAgentId, body: "evidence and display notes only" });
    const outsider = await postTurn(world.outsider.id);
    expect(outsider.status).toBe(409);
    expect(outsider.body.error).toBe("huddle_actor_not_participant");
    for (const actor of [world.producer, world.validator, world.producer, world.validator]) {
      const res = await postTurn(actor.id);
      expect(res.status).toBe(201);
    }
    const capped = await postTurn(world.owner.id);
    expect(capped.status).toBe(409);
    expect(capped.body.error).toBe("huddle_round_cap_reached_chair_decision_required");
  });

  it("returns 409 after the five-minute timeout", async () => {
    const world = await seedWorld();
    const result = await conveneExceptionHuddle(db, huddleInput(world, {
      now: new Date(Date.now() - 10_000),
      timeoutMs: 1_000,
    }));
    expect(result.convened).toBe(true);
    if (!result.convened) throw new Error("expected huddle to convene");
    const res = await request(createApp(db, boardActor(world.company.id)))
      .post(`${huddlesPath(world.company.id)}/${result.threadId}/turns`)
      .send({ actorAgentId: world.producer.id, body: "too late" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("huddle_timed_out_chair_decision_required");
  });

  it("enforces owner-only structured decisions and persists thread resolution", async () => {
    const world = await seedWorld();
    const created = await conveneThroughRoute(world);
    const decidePath = `${huddlesPath(world.company.id)}/${created.threadId}/decide`;
    const invalid = await request(createApp(db, boardActor(world.company.id)))
      .post(decidePath)
      .send({ actorAgentId: world.owner.id, decision: { kind: "retry_with_guidance", rationale: "retry" } });
    expect(invalid.status).toBe(400);
    const decision = {
      kind: "retry_with_guidance",
      rationale: "The first draft missed the required evidence.",
      guidance: "Cite the exact source and rerun QA.",
    };
    const nonOwner = await request(createApp(db, boardActor(world.company.id)))
      .post(decidePath)
      .send({ actorAgentId: world.producer.id, decision });
    expect(nonOwner.status).toBe(403);
    expect(nonOwner.body.error).toBe("huddle_chair_only_decision");
    const decided = await request(createApp(db, boardActor(world.company.id)))
      .post(decidePath)
      .send({ actorAgentId: world.owner.id, decision });
    expect(decided.status).toBe(200);
    expect(decided.body.nextAction).toBe("retry_with_guidance");
    expect(decided.body.huddle).toMatchObject({
      status: "decided",
      decidedByAgentId: world.owner.id,
      decision: { kind: "retry_with_guidance", guidance: decision.guidance },
    });
    const [thread] = await db.select().from(collabThreads).where(eq(collabThreads.id, created.threadId));
    expect(thread.status).toBe("resolved");
    const read = await request(createApp(db, boardActor(world.company.id)))
      .get(`${huddlesPath(world.company.id)}/${created.threadId}`);
    expect(read.status).toBe(200);
    expect(read.body.messages.some((message: { actionKind?: string }) => message.actionKind === "channel_result")).toBe(true);
    const seed = read.body.messages.find((message: { metadata?: { schemaVersion?: string } }) =>
      message.metadata?.schemaVersion === "workflow.exception-huddle.v1");
    expect(seed.metadata).toMatchObject({ status: "decided", decision: { kind: "retry_with_guidance" } });
    const again = await request(createApp(db, boardActor(world.company.id)))
      .post(decidePath)
      .send({ actorAgentId: world.owner.id, decision });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("huddle_already_closed");
  });
});
