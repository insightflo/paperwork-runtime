// [파일 목적] Stage36 W4 — workspace-primitives 라우트의 Postgres 영속 통합 테스트(실제 PGlite).
// [범위] db를 주입한 라우터: 공유 테이블 생성·행 upsert·오픈 대기 생성·해결이 DB에 저장되고,
//        매 요청마다 새로 만드는 라우터 인스턴스(서버 재시작 시뮬레이션)에서도 동일 JSON 형태로 조회된다.
//        서비스 계층이 직접 기록한 데이터도 라우트가 DB에서 읽어 UI 계약 형태로 매핑함을 확인한다.
//        인메모리 글로벌 스토어와 무관하게 동작함이 이 테스트의 핵심이다.
import { randomUUID } from "node:crypto";
import express, { type Request } from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, type Db } from "@paperclipai/db";
import { agentOpenWaits, agentSharedTables } from "@paperclipai/db/schema/workspace_primitives";
import { errorHandler } from "../middleware/error-handler.js";
import { agentWorkspacePrimitivesRoutes } from "../routes/agent-workspace-primitives.js";
import { createOpenWaitDb, createSharedTableDb } from "../services/workspace-primitives-db-store.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

let db: Db;
let closeDb: () => void = () => undefined;
let companyId: string;
let agentId: string;
let base: string;
let actor: Request["actor"];

beforeAll(async () => {
  const terminal = await terminalDatabase();
  db = terminal.db;
  closeDb = terminal.close;
}, 60_000);
afterAll(() => closeDb());

beforeEach(async () => {
  const [company] = await db.insert(companies).values({ name: `Co-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  companyId = company.id;
  const [agent] = await db.insert(agents).values({ companyId, name: `A-${randomUUID()}`, status: "running" }).returning();
  agentId = agent.id;
  base = `/api/companies/${companyId}`;
  actor = { type: "board", source: "session", userId: "user-1", companyIds: [companyId] };
});

// 매 호출이 새 라우터 인스턴스를 만든다. 서로 다른 호출에서 데이터가 보이려면 DB에 있어야만 한다.
function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use("/api", agentWorkspacePrimitivesRoutes(db));
  server.use(errorHandler);
  return server;
}

async function seedCompanyWithAgent(): Promise<{ companyId: string; agentId: string }> {
  const [company] = await db.insert(companies).values({ name: `Co-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: `A-${randomUUID()}`, status: "running" }).returning();
  return { companyId: company.id, agentId: agent.id };
}

const tableInput = { name: "contacts", columns: [{ name: "name", type: "string", required: true }] };
const waitInput = () => ({ agentId, eventKey: "reply", note: "Await reply", requestContext: { runId: "run-1" } });

describe("workspace primitives routes backed by Postgres", () => {
  it("creates a shared table, persists it, and serves DB rows in the UI JSON shape", async () => {
    const created = await request(app()).post(`${base}/shared-tables`).send(tableInput);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String), companyId, name: "contacts",
      columns: tableInput.columns, createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    const [persisted] = await db.select().from(agentSharedTables).where(eq(agentSharedTables.companyId, companyId));
    expect(persisted.name).toBe("contacts");
    expect(persisted.columnsJson).toEqual(tableInput.columns);
    expect(persisted.rowsJson).toEqual({});

    // 인메모리 글로벌 스토어가 모르는 service 기록 행도 DB 경로로 제공된다.
    const seeded = await createSharedTableDb(db, companyId, { name: "ledger", columns: [{ name: "n", type: "number" }] });
    const listed = await request(app()).get(`${base}/shared-tables`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((table: { id: string }) => table.id)).toEqual([created.body.id, seeded.id]);
    expect(listed.body[1]).toEqual({
      id: seeded.id, companyId, name: "ledger", columns: [{ name: "n", type: "number" }],
      createdAt: seeded.createdAt.toISOString(), updatedAt: seeded.updatedAt.toISOString(),
    });
  });

  it("upserts rows with agent attribution and persists the payload", async () => {
    const table = await createSharedTableDb(db, companyId, { name: "contacts", columns: [{ name: "name", type: "string" }] });
    actor = { type: "agent", companyId, agentId };
    for (const name of ["Alice", "Bob"]) {
      const row = await request(app()).post(`${base}/shared-tables/${table.id}/rows`).send({ key: "contact-1", values: { name } });
      expect(row.status).toBe(200);
      expect(row.body).toEqual({ key: "contact-1", values: { name }, updatedByAgentId: agentId, updatedAt: expect.any(String) });
    }
    const [persisted] = await db.select().from(agentSharedTables).where(eq(agentSharedTables.id, table.id));
    expect(persisted.rowsJson["contact-1"].values).toEqual({ name: "Bob" });
    expect(persisted.rowsJson["contact-1"].updatedByAgentId).toBe(agentId);
    // 다른 라우터 인스턴스에서도 같은 테이블을 찾고, 없는 테이블 ID는 404다.
    expect((await request(app()).post(`${base}/shared-tables/${randomUUID()}/rows`).send({ key: "k", values: { name: "x" } })).status).toBe(404);
  });

  it("creates open waits storing eventKey/note/requestContext and round-trips them", async () => {
    const created = await request(app()).post(`${base}/open-waits`).send({ ...waitInput(), ttlMs: 1000, companyId: "other" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String), companyId, agentId, eventKey: "reply", note: "Await reply",
      requestContext: { runId: "run-1" }, status: "waiting", expiresAtMs: null, matchedPayload: null,
      createdAtMs: expect.any(Number), updatedAtMs: expect.any(Number),
    });
    const [persisted] = await db.select().from(agentOpenWaits).where(eq(agentOpenWaits.companyId, companyId));
    expect(persisted.kind).toBe("reply"); // eventKey → kind
    expect(persisted.summary).toBe("Await reply"); // note → summary
    expect(persisted.targetLabel).toBe(JSON.stringify({ runId: "run-1" })); // requestContext 직렬화
    expect(persisted.status).toBe("waiting");

    // service가 직접 기록한 대기도 kind/summary/target_label에서 UI 계약 형태로 매핑된다.
    const [agentB] = await db.insert(agents).values({ companyId, name: `B-${randomUUID()}`, status: "running" }).returning();
    const seeded = await createOpenWaitDb(db, companyId, { agentId: agentB.id, kind: "deploy", summary: "deploy note", targetLabel: JSON.stringify({ ref: "main" }) });
    const listed = await request(app()).get(`${base}/open-waits`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((wait: { id: string }) => wait.id)).toEqual([created.body.id, seeded.id]);
    expect(listed.body[1]).toMatchObject({ eventKey: "deploy", note: "deploy note", requestContext: { ref: "main" }, agentId: agentB.id });
    const filtered = await request(app()).get(`${base}/open-waits?agentId=${agentB.id}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.map((wait: { id: string }) => wait.id)).toEqual([seeded.id]);
  });

  it("resolves one wait, persists resolution, and keeps company scoping", async () => {
    const target = await request(app()).post(`${base}/open-waits`).send(waitInput());
    const kept = await request(app()).post(`${base}/open-waits`).send({ ...waitInput(), eventKey: "hold" });
    const resolved = await request(app()).post(`${base}/open-waits/${target.body.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ id: target.body.id, companyId, status: "cancelled" });
    const [persisted] = await db.select().from(agentOpenWaits).where(eq(agentOpenWaits.id, target.body.id));
    expect(persisted.status).toBe("resolved");
    expect(persisted.resolvedAt).not.toBeNull();
    // 재해결도 404다.
    expect((await request(app()).post(`${base}/open-waits/${target.body.id}/resolve`)).status).toBe(404);
    // 타 회사 스코프: 목록은 비어 있고, 남의 대기 해결도 404다.
    const other = await seedCompanyWithAgent();
    const otherBase = `/api/companies/${other.companyId}`;
    actor = { type: "board", source: "session", userId: "user-1", companyIds: [other.companyId] };
    expect((await request(app()).get(`${otherBase}/open-waits`)).body).toEqual([]);
    expect((await request(app()).post(`${otherBase}/open-waits/${target.body.id}/resolve`)).status).toBe(404);
    // 원래 회사 라우터에서는 kept 대기만 남는다.
    actor = { type: "board", source: "session", userId: "user-1", companyIds: [companyId] };
    expect((await request(app()).get(`${base}/open-waits`)).body.map((wait: { id: string }) => wait.id)).toEqual([kept.body.id]);
  });
});
