// [파일 목적] Stage 44 W8 — exception huddle audit 조회 REST 라우트 통합 테스트(실제 PGlite DB).
// [범위] company-wide 조회, missionId/threadId/limit 필터, 잘못된 query 400, 타회사 agent 403.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, missions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { collabChannelsRoutes } from "../routes/collab-channels.js";
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

const board = (companyId: string) => ({ type: "board" as const, userId: "local-board", companyId });
const auditPath = (companyId: string) => `/api/companies/${companyId}/collab-channels/huddles/audit`;

async function seedAuditWorld() {
  const [company] = await db.insert(companies).values({ name: `Audit-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [otherCompany] = await db.insert(companies).values({ name: `Other-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [owner] = await db.insert(agents).values({ companyId: company.id, name: "owner", status: "running" }).returning();
  const [missionA] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: owner.id, title: "Mission A" }).returning();
  const [missionB] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: owner.id, title: "Mission B" }).returning();
  const threadA = randomUUID();
  const threadB = randomUUID();

  async function addEvent(overrides: {
    createdAt: string;
    eventType?: string;
    companyId?: string;
    missionId?: string | null;
    threadId?: string;
    decisionKind?: string;
  }) {
    const threadId = overrides.threadId ?? threadA;
    const [row] = await db.insert(workflowTransitionEvents).values({
      companyId: overrides.companyId ?? company.id,
      missionId: overrides.missionId === undefined ? missionA.id : overrides.missionId,
      eventType: overrides.eventType ?? "exception_huddle_decision",
      layer: "mission",
      payload: {
        threadId,
        decisionKind: overrides.decisionKind ?? "retry_with_guidance",
        decidedByAgentId: owner.id,
      },
      createdAt: new Date(overrides.createdAt),
    }).returning();
    return row;
  }

  const oldest = await addEvent({ createdAt: "2026-11-28T01:00:00.000Z", eventType: "exception_huddle_convened" });
  const middle = await addEvent({ createdAt: "2026-11-28T02:00:00.000Z", eventType: "exception_huddle_turn_posted" });
  const newest = await addEvent({
    createdAt: "2026-11-28T03:00:00.000Z",
    missionId: missionB.id,
    threadId: threadB,
    decisionKind: "escalate",
  });
  await addEvent({ createdAt: "2026-11-28T04:00:00.000Z", eventType: "workflow_step_failed" });
  await addEvent({ createdAt: "2026-11-28T05:00:00.000Z", companyId: otherCompany.id, missionId: null });
  return { company, otherCompany, owner, missionA, missionB, threadA, threadB, oldest, middle, newest };
}

describe("exception huddle audit route", () => {
  it("returns company-wide audit entries newest first in the route envelope", async () => {
    const world = await seedAuditWorld();
    const res = await request(createApp(db, board(world.company.id))).get(auditPath(world.company.id));

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(world.company.id);
    expect(res.body.entries.map((entry: { id: string }) => entry.id)).toEqual([world.newest.id, world.middle.id, world.oldest.id]);
    expect(res.body.entries[0]).toMatchObject({
      missionId: world.missionB.id,
      threadId: world.threadB,
      decisionKind: "escalate",
      decidedByAgentId: world.owner.id,
    });
    expect(res.body.entries[0].payload.threadId).toBe(world.threadB);
  });

  it("applies missionId, threadId, and limit query filters", async () => {
    const world = await seedAuditWorld();
    const app = createApp(db, board(world.company.id));

    const missionRes = await request(app).get(auditPath(world.company.id)).query({ missionId: world.missionA.id });
    expect(missionRes.status).toBe(200);
    expect(missionRes.body.companyId).toBe(world.company.id);
    expect(missionRes.body.entries.map((entry: { id: string }) => entry.id)).toEqual([world.middle.id, world.oldest.id]);

    const threadRes = await request(app).get(auditPath(world.company.id)).query({ threadId: world.threadA });
    expect(threadRes.status).toBe(200);
    expect(threadRes.body.entries.map((entry: { id: string }) => entry.id)).toEqual([world.middle.id, world.oldest.id]);

    const limitRes = await request(app).get(auditPath(world.company.id)).query({ limit: "1" });
    expect(limitRes.status).toBe(200);
    expect(limitRes.body.entries).toHaveLength(1);
    expect(limitRes.body.entries[0].id).toBe(world.newest.id);

    const combinedRes = await request(app).get(auditPath(world.company.id)).query({
      missionId: world.missionB.id,
      threadId: world.threadB,
      limit: "1",
    });
    expect(combinedRes.status).toBe(200);
    expect(combinedRes.body.entries.map((entry: { id: string }) => entry.id)).toEqual([world.newest.id]);

    const blankRes = await request(app).get(`${auditPath(world.company.id)}?missionId=%20&threadId=%20`);
    expect(blankRes.status).toBe(200);
    expect(blankRes.body.entries).toHaveLength(3);
  });

  it("rejects invalid limit and repeated missionId/threadId query params with 400", async () => {
    const world = await seedAuditWorld();
    const app = createApp(db, board(world.company.id));
    const invalidQueries = [
      "limit=abc",
      "limit=0",
      "limit=-1",
      "limit=1.5",
      "limit=1&limit=2",
      `missionId=${randomUUID()}&missionId=${randomUUID()}`,
      `threadId=${randomUUID()}&threadId=${randomUUID()}`,
    ];

    for (const query of invalidQueries) {
      const res = await request(app).get(`${auditPath(world.company.id)}?${query}`);
      expect(res.status).toBe(400);
    }
  });

  it("rejects cross-company agent access with 403", async () => {
    const world = await seedAuditWorld();
    const res = await request(createApp(db, { type: "agent", companyId: world.otherCompany.id }))
      .get(auditPath(world.company.id));

    expect(res.status).toBe(403);
  });
});
