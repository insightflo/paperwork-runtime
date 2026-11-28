// [파일 목적] Stage 44 W3 — exception huddle telemetry GET 라우트 계약 테스트(실제 PGlite DB).
// [범위] 회사 전체/미션 범위 200 응답, telemetry 고정 경로의 threadId wildcard 우선 회피,
//        missionId 배열 400, 타회사 에이전트 403.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collabChannels, collabMessages, collabThreads, companies, type Db } from "@paperclipai/db";
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
const telemetryPath = (companyId: string) => `/api/companies/${companyId}/collab-channels/huddles/telemetry`;

async function seedCompany() {
  const [company] = await db.insert(companies).values({
    name: `Telemetry-${randomUUID()}`,
    issuePrefix: randomUUID(),
  }).returning();
  return company;
}

function huddleMetadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-open",
    workflowRunId: "run-1",
    sourceStepId: "qa-step",
    sourceIssueId: null,
    workProductLinks: [],
    participants: { ownerAgentId: "owner", producerAgentId: "producer", validatorAgentId: "validator" },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-11-28T01:05:00.000Z",
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function decidedMetadata(missionId: string) {
  return huddleMetadata({
    missionId,
    workflowRunId: `run-${missionId}`,
    status: "decided",
    currentRound: 2,
    decision: {
      kind: "escalate",
      rationale: "The validator could not clear the failure.",
      escalationReason: "Needs operator intervention",
      forcedByChair: false,
    },
    decidedByAgentId: "owner",
    decidedAt: "2026-11-28T01:04:00.000Z",
  });
}

async function insertHuddleSnapshot(companyId: string, metadata: Record<string, unknown>) {
  const suffix = randomUUID();
  const [channel] = await db.insert(collabChannels).values({
    companyId,
    slug: `huddle-telemetry-${suffix}`,
    name: `Huddle Telemetry ${suffix}`,
    memberAgentIds: [],
  }).returning();
  const [thread] = await db.insert(collabThreads).values({
    companyId,
    channelId: channel.id,
    title: `Exception huddle ${suffix}`,
  }).returning();
  await db.insert(collabMessages).values({
    companyId,
    channelId: channel.id,
    threadId: thread.id,
    authorType: "system",
    authorId: "exception-huddle-test",
    actionKind: "message",
    body: "exception huddle snapshot",
    metadata,
  });
  return thread;
}

describe("collab channels huddle telemetry route", () => {
  it("returns company-wide telemetry with missionId null", async () => {
    const company = await seedCompany();
    await insertHuddleSnapshot(company.id, huddleMetadata({ missionId: "mission-open" }));
    await insertHuddleSnapshot(company.id, decidedMetadata("mission-decided"));

    const res = await request(createApp(db, board(company.id))).get(telemetryPath(company.id));

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.missionId).toBeNull();
    expect(res.body.summary).toMatchObject({
      total: 2,
      averageRoundsOnDecided: 2,
      timeoutRate: 0,
      chairForcedDecisionCount: 0,
      resolutionRate: 0.5,
    });
    expect(res.body.summary.byStatus).toStrictEqual({ open: 1, timed_out: 0, decided: 1, cancelled: 0 });
    expect(res.body.summary.byDecisionKind.escalate).toBe(1);
  });

  it("returns mission-scoped telemetry for a missionId query", async () => {
    const company = await seedCompany();
    await insertHuddleSnapshot(company.id, huddleMetadata({
      missionId: "mission-filter",
      status: "timed_out",
      currentRound: 2,
    }));
    await insertHuddleSnapshot(company.id, huddleMetadata({ missionId: "mission-other" }));

    const res = await request(createApp(db, board(company.id)))
      .get(`${telemetryPath(company.id)}?missionId=mission-filter`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.missionId).toBe("mission-filter");
    expect(res.body.summary.total).toBe(1);
    expect(res.body.summary.byStatus).toStrictEqual({ open: 0, timed_out: 1, decided: 0, cancelled: 0 });
    expect(res.body.summary.timeoutRate).toBe(1);
    expect(res.body.summary.resolutionRate).toBe(0);
  });

  it("rejects repeated missionId query params as non-string input", async () => {
    const company = await seedCompany();

    const res = await request(createApp(db, board(company.id)))
      .get(`${telemetryPath(company.id)}?missionId=mission-one&missionId=mission-two`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missionId must be a string");
  });

  it("rejects an agent actor from another company", async () => {
    const company = await seedCompany();

    const res = await request(createApp(db, { type: "agent", companyId: randomUUID() }))
      .get(telemetryPath(company.id));

    expect(res.status).toBe(403);
  });
});
