// [파일 목적] Stage 35 W3 — workspace-primitives Postgres 스토어 통합 테스트(실제 PGlite).
// [범위] 자가 부트스트랩(CREATE TABLE IF NOT EXISTS, 재호출 멱등), 공유 테이블 생성·조회·행 upsert,
//        오픈 대기 생성·조회(에이전트 필터·상태)·해결, 회사 스코프 엄격 격리, 재부트스트랩 후 데이터 보존.
//        서비스 계층·라우트 배선은 후속 워커 범위다.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, type Db } from "@paperclipai/db";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";
import {
  createOpenWaitDb,
  createSharedTableDb,
  ensureWorkspacePrimitivesTables,
  listOpenWaitsDb,
  listSharedTablesDb,
  resolveOpenWaitDb,
  upsertSharedTableRowDb,
} from "../services/workspace-primitives-db-store.js";

let db: Db;
let closeDb: () => void = () => undefined;
beforeAll(async () => {
  const terminal = await terminalDatabase();
  db = terminal.db;
  closeDb = terminal.close;
}, 60_000);
afterAll(() => closeDb());

async function seedCompany(): Promise<{ id: string }> {
  const [company] = await db.insert(companies).values({ name: `Co-${randomUUID()}`, issuePrefix: randomUUID() }).returning();
  return company;
}

async function seedAgent(companyId: string, name: string): Promise<{ id: string }> {
  const [agent] = await db.insert(agents).values({ companyId, name, status: "running" }).returning();
  return agent;
}

const cityColumns = () => [{ name: "city", type: "string" }, { name: "population", type: "number" }];

describe("workspace primitives db store", () => {
  it("bootstraps tables on a fresh database and is idempotent", async () => {
    await ensureWorkspacePrimitivesTables(db);
    await expect(ensureWorkspacePrimitivesTables(db)).resolves.toBeUndefined();
    const company = await seedCompany();
    const created = await createSharedTableDb(db, company.id, { name: "bootstrap_probe", columns: cityColumns() });
    expect(created.name).toBe("bootstrap_probe");
    expect(created.columnsJson).toEqual(cityColumns());
    expect(created.rowsJson).toEqual({});
  });

  it("creates and lists shared tables scoped by company", async () => {
    const alpha = await seedCompany();
    const beta = await seedCompany();
    const created = await createSharedTableDb(db, alpha.id, { name: "cities", columns: cityColumns() });
    const alphaList = await listSharedTablesDb(db, alpha.id);
    expect(alphaList.map((table) => table.id)).toContain(created.id);
    expect(await listSharedTablesDb(db, beta.id)).toHaveLength(0);
  });

  it("upserts rows into a shared table and replaces the same key", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id, "row-writer");
    await createSharedTableDb(db, company.id, { name: "cities", columns: cityColumns() });
    const first = await upsertSharedTableRowDb(db, company.id, "cities", {
      key: "seoul", values: { city: "Seoul", population: 9_700_000 }, agentId: agent.id,
    });
    expect(first.rowsJson.seoul.values).toEqual({ city: "Seoul", population: 9_700_000 });
    expect(first.rowsJson.seoul.updatedByAgentId).toBe(agent.id);
    const second = await upsertSharedTableRowDb(db, company.id, "cities", {
      key: "seoul", values: { city: "Seoul", population: 9_500_000 },
    });
    expect(second.rowsJson.seoul.values).toEqual({ city: "Seoul", population: 9_500_000 });
    expect(second.rowsJson.seoul.updatedByAgentId).toBeNull();
    await upsertSharedTableRowDb(db, company.id, "cities", { key: "busan", values: { city: "Busan", population: 3_400_000 } });
    const listed = await listSharedTablesDb(db, company.id);
    expect(Object.keys(listed[0].rowsJson).sort()).toEqual(["busan", "seoul"]);
  });

  it("enforces per-company uniqueness and blocks cross-company row upserts", async () => {
    const alpha = await seedCompany();
    const beta = await seedCompany();
    await createSharedTableDb(db, alpha.id, { name: "cities", columns: cityColumns() });
    await expect(createSharedTableDb(db, alpha.id, { name: "cities", columns: cityColumns() }))
      .rejects.toThrow(/already exists/);
    const betaTable = await createSharedTableDb(db, beta.id, { name: "cities", columns: cityColumns() });
    expect(betaTable.companyId).toBe(beta.id);
    await expect(upsertSharedTableRowDb(db, beta.id, "missing_table", { key: "k", values: {} }))
      .rejects.toThrow(/not found/);
  });

  it("creates and lists open waits filtered by agent", async () => {
    const company = await seedCompany();
    const waiterA = await seedAgent(company.id, "waiter-a");
    const waiterB = await seedAgent(company.id, "waiter-b");
    await createOpenWaitDb(db, company.id, { agentId: waiterA.id, kind: "approval", summary: "결재 대기" });
    await createOpenWaitDb(db, company.id, { agentId: waiterA.id, kind: "event", targetLabel: "deploy-finish" });
    const waiterWait = await createOpenWaitDb(db, company.id, { agentId: waiterB.id, kind: "input" });
    expect(waiterWait.status).toBe("waiting");
    expect(waiterWait.resolvedAt).toBeNull();
    const all = await listOpenWaitsDb(db, company.id);
    expect(all).toHaveLength(3);
    const onlyB = await listOpenWaitsDb(db, company.id, { agentId: waiterB.id });
    expect(onlyB.map((wait) => wait.id)).toEqual([waiterWait.id]);
  });

  it("resolves an open wait once and keeps the rest waiting", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id, "resolver-target");
    const kept = await createOpenWaitDb(db, company.id, { agentId: agent.id, kind: "approval" });
    const target = await createOpenWaitDb(db, company.id, { agentId: agent.id, kind: "event" });
    const resolved = await resolveOpenWaitDb(db, company.id, target.id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).not.toBeNull();
    expect((await resolveOpenWaitDb(db, company.id, target.id))).toBeNull();
    const waiting = await listOpenWaitsDb(db, company.id, { status: "waiting" });
    expect(waiting.map((wait) => wait.id)).toEqual([kept.id]);
    const resolvedList = await listOpenWaitsDb(db, company.id, { status: "resolved" });
    expect(resolvedList.map((wait) => wait.id)).toEqual([target.id]);
  });

  it("isolates open waits and resolution by company", async () => {
    const alpha = await seedCompany();
    const beta = await seedCompany();
    const agent = await seedAgent(alpha.id, "alpha-waiter");
    const wait = await createOpenWaitDb(db, alpha.id, { agentId: agent.id, kind: "approval" });
    expect(await listOpenWaitsDb(db, beta.id)).toHaveLength(0);
    expect(await resolveOpenWaitDb(db, beta.id, wait.id)).toBeNull();
    const stillWaiting = await listOpenWaitsDb(db, alpha.id, { status: "waiting" });
    expect(stillWaiting.map((row) => row.id)).toEqual([wait.id]);
  });

  it("preserves data across a re-bootstrap", async () => {
    const company = await seedCompany();
    const created = await createSharedTableDb(db, company.id, { name: "survivors", columns: cityColumns() });
    await upsertSharedTableRowDb(db, company.id, "survivors", { key: "daejeon", values: { city: "Daejeon", population: 1_500_000 } });
    await ensureWorkspacePrimitivesTables(db);
    const [after] = await listSharedTablesDb(db, company.id);
    expect(after.id).toBe(created.id);
    expect(after.rowsJson.daejeon.values).toEqual({ city: "Daejeon", population: 1_500_000 });
  });
});
