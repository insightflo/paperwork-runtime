import { createHash, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { endpointBotRoutes } from "../routes/endpoint-bots.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createMemoryEndpointBotPairingStore, type EndpointBotPairingStore } from "../services/endpoint-bot-pairing.js";
import * as persistence from "../services/endpoint-bot-db-store.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const board: Request["actor"] = { type: "board", source: "local_implicit" };
const companyId = randomUUID(), otherCompany = randomUUID();
const base = `/api/companies/${companyId}/endpoints`;
const folders = [{ path: "/work", mode: "rw" }, { path: "/work/private", mode: "ro" }];
const pairBody = { os: "linux", arch: "arm64", detectedClis: ["codex"] };
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("endpoint-routes-db-");
  db = createDb(temp.connectionString);
  await db.insert(companies).values([{ id: companyId, name: "Endpoints", issuePrefix: "EPR" },
    { id: otherCompany, name: "Other", issuePrefix: "EPRO" }]);
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });

// Every client mounts a fresh router against the same durable database.
function client(actor: Request["actor"] = board, store?: EndpointBotPairingStore,
  database: ReturnType<typeof createDb> = db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", endpointBotRoutes(store, undefined, database));
  app.use(errorHandler);
  return request(app);
}
async function issue(botName = "Desktop") {
  const issued = await client().post(`${base}/pairing-codes`).send({ botName, requestedFolders: folders });
  expect(issued.status).toBe(201);
  return issued.body.code as string;
}
async function pair() {
  const code = await issue();
  const paired = await client({ type: "none" }).post("/api/endpoints/pair").send({ code, ...pairBody });
  expect(paired.status).toBe(201);
  return paired.body as { companyId: string; deviceId: string; botName: string; deviceToken: string };
}
function device(paired: Awaited<ReturnType<typeof pair>>, company = companyId, token = paired.deviceToken) {
  const api = client({ type: "none" });
  return { post: (path: string) => api.post(`/api/endpoints/${paired.deviceId}${path}`)
    .set("Authorization", `Bearer ${token}`).set("x-company-id", company) };
}

it("lazily creates missing tables once for concurrent first requests", async () => {
  await db.execute(sql.raw("DROP TABLE personal_endpoint_tasks, personal_endpoint_bots, personal_endpoint_pairing_codes"));
  const ensure = vi.spyOn(persistence, "ensurePersonalEndpointTables");
  const first = client(), second = client();
  expect(ensure).not.toHaveBeenCalled();
  const responses = await Promise.all([first.get(base), second.get(base)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(responses.map(r => r.body)).toEqual([[], []]);
  await second.get(base).expect(200);
  expect(ensure).toHaveBeenCalledTimes(1);
});

it("persists pairing, heartbeat, pending tasks and first-wins ack across fresh routers", async () => {
  const paired = await pair();
  expect(Object.keys(paired).sort()).toEqual(["botName", "companyId", "deviceId", "deviceToken", "tokenPreview"]);
  expect(paired).toMatchObject({ companyId, botName: "Desktop" });
  expect(paired.deviceToken).toMatch(/^[0-9a-f]{64}$/);
  const [stored] = await db.execute(sql`SELECT * FROM personal_endpoint_bots WHERE device_id = ${paired.deviceId}`);
  const hash = createHash("sha256").update(paired.deviceToken).digest("hex");
  expect(paired).toHaveProperty("tokenPreview", `sha256:${hash.slice(0, 8)}`);
  expect(stored).toMatchObject({ token_hash: hash, token_preview: `sha256:${hash.slice(0, 8)}` });
  expect(JSON.stringify(stored)).not.toContain(paired.deviceToken);

  const heartbeat = await device(paired).post("/heartbeat").send({ detectedClis: ["claude"], pendingOutboxCount: 2 });
  expect(heartbeat.status).toBe(200);
  const listed = await client().get(base);
  expect(listed.status).toBe(200);
  expect(listed.body.find((e: { deviceId: string }) => e.deviceId === paired.deviceId))
    .toEqual(heartbeat.body);
  expect(heartbeat.body).toMatchObject({ online: true, detectedClis: ["claude"], pendingOutboxCount: 2, allowedFolders: folders });
  expect(new Date(heartbeat.body.lastSeenAt).toISOString()).toBe(heartbeat.body.lastSeenAt);
  for (const field of ["tokenHash", "tokenPreview", "deviceToken", "lastSeenMs"]) {
    expect(heartbeat.body).not.toHaveProperty(field);
  }

  const queued = await client().post(`${base}/${paired.deviceId}/tasks`).send({ kind: "read_file", targetPath: "/work/a" });
  expect(queued.status).toBe(201);
  for (let i = 0; i < 2; i++) {
    const polled = await device(paired).post("/tasks/poll").send();
    expect(polled.status).toBe(200);
    expect(polled.body).toEqual([queued.body]);
  }
  const acked = await device(paired).post(`/tasks/${queued.body.taskId}/ack`).send({ ok: true, output: "contents" });
  expect(acked.status).toBe(200);
  expect(acked.body).toMatchObject({ status: "completed", ok: true, output: "contents" });
  const replay = await device(paired).post(`/tasks/${queued.body.taskId}/ack`).send({ ok: false, error: "late" });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(acked.body);
  const remaining = await device(paired).post("/tasks/poll").send();
  expect(remaining.status).toBe(200);
  expect(remaining.body).toEqual([]);
  const [durable] = await db.execute(sql`SELECT status, output FROM personal_endpoint_tasks WHERE task_id = ${queued.body.taskId}`);
  expect(durable).toEqual({ status: "completed", output: "contents" });
});

it("atomically redeems a code only once through concurrent HTTP requests", async () => {
  const code = await issue("Concurrent");
  const attempts = await Promise.all([client(), client()].map(api =>
    api.post("/api/endpoints/pair").send({ code, ...pairBody })));
  expect(attempts.map(r => r.status).sort()).toEqual([201, 404]);
  const rows = await db.execute(sql`SELECT device_id FROM personal_endpoint_bots WHERE company_id = ${companyId} AND bot_name = 'Concurrent'`);
  expect(rows).toHaveLength(1);
  expect(attempts.find(r => r.status === 404)?.body).toEqual({ error: "Pairing code not found or expired" });
});

it("rejects unknown, expired and invalid pairing input without losing a valid code", async () => {
  await client().post("/api/endpoints/pair").send({ code: "UNKNWN", ...pairBody }).expect(404);
  const expired = await persistence.issuePairingCodeDb(db, { companyId, botName: "Old", requestedFolders: [], nowMs: 1, ttlMs: 1 });
  await client().post("/api/endpoints/pair").send({ code: expired.code, ...pairBody }).expect(404);
  const code = await issue();
  const invalid = await client().post("/api/endpoints/pair").send({ code, ...pairBody, detectedClis: ["\0"] });
  expect(invalid.status).toBe(400);
  expect(invalid.body).toEqual({ error: "Invalid endpoint request" });
  const [unconsumed] = await db.execute(sql`SELECT consumed_at FROM personal_endpoint_pairing_codes WHERE code = ${code}`);
  expect(unconsumed.consumed_at).toBeNull();
  await client().post("/api/endpoints/pair").send({ code, ...pairBody }).expect(201);
});

it("honors the helper clock and expiration boundary", async () => {
  const issued = await persistence.issuePairingCodeDb(db, { companyId, botName: "Clock", requestedFolders: [], nowMs: 100, ttlMs: 10 });
  await expect(persistence.completePairingByCodeDb(db, { ...pairBody, code: issued.code, nowMs: 110 }))
    .rejects.toThrow("invalid or expired pairing code");
  const paired = await persistence.completePairingByCodeDb(db, { ...pairBody, code: issued.code, nowMs: 109 });
  expect(Object.keys(paired).sort()).toEqual(["botName", "companyId", "deviceId", "deviceToken"]);
  expect(paired).toMatchObject({ companyId, botName: "Clock" });
  expect(paired.deviceToken).toMatch(/^[0-9a-f]{64}$/);
});

it("maps asynchronous policy and missing-task errors and records DB bot names in audits", async () => {
  const api = client(), paired = await pair();
  const denied = await api.post(`${base}/${paired.deviceId}/tasks`).send({ kind: "write_file", targetPath: "/work/private/a" });
  expect(denied.status).toBe(403);
  expect(denied.body).toEqual({ error: "Endpoint folder policy denied this task" });
  const audit = await api.get(`${base}/audit`);
  expect(audit.status).toBe(200);
  expect(audit.body.items[0]).toMatchObject({ botName: "Desktop", outcome: "denied" });
  await device(paired).post(`/tasks/${randomUUID()}/ack`).send({ ok: true }).expect(404);
  await api.post(`${base}/${randomUUID()}/tasks`).send({ kind: "read_file", targetPath: "/work/a" }).expect(404);
});

it("enforces company and device scope and rejects revoked credentials", async () => {
  const paired = await pair(), second = await pair();
  const queued = await client().post(`${base}/${paired.deviceId}/tasks`).send({ kind: "read_file", targetPath: "/work/a" });
  expect(queued.status).toBe(201);
  await device(paired, otherCompany).post("/tasks/poll").expect(401);
  await device(paired, companyId, "wrong-token").post("/heartbeat").send({ detectedClis: [], pendingOutboxCount: 0 }).expect(401);
  await device(second, companyId, paired.deviceToken).post("/tasks/poll").expect(401);
  await device(second).post(`/tasks/${queued.body.taskId}/ack`).send({ ok: true }).expect(404);
  const foreignList = await client().get(`/api/companies/${otherCompany}/endpoints`);
  expect(foreignList.body).toEqual([]);
  await client({ type: "agent", companyId: otherCompany }).get(base).expect(403);
  await client({ type: "none" }).get(base).expect(401);
  await db.execute(sql`UPDATE personal_endpoint_bots SET revoked_at = now() WHERE device_id = ${paired.deviceId}`);
  await device(paired).post("/tasks/poll").expect(401);
});

it("sanitizes unexpected asynchronous DB failures and caches failed initialization", async () => {
  const failedDb = createDb(temp.connectionString);
  try {
    const ensure = vi.spyOn(persistence, "ensurePersonalEndpointTables").mockRejectedValue(new Error("secret-connection-password"));
    const responses = await Promise.all([client(board, undefined, failedDb), client(board, undefined, failedDb)]
      .map(api => api.get(base)));
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    }
    expect(ensure).toHaveBeenCalledTimes(1);
  } finally {
    await failedDb.$client.end({ timeout: 5 });
  }
});

it("requires a company scope in the legacy DB pairing helper", async () => {
  const issued = await persistence.issuePairingCodeDb(db, { companyId, botName: "Scoped", requestedFolders: [] });
  const input = { ...pairBody, code: issued.code, deviceToken: "a".repeat(64), companyId: undefined as unknown as string };
  await expect(persistence.completePairingDb(db, input)).rejects.toThrow("non-empty string required");
  const [unconsumed] = await db.execute(sql`SELECT consumed_at FROM personal_endpoint_pairing_codes WHERE code = ${issued.code}`);
  expect(unconsumed.consumed_at).toBeNull();
  await expect(persistence.completePairingByCodeDb(db, { ...pairBody, code: issued.code })).resolves
    .toMatchObject({ companyId, botName: "Scoped" });
});

it("gives an explicit memory store precedence over db without initializing tables", async () => {
  const ensure = vi.spyOn(persistence, "ensurePersonalEndpointTables");
  const api = client(board, createMemoryEndpointBotPairingStore());
  const issued = await api.post(`${base}/pairing-codes`).send({ botName: "Memory", requestedFolders: [] });
  expect(issued.status).toBe(201);
  const paired = await api.post("/api/endpoints/pair").send({ code: issued.body.code, ...pairBody });
  expect(paired.status).toBe(201);
  const rows = await db.execute(sql`SELECT code FROM personal_endpoint_pairing_codes WHERE code = ${issued.body.code}`);
  expect(rows).toEqual([]);
  expect(ensure).not.toHaveBeenCalled();
});
