// [파일 목적] Stage 29 W2 — collab-channels 서비스·라우트 통합 테스트(실제 PGlite DB).
// [범위] 채널 생성/조회(slug 파생·회사 내 유니크), 스레드 생성 + 초기 메시지, 메시지 전송/user_steer,
//        paused → resume 라이프사이클, wakeup 큐 브리지(사람 발화 wake 의 requestedByActorType:"user"),
//        타회사 403·미인증 401·검증 400, 서비스 계층의 타입화된 409/422 거부 코드.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, collabMessages, collabThreads, companies, type Db } from "@paperclipai/db";
import { collabChannelsRoutes } from "../routes/collab-channels.js";
import { collabChannelsService } from "../services/collab-channels.js";
import { errorHandler } from "../middleware/index.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

type TestActor = { type: "board" | "agent" | "none"; userId?: string; companyId?: string; source?: string };

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
  const [company] = await db.insert(companies).values({ name: `Co-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [alpha] = await db.insert(agents).values({ companyId: company.id, name: "alpha", status: "running" }).returning();
  const [beta] = await db.insert(agents).values({ companyId: company.id, name: "beta", status: "running" }).returning();
  return { company, alpha, beta };
}

const board = (companyId: string) => ({ type: "board" as const, userId: "local-board", companyId });
const path = (companyId: string) => `/api/companies/${companyId}/collab-channels`;

async function createChannel(db: Db, companyId: string, memberAgentIds: string[], leadAgentId?: string) {
  const res = await request(createApp(db, board(companyId)))
    .post(path(companyId))
    .send({ name: "Design Crew", memberAgentIds, ...(leadAgentId ? { leadAgentId } : {}) });
  expect(res.status).toBe(201);
  return res.body as { id: string; slug: string };
}

async function wakeupsForThread(threadId: string) {
  const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.source, "on_demand"));
  return rows.filter((row) => (row.payload as { threadId?: string } | null)?.threadId === threadId);
}

describe("collab channels routes", () => {
  it("creates and lists channels with a derived slug", async () => {
    const { company, alpha, beta } = await seedWorld();
    const res = await request(createApp(db, board(company.id)))
      .post(path(company.id))
      .send({ name: "Design Crew", memberAgentIds: [alpha.id, beta.id] });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe("design-crew");
    expect(res.body.memberAgentIds).toEqual([alpha.id, beta.id]);
    expect(res.body.leadAgentId).toBeNull();
    const list = await request(createApp(db, board(company.id))).get(path(company.id));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(res.body.id);
  });

  it("derives unique slugs for duplicate channel names", async () => {
    const { company, alpha, beta } = await seedWorld();
    const first = await createChannel(db, company.id, [alpha.id, beta.id]);
    const second = await createChannel(db, company.id, [alpha.id, beta.id]);
    expect(first.slug).toBe("design-crew");
    expect(second.slug).toBe("design-crew-2");
  });

  it("creates a thread with an initial message and enqueues a user wake", async () => {
    const { company, alpha, beta } = await seedWorld();
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const res = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads`)
      .send({ title: "Launch review", body: "please review @alpha" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    const threadId = res.body.id as string;
    const messages = await request(createApp(db, board(company.id)))
      .get(`${path(company.id)}/${channel.id}/threads/${threadId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body).toHaveLength(1);
    expect(messages.body[0].authorType).toBe("user");
    expect(messages.body[0].expectsReply).toBe(true);
    const wakes = await wakeupsForThread(threadId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId: alpha.id,
      companyId: company.id,
      source: "on_demand",
      triggerDetail: "collab_channel",
      reason: "collab_thread_message",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      status: "queued",
    });
    expect(wakes[0].payload).toMatchObject({ channelId: channel.id, threadId, messageId: messages.body[0].id, actionKind: "message" });
  });

  it("posts user messages and user_steer with user-actor wake rows", async () => {
    const { company, alpha, beta } = await seedWorld();
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const threadRes = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads`)
      .send({ title: "Steer me", body: "kick off @beta" });
    const threadId = threadRes.body.id as string;
    const messageRes = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads/${threadId}/messages`)
      .send({ body: "focus on the pricing page @alpha" });
    expect(messageRes.status).toBe(201);
    expect(messageRes.body.actionKind).toBe("message");
    const steerRes = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads/${threadId}/messages`)
      .send({ body: "actually reverse the order @alpha", actionKind: "user_steer" });
    expect(steerRes.status).toBe(201);
    expect(steerRes.body.actionKind).toBe("user_steer");
    const wakes = await wakeupsForThread(threadId);
    expect(wakes).toHaveLength(3);
    expect(wakes.every((wake) => wake.requestedByActorType === "user")).toBe(true);
    const [thread] = await db.select().from(collabThreads).where(eq(collabThreads.id, threadId));
    expect(thread.status).toBe("open");
  });

  it("resumes a paused thread: reset counters, system note, owner wake, second resume 409", async () => {
    const { company, alpha, beta } = await seedWorld();
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const [thread] = await db.insert(collabThreads).values({
      companyId: company.id, channelId: channel.id, title: "Paused work", status: "paused",
      ownerAgentId: beta.id, assignmentCount: 3,
    }).returning();
    const res = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads/${thread.id}/resume`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
    expect(res.body.assignmentCount).toBe(0);
    const [systemNote] = await db.select().from(collabMessages)
      .where(and(eq(collabMessages.threadId, thread.id), eq(collabMessages.authorType, "system")));
    expect(systemNote.actionKind).toBe("message");
    const wakes = await wakeupsForThread(thread.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: beta.id, requestedByActorType: "user", requestedByActorId: "local-board" });
    const again = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads/${thread.id}/resume`)
      .send({});
    expect(again.status).toBe(409);
  });

  it("enforces company access and validation", async () => {
    const { company, alpha, beta } = await seedWorld();
    const [otherCompany] = await db.insert(companies).values({ name: `Other-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
    const forbiddenRes = await request(createApp(db, { type: "agent", companyId: otherCompany.id })).get(path(company.id));
    expect(forbiddenRes.status).toBe(403);
    const unauthRes = await request(createApp(db, { type: "none" })).get(path(company.id));
    expect(unauthRes.status).toBe(401);
    const badChannel = await request(createApp(db, board(company.id)))
      .post(path(company.id)).send({ name: "", memberAgentIds: [alpha.id, beta.id] });
    expect(badChannel.status).toBe(400);
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const badThread = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads`).send({ body: "no title" });
    expect(badThread.status).toBe(400);
    const badMessage = await request(createApp(db, board(company.id)))
      .post(`${path(company.id)}/${channel.id}/threads/${randomUUID()}/messages`)
      .send({ body: "" });
    expect(badMessage.status).toBe(400);
  });
});

describe("collab channels service typed action errors", () => {
  async function seedThread(companyId: string, channelId: string, extra: Partial<typeof collabThreads.$inferInsert>) {
    const [thread] = await db.insert(collabThreads).values({ companyId, channelId, title: "T", ...extra }).returning();
    return thread;
  }

  it("rejects agent messages on paused threads with 409 thread_paused_for_approval", async () => {
    const { company, alpha, beta } = await seedWorld();
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const thread = await seedThread(company.id, channel.id, { status: "paused" });
    await expect(collabChannelsService(db).postMessage(company.id, channel.id, thread.id, {
      body: "agent nudge", authorType: "agent", authorId: alpha.id, actionKind: "message",
    })).rejects.toMatchObject({ status: 409, code: "thread_paused_for_approval" });
  });

  it("requires a target agent for channel_assign with 422 target_agent_required", async () => {
    const { company, alpha, beta } = await seedWorld();
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const thread = await seedThread(company.id, channel.id, { status: "open" });
    await expect(collabChannelsService(db).postMessage(company.id, channel.id, thread.id, {
      body: "take it", authorType: "agent", authorId: alpha.id, actionKind: "channel_assign",
    })).rejects.toMatchObject({ status: 422, code: "target_agent_required" });
  });

  it("rejects channel replies beyond the limit with 409 channel_reply_limit_exceeded", async () => {
    const { company, alpha, beta } = await seedWorld();
    const channel = await createChannel(db, company.id, [alpha.id, beta.id]);
    const thread = await seedThread(company.id, channel.id, { status: "open", replyCount: 2 });
    await expect(collabChannelsService(db).postMessage(company.id, channel.id, thread.id, {
      body: "one more channel reply", authorType: "agent", authorId: alpha.id, actionKind: "channel_reply",
    })).rejects.toMatchObject({ status: 409, code: "channel_reply_limit_exceeded" });
  });
});
