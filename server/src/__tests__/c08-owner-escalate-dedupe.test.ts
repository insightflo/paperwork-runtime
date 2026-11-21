// [R3 2026-11-21] 같은 이슈 미해결 사람 상정 중복 게이트: oversight 이슈에 recoveryNeeded 인
// 사람 요청이 열려 있으면 replay·CAS 교체가 아닌 새 사람 제출을 422 로 거부한다. 첫 제출(201),
// 재전송 replay(201), 카드 답변·종결 뒤 교체/재발(201), unblock legacy 무키 수정 계약은 불변이다.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string; issueId: string; runId: string };
const keyed = (requestKey = "A", expectedCurrentLifetimeId: string | null = null,
  reason = "blocked"): MissionOwnerDecisionSubmit => ({ decision: "request_input", reason,
  nextAction: "사람 확인", evidence: "원천 근거",
  humanRequest: { schemaVersion: 1, requestKey, expectedCurrentLifetimeId } });

describeDb("C08 same-issue unresolved human-submission dedupe gate", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-escalate-dedupe-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });
  async function world(oversight = true): Promise<World> {
    const sourceId = randomUUID();
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      issueId: randomUUID(), runId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "Dedupe", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "Dedupe", status: "active" });
    await db.insert(issues).values([
      { id: sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.issueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.agentId,
        originKind: oversight ? "mission_main_executor_oversight" : "mission_main_executor_unblock",
        originId: oversight ? null : sourceId },
    ]);
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values([oldRunId, w.runId].map((id) => ({ id,
      companyId: w.companyId, agentId: w.agentId, issueId: w.issueId,
      status: id === w.runId ? "running" : "succeeded" })));
    await db.update(issues).set({ checkoutRunId: oldRunId }).where(eq(issues.id, w.issueId));
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

  it("accepts the first human submission on an oversight issue (201)", async () => {
    const w = await world();
    const first = await post(w, keyed("dup-1"));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.eventId).toEqual(expect.any(String));
    expect(first.body.lifetimeId).toEqual(expect.any(String));
  });

  it("rejects a new human submission while the same issue still has an unresolved request (422 duplicate)", async () => {
    const w = await world();
    expect((await post(w, keyed("dup-1"))).status).toBe(201);
    const duplicate = await post(w, { decision: "request_input", reason: "같은 실패 재상정", nextAction: "확인" });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(422);
    expect(duplicate.body.details.code).toBe("mission_owner_duplicate_human_submission");
    expect(duplicate.body.details).toMatchObject({ issueId: w.issueId, missionId: w.missionId });
    // 카드 답변 뒤에도 요청이 열려 있는 동안 stale lifetime 을 명시한 제출은 같은 422다.
    await answerPendingCard(w);
    const staleKeyed = await post(w, keyed("dup-2", randomUUID()));
    expect(staleKeyed.status, JSON.stringify(staleKeyed.body)).toBe(422);
    expect(staleKeyed.body.details.code).toBe("mission_owner_duplicate_human_submission");
  });

  it("still merges same-run unkeyed repeats into the existing card on oversight issues (201)", async () => {
    const w = await world();
    const first = await post(w, { decision: "request_input", reason: "첫 상정" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const merged = await post(w, { decision: "request_input", reason: "같은 런 반복 상정" });
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    expect((await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, w.companyId)))
      .filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("keeps exact replay of the current request at 201 while it is still unresolved", async () => {
    const w = await world();
    const first = await post(w, keyed("dup-1"));
    expect(first.status).toBe(201);
    const current = await get(w);
    expect(current.body.recoveryNeeded).toBe(true);
    const replay = await post(w, current.body.resubmit);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toEqual(first.body);
  });

  it("allows a keyed replacement naming the current lifetime once the card is answered (201)", async () => {
    const w = await world();
    const first = await post(w, keyed("dup-1"));
    expect(first.status).toBe(201);
    await answerPendingCard(w);
    const replaced = await post(w, keyed("dup-2", first.body.lifetimeId));
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.lifetimeId).not.toBe(first.body.lifetimeId);
  });

  it("still rejects a keyed resubmission while its card is pending via the existing card gate (422)", async () => {
    const w = await world();
    const first = await post(w, keyed("dup-1"));
    expect(first.status).toBe(201);
    const duplicate = await post(w, keyed("dup-2", first.body.lifetimeId));
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.details.code).toBe("mission_owner_human_input_card_pending");
  });

  it("does not gate legacy unkeyed revisions on unblock issues", async () => {
    const w = await world(false);
    const first = await post(w, { decision: "request_input", reason: "첫 상정" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const revised = await post(w, { decision: "request_input", reason: "수정 상정" });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
  });
});
