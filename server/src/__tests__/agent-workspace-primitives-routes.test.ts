import { randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { agentWorkspacePrimitivesRoutes } from "../routes/agent-workspace-primitives.js";
import { errorHandler } from "../middleware/error-handler.js";
import { globalSharedTableStore } from "../services/agent-shared-tables.js";
import { globalAgentOpenWaitStore } from "../services/agent-open-waits.js";

let companyId: string;
let base: string;
let actor: Request["actor"];
const tableInput = { name: "contacts", columns: [{ name: "name", type: "string", required: true }] };
const waitInput = { agentId: "agent-1", eventKey: "reply", note: "Await reply", requestContext: { runId: "run-1" } };

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use("/api", agentWorkspacePrimitivesRoutes());
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  companyId = randomUUID();
  base = `/api/companies/${companyId}`;
  actor = { type: "board", source: "session", userId: "user-1", companyIds: [companyId] };
});

describe("workspace primitive authentication", () => {
  const endpoints = [
    ["get", "/shared-tables"], ["post", "/shared-tables"],
    ["post", "/shared-tables/table-id/rows"], ["get", "/open-waits"],
    ["post", "/open-waits"], ["post", "/open-waits/wait-id/resolve"],
  ] as const;
  it.each(endpoints)("rejects unauthenticated and foreign actors: %s %s", async (method, path) => {
    for (const [denied, status] of [
      [{ type: "none" }, 401],
      [{ type: "agent", companyId: "other", agentId: "agent-2" }, 403],
      [{ type: "board", source: "session", companyIds: ["other"] }, 403],
    ] as const) {
      actor = { ...denied, ...("companyIds" in denied ? { companyIds: [...denied.companyIds] } : {}) };
      expect((await request(app())[method](`${base}${path}`).send({})).status).toBe(status);
    }
    expect(globalSharedTableStore.listTables(companyId)).toEqual([]);
    expect(globalAgentOpenWaitStore.listActiveWaits(companyId)).toEqual([]);
  });
});

describe("shared tables REST routes", () => {
  it("creates, lists, and upserts by table ID using the real store", async () => {
    const created = await request(app()).post(`${base}/shared-tables`).send({ ...tableInput, companyId: "other" });
    expect(created.status).toBe(201);
    expect(created.body.companyId).toBe(companyId);
    actor = { type: "agent", companyId, agentId: "agent-1" };
    const listed = await request(app()).get(`${base}/shared-tables`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([created.body]);
    for (const name of ["Alice", "Bob"]) {
      const row = await request(app()).post(`${base}/shared-tables/${created.body.id}/rows`)
        .send({ key: "contact-1", values: { name } });
      expect(row.status).toBe(200);
      expect(row.body).toMatchObject({ key: "contact-1", values: { name }, updatedByAgentId: "agent-1" });
    }
    expect(globalSharedTableStore.queryRows(companyId, "contacts")).toHaveLength(1);
    expect(globalSharedTableStore.queryRows(companyId, "contacts")[0].values).toEqual({ name: "Bob" });
  });

  it.each([
    {}, { ...tableInput, name: "bad name" }, { ...tableInput, columns: [] },
    { ...tableInput, columns: [{ name: "x", type: "unknown" }] },
    { ...tableInput, columns: [{ name: "x", type: "string", required: "yes" }] },
    { ...tableInput, columns: [tableInput.columns[0], tableInput.columns[0]] },
  ])("rejects malformed table definitions: %j", async (body) => {
    expect((await request(app()).post(`${base}/shared-tables`).send(body)).status).toBe(400);
    expect(globalSharedTableStore.listTables(companyId)).toEqual([]);
  });

  it("rejects duplicate tables, invalid rows, and foreign table IDs", async () => {
    const table = globalSharedTableStore.createTable(companyId, tableInput as Parameters<typeof globalSharedTableStore.createTable>[1]);
    expect((await request(app()).post(`${base}/shared-tables`).send(tableInput)).status).toBe(409);
    for (const body of [{}, { key: "k", values: [] }, { key: "k", values: {} },
      { key: "k", values: { name: 1 } }, { key: "k", values: { name: "a", extra: true } }]) {
      expect((await request(app()).post(`${base}/shared-tables/${table.id}/rows`).send(body)).status).toBe(400);
    }
    expect(globalSharedTableStore.queryRows(companyId, "contacts")).toEqual([]);
    const foreign = globalSharedTableStore.createTable("other", { name: randomUUID(), columns: [{ name: "x", type: "string" }] });
    expect((await request(app()).post(`${base}/shared-tables/${foreign.id}/rows`).send({ key: "k", values: { x: "x" } })).status).toBe(404);
  });
});

describe("open waits REST routes", () => {
  it("registers waits, filters by agent, and isolates companies", async () => {
    const created = await request(app()).post(`${base}/open-waits`).send({ ...waitInput, companyId: "other", nowMs: 1 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...waitInput, companyId, status: "waiting" });
    expect(created.body.createdAtMs).toBeGreaterThan(1);
    actor = { type: "agent", companyId, agentId: "agent-1" };
    const second = await request(app()).post(`${base}/open-waits`).send({ ...waitInput, agentId: "agent-2" });
    expect(second.status).toBe(201);
    globalAgentOpenWaitStore.registerWait({ ...waitInput, companyId: "other" });
    const listed = await request(app()).get(`${base}/open-waits`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((wait: { id: string }) => wait.id)).toEqual([created.body.id, second.body.id]);
    const filtered = await request(app()).get(`${base}/open-waits?agentId=agent-1`);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual([created.body]);
  });

  it.each([{}, { ...waitInput, eventKey: " " }, { ...waitInput, requestContext: [] },
    { ...waitInput, ttlMs: -1 }, { ...waitInput, agentId: "" }, { ...waitInput, note: 4 }])(
    "rejects invalid waits: %j", async (body) => {
      expect((await request(app()).post(`${base}/open-waits`).send(body)).status).toBe(400);
      expect(globalAgentOpenWaitStore.listActiveWaits(companyId)).toEqual([]);
    });

  it("rejects non-scalar agent filters", async () => {
    expect((await request(app()).get(`${base}/open-waits?agentId=a&agentId=b`)).status).toBe(400);
  });

  it("resolves only the selected active wait and rejects foreign, expired, or repeated IDs", async () => {
    const first = globalAgentOpenWaitStore.registerWait({ ...waitInput, companyId });
    const sibling = globalAgentOpenWaitStore.registerWait({ ...waitInput, companyId });
    const foreign = globalAgentOpenWaitStore.registerWait({ ...waitInput, companyId: "other" });
    const expired = globalAgentOpenWaitStore.registerWait({ ...waitInput, companyId, nowMs: 1, ttlMs: 1 });
    actor = { type: "agent", companyId, agentId: "agent-1" };
    for (const id of [foreign.id, expired.id, "missing"]) {
      expect((await request(app()).post(`${base}/open-waits/${id}/resolve`)).status).toBe(404);
    }
    const resolved = await request(app()).post(`${base}/open-waits/${first.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ id: first.id, companyId, status: "cancelled" });
    expect((await request(app()).post(`${base}/open-waits/${first.id}/resolve`)).status).toBe(404);
    expect(globalAgentOpenWaitStore.listActiveWaits(companyId).map((wait) => wait.id)).toEqual([sibling.id]);
    expect(globalAgentOpenWaitStore.listActiveWaits("other").map((wait) => wait.id)).toContain(foreign.id);
  });
});
