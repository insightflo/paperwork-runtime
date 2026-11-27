import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { endpointBotRoutes } from "../routes/endpoint-bots.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createMemoryEndpointBotPairingStore } from "../services/endpoint-bot-pairing.js";

const board: Request["actor"] = { type: "board", source: "local_implicit" };
const folders = [{ path: "/workspace", mode: "rw" as const }];
const clis = ["codex"];
let store: ReturnType<typeof createMemoryEndpointBotPairingStore>;

function client(actor: Request["actor"] | null = board) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor !== null) req.actor = actor;
    next();
  });
  app.use("/api", endpointBotRoutes(store));
  app.use(errorHandler);
  return request(app);
}

async function pair(api = client(), code?: string) {
  const issued = code ? { code } : (await api.post("/api/companies/acme/endpoints/pairing-codes")
    .send({ botName: "worker", requestedFolders: folders })).body;
  return api.post("/api/endpoints/pair").send({
    code: issued.code, os: "linux", arch: "x64", detectedClis: clis,
  });
}

function device(api: ReturnType<typeof client>, token: string, companyId = "acme") {
  return { post: (path: string) => api.post(path).set("Authorization", `Bearer ${token}`).set("x-company-id", companyId) };
}

beforeEach(() => { store = createMemoryEndpointBotPairingStore(); });

describe("endpoint bot HTTP routes", () => {
  it.each([
    ["GET", "/api/companies/acme/endpoints"],
    ["POST", "/api/companies/acme/endpoints/pairing-codes"],
    ["POST", "/api/companies/acme/endpoints/device/tasks"],
  ])("rejects unauthenticated company route %s %s", async (method, url) => {
    const api = client({ type: "none" });
    const response = method === "GET" ? await api.get(url) : await api.post(url).send({});
    expect(response.status).toBe(401);
  });

  it("rejects a missing actor instead of crashing", async () => {
    const response = await client(null).get("/api/companies/acme/endpoints");
    expect(response.status).toBe(401);
  });

  it.each([
    ["POST", "/api/endpoints/device/heartbeat"],
    ["POST", "/api/endpoints/device/tasks/poll"],
    ["POST", "/api/endpoints/device/tasks/task/ack"],
  ])("rejects missing device credentials at %s %s", async (_method, url) => {
    const response = await client({ type: "none" }).post(url).send({});
    expect(response.status).toBe(401);
  });

  it("isolates company access for board and agent actors", async () => {
    const boardResponse = await client({ type: "board", companyIds: ["other"] })
      .get("/api/companies/acme/endpoints");
    const agentResponse = await client({ type: "agent", companyId: "other" })
      .post("/api/companies/acme/endpoints/pairing-codes").send({ botName: "x", requestedFolders: [] });
    expect(boardResponse.status).toBe(403);
    expect(agentResponse.status).toBe(403);
  });

  it("pairs, heartbeats, and lists public endpoint fields without token material", async () => {
    const api = client();
    const paired = await pair(api);
    expect(paired.status).toBe(201);
    expect(paired.body.deviceToken).toBeTruthy();
    const heartbeat = await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/heartbeat`)
      .send({ detectedClis: ["codex", "claude"], pendingOutboxCount: 2 });
    expect(heartbeat.status).toBe(200);
    const listed = await api.get("/api/companies/acme/endpoints");
    expect(listed.status).toBe(200);
    expect(listed.body[0]).toMatchObject({ online: true, detectedClis: ["codex", "claude"], pendingOutboxCount: 2 });
    expect(listed.body[0].lastSeenAt).toBeTruthy();
    expect(new Date(listed.body[0].lastSeenAt).toISOString()).toBe(listed.body[0].lastSeenAt);
    expect(listed.body[0].allowedFolders).toEqual(folders);
    expect(listed.body[0]).not.toHaveProperty("lastSeenMs");
    expect(listed.body[0]).not.toHaveProperty("tokenPreview");
    expect(JSON.stringify(listed.body)).not.toContain(paired.body.deviceToken);
    expect(JSON.stringify(listed.body)).not.toContain("tokenHash");
  });

  it("enqueues, polls, and acknowledges a task through authenticated HTTP", async () => {
    const api = client();
    const paired = await pair(api);
    const queued = await api.post(`/api/companies/acme/endpoints/${paired.body.deviceId}/tasks`)
      .send({ kind: "read_file", targetPath: "/workspace/a.txt" });
    const polled = await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/tasks/poll`).send({ limit: 5 });
    const acked = await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/tasks/${queued.body.taskId}/ack`)
      .send({ ok: true, output: "contents" });
    const repolled = await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/tasks/poll`).send();
    expect(queued.status).toBe(201);
    expect(polled.body).toHaveLength(1);
    expect(polled.body[0].taskId).toBe(queued.body.taskId);
    expect(acked.body).toMatchObject({ status: "completed", output: "contents" });
    expect(repolled.body).toEqual([]);
  });

  it("polls with either company scope source and defaults a missing body", async () => {
    const api = client(), paired = await pair(api), url = `/api/endpoints/${paired.body.deviceId}/tasks/poll`;
    const header = await device(api, paired.body.deviceToken).post(url);
    const body = await api.post(url).set("Authorization", `Bearer ${paired.body.deviceToken}`).send({ companyId: "acme" });
    expect(header.status).toBe(200); expect(header.body).toEqual([]);
    expect(body.status).toBe(200); expect(body.body).toEqual([]);
  });

  it("isolates paired devices tasks and tokens", async () => {
    const api = client(), first = await pair(api);
    const task = await api.post(`/api/companies/acme/endpoints/${first.body.deviceId}/tasks`)
      .send({ kind: "read_file", targetPath: "/workspace/a.txt" }), second = await pair(api);
    const poll = await device(api, second.body.deviceToken).post(`/api/endpoints/${second.body.deviceId}/tasks/poll`).send();
    const ack = await device(api, second.body.deviceToken).post(`/api/endpoints/${second.body.deviceId}/tasks/${task.body.taskId}/ack`).send({ ok: true });
    const wrongToken = await device(api, first.body.deviceToken).post(`/api/endpoints/${second.body.deviceId}/tasks/poll`).send();
    expect(poll.body).toEqual([]); expect(ack.status).toBe(404); expect(wrongToken.status).toBe(401);
  });

  it("rejects invalid tokens and mismatched company scope", async () => {
    const api = client();
    const paired = await pair(api);
    const invalid = await device(api, "wrong-token")
      .post(`/api/endpoints/${paired.body.deviceId}/heartbeat`).send({ detectedClis: [], pendingOutboxCount: 0 });
    const mismatch = await device(api, paired.body.deviceToken, "other")
      .post(`/api/endpoints/${paired.body.deviceId}/heartbeat`).send({ detectedClis: [], pendingOutboxCount: 0 });
    const bodyMismatch = await api.post(`/api/endpoints/${paired.body.deviceId}/heartbeat`)
      .set("Authorization", `Bearer ${paired.body.deviceToken}`).set("x-company-id", "acme")
      .send({ companyId: "other", detectedClis: [], pendingOutboxCount: 0 });
    const wrongDevice = await device(api, paired.body.deviceToken)
      .post("/api/endpoints/another-device/heartbeat").send({ detectedClis: [], pendingOutboxCount: 0 });
    expect(invalid.status).toBe(401);
    expect(mismatch.status).toBe(401);
    expect(bodyMismatch.status).toBe(401);
    expect(wrongDevice.status).toBe(401);
    expect(JSON.stringify(invalid.body)).not.toContain("wrong-token");
  });

  it.each(["write_file", "shell_exec"] as const)("denies %s in a read-only folder", async (kind) => {
    const api = client();
    const code = (await api.post("/api/companies/acme/endpoints/pairing-codes")
      .send({ botName: "reader", requestedFolders: [{ path: "/readonly", mode: "ro" }] })).body.code;
    const paired = await pair(api, code);
    const task = await api.post(`/api/companies/acme/endpoints/${paired.body.deviceId}/tasks`).send({
      kind, targetPath: "/readonly/file", ...(kind === "shell_exec" ? { command: "cat" } : {}),
    });
    expect(task.status).toBe(403);
  });

  it("rejects unknown, expired, and reused pairing codes", async () => {
    const api = client();
    const unknown = await pair(api, "ABC234");
    store.putCode({ code: "EXPIRE", companyId: "acme", botName: "old", allowedFolders: [], expiresAtMs: Date.now() - 1, consumed: false });
    const expired = await pair(api, "EXPIRE");
    const code = (await api.post("/api/companies/acme/endpoints/pairing-codes")
      .send({ botName: "once", requestedFolders: [] })).body.code;
    const first = await pair(api, code);
    const second = await pair(api, code);
    expect([unknown.status, expired.status, second.status]).toEqual([404, 404, 404]);
    expect(first.status).toBe(201);
  });

  it("rejects body scope, identity, and clock spoofing", async () => {
    const api = client();
    const issue = await api.post("/api/companies/acme/endpoints/pairing-codes").send({
      botName: "worker", requestedFolders: [], companyId: "other", ttlMs: 999999,
    });
    expect(issue.status).toBe(400);
    const paired = await pair(api);
    const heartbeat = await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/heartbeat`)
      .send({ detectedClis: [], pendingOutboxCount: 0, companyId: "acme", deviceId: "spoof", nowMs: 1 });
    expect(heartbeat.status).toBe(400);
  });

  it("returns a sanitized 500 for unexpected store errors", async () => {
    const broken = createMemoryEndpointBotPairingStore();
    broken.getEndpoint = () => { throw new Error("secret-token-leak"); };
    store = broken;
    const response = await client().post("/api/endpoints/device/heartbeat")
      .set("Authorization", "Bearer valid-token").set("x-company-id", "acme")
      .send({ detectedClis: [], pendingOutboxCount: 0 });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("secret-token-leak");
  });

  it("rejects unauthenticated and out-of-company access to the endpoint audit feed", async () => {
    const none = await client({ type: "none" }).get("/api/companies/acme/endpoints/audit");
    const missing = await client(null).get("/api/companies/acme/endpoints/audit");
    const other = await client({ type: "agent", companyId: "other" })
      .get("/api/companies/acme/endpoints/audit");
    expect(none.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(other.status).toBe(403);
  });

  it("records enqueued and completed audit events with company-scoped stats", async () => {
    const api = client();
    const paired = await pair(api);
    const queued = await api.post(`/api/companies/acme/endpoints/${paired.body.deviceId}/tasks`)
      .send({ kind: "read_file", targetPath: "/workspace/a.txt" });
    await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/tasks/${queued.body.taskId}/ack`)
      .send({ ok: true, output: "contents" });
    const audit = await api.get("/api/companies/acme/endpoints/audit");
    expect(audit.status).toBe(200);
    expect(audit.body.items).toHaveLength(2);
    expect(audit.body.items[0]).toMatchObject({
      companyId: "acme", deviceId: paired.body.deviceId, botName: "worker",
      taskId: queued.body.taskId, kind: "read_file", outcome: "completed",
    });
    expect(audit.body.items[1]).toMatchObject({ outcome: "enqueued", targetPath: "/workspace/a.txt" });
    expect(audit.body.stats).toEqual({ total: 2, enqueued: 1, completed: 1, failed: 0, denied: 0 });
  });

  it("redacts bearer and sk- secrets carried in audited ack output", async () => {
    const api = client();
    const paired = await pair(api);
    const queued = await api.post(`/api/companies/acme/endpoints/${paired.body.deviceId}/tasks`)
      .send({ kind: "read_file", targetPath: "/workspace/a.txt" });
    await device(api, paired.body.deviceToken)
      .post(`/api/endpoints/${paired.body.deviceId}/tasks/${queued.body.taskId}/ack`)
      .send({ ok: false, output: "failed with Bearer supersecret123 and sk-proj-abcdef123456", error: "boom" });
    const audit = await api.get("/api/companies/acme/endpoints/audit");
    const json = JSON.stringify(audit.body);
    expect(json).not.toContain("supersecret123");
    expect(json).not.toContain("sk-proj-abcdef123456");
    expect(audit.body.items[0].summary).toContain("[REDACTED]");
    expect(audit.body.items[0]).toMatchObject({ outcome: "failed" });
  });

  it("records a denied audit event when folder policy rejects a task", async () => {
    const api = client();
    const code = (await api.post("/api/companies/acme/endpoints/pairing-codes")
      .send({ botName: "reader", requestedFolders: [{ path: "/readonly", mode: "ro" }] })).body.code;
    const paired = await pair(api, code);
    const denied = await api.post(`/api/companies/acme/endpoints/${paired.body.deviceId}/tasks`)
      .send({ kind: "write_file", targetPath: "/readonly/file" });
    expect(denied.status).toBe(403);
    const audit = await api.get("/api/companies/acme/endpoints/audit");
    expect(audit.body.items[0]).toMatchObject({ outcome: "denied", kind: "write_file", botName: "reader" });
    expect(audit.body.stats.denied).toBe(1);
  });

  it("filters the audit feed by device and limit", async () => {
    const api = client();
    const first = await pair(api);
    const second = await pair(api);
    await api.post(`/api/companies/acme/endpoints/${first.body.deviceId}/tasks`)
      .send({ kind: "read_file", targetPath: "/workspace/a.txt" });
    await api.post(`/api/companies/acme/endpoints/${second.body.deviceId}/tasks`)
      .send({ kind: "list_dir", targetPath: "/workspace" });
    const filtered = await api.get(`/api/companies/acme/endpoints/audit?deviceId=${second.body.deviceId}`);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].deviceId).toBe(second.body.deviceId);
    const limited = await api.get("/api/companies/acme/endpoints/audit?limit=1");
    expect(limited.body.items).toHaveLength(1);
    expect(limited.body.items[0].kind).toBe("list_dir");
    expect(limited.body.stats.total).toBe(2);
    const invalid = await api.get("/api/companies/acme/endpoints/audit?limit=zero");
    expect(invalid.status).toBe(400);
  });
});
