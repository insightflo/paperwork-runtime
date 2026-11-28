import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, companies } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  ensurePersonalEndpointTables, issuePairingCodeDb, completePairingDb, verifyDeviceTokenDb,
  recordHeartbeatDb, listEndpointsDb, enqueueLocalTaskDb, pollPendingTasksDb, ackTaskResultDb,
} from "../services/endpoint-bot-db-store.js";

let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const companyId = randomUUID(), otherCompany = randomUUID();
const folders = [{ path: "/work", mode: "rw" as const }, { path: "/work/private", mode: "ro" as const }];
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("endpoint-db-");
  db = createDb(temp.connectionString);
  await db.insert(companies).values([{ id: companyId, name: "Endpoints", issuePrefix: "EPDB" },
    { id: otherCompany, name: "Other", issuePrefix: "EPOTHER" }]);
}, 60_000);
afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });
async function pair(company = companyId, requestedFolders = folders) {
  const issued = await issuePairingCodeDb(db, { companyId: company, botName: "Desktop", requestedFolders });
  const deviceToken = randomBytes(32).toString("base64url");
  const device = await completePairingDb(db, { companyId: company, code: issued.code, deviceToken,
    os: "linux", arch: "arm64", detectedClis: ["codex"] });
  return { ...device, deviceToken };
}
it("boot-creates missing tables concurrently and tolerates migration replay", async () => {
  await db.execute(sql.raw("DROP TABLE IF EXISTS personal_endpoint_tasks, personal_endpoint_bots, personal_endpoint_pairing_codes"));
  await Promise.all([ensurePersonalEndpointTables(db), ensurePersonalEndpointTables(db)]);
  const migration = await readFile(new URL("../../../packages/db/src/migrations/0141_personal_endpoint_bots.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await db.execute(sql.raw(statement));
  const tables = await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'personal_endpoint_%'`);
  expect(tables).toHaveLength(3);
});
it("issues, pairs, verifies SHA-256-only credentials, records heartbeat, and lists online", async () => {
  const device = await pair();
  const scope = { companyId, deviceId: device.deviceId };
  expect(await verifyDeviceTokenDb(db, { ...scope, token: device.deviceToken })).toBe(true);
  expect(await verifyDeviceTokenDb(db, { ...scope, token: "wrong" })).toBe(false);
  const heartbeat = await recordHeartbeatDb(db, { ...scope, detectedClis: ["claude"], pendingOutboxCount: 2 });
  expect(heartbeat).toMatchObject({ online: true, pendingOutboxCount: 2 });
  const stored = await db.execute(sql`SELECT token_hash, token_preview FROM personal_endpoint_bots WHERE device_id = ${device.deviceId}`);
  expect(stored[0].token_hash).toBe(createHash("sha256").update(device.deviceToken).digest("hex"));
  const listed = await listEndpointsDb(db, companyId);
  expect(listed.find(e => e.deviceId === device.deviceId)).toMatchObject({ online: true, detectedClis: ["claude"] });
  expect(JSON.stringify([listed, heartbeat, device.tokenPreview])).not.toContain(device.deviceToken);
  expect(listed[0]).not.toHaveProperty("tokenHash");
  expect(device).not.toHaveProperty("tokenHash");
});
it("persists pending work and credentials across fresh server connections", async () => {
  const device = await pair(), scope = { companyId, deviceId: device.deviceId };
  const task = await enqueueLocalTaskDb(db, { ...scope, kind: "read_file", targetPath: "/work/a" });
  const fresh = createDb(temp.connectionString);
  try {
    await ensurePersonalEndpointTables(fresh);
    expect(await verifyDeviceTokenDb(fresh, { ...scope, token: device.deviceToken })).toBe(true);
    expect(await pollPendingTasksDb(fresh, scope)).toMatchObject([{ taskId: task.taskId }]);
  } finally { await fresh.$client.end({ timeout: 5 }); }
});
it("enqueues, repeatedly polls, and acknowledges with first-result-wins semantics", async () => {
  const { deviceId } = await pair(), scope = { companyId, deviceId };
  const task = await enqueueLocalTaskDb(db, { ...scope, kind: "shell_exec", targetPath: "/work", command: "pwd", args: [] });
  for (let i = 0; i < 2; i++) expect(await pollPendingTasksDb(db, scope)).toEqual([task]);
  const result = await ackTaskResultDb(db, { ...scope, taskId: task.taskId, ok: true, output: "/work" });
  expect(result).toMatchObject({ status: "completed", ok: true, output: "/work" });
  expect(await ackTaskResultDb(db, { ...scope, taskId: task.taskId, ok: false })).toEqual(result);
  expect(await pollPendingTasksDb(db, scope)).toEqual([]);
});
it("rejects writes and shell tasks in overlapping read-only folders", async () => {
  const { deviceId } = await pair();
  for (const kind of ["write_file", "shell_exec"] as const) {
    await expect(enqueueLocalTaskDb(db, { companyId, deviceId, kind, targetPath: "/work/private/a", command: "touch" })).rejects.toThrow("policy");
  }
  expect(await enqueueLocalTaskDb(db, { companyId, deviceId, kind: "read_file", targetPath: "/work/private/a" })).toMatchObject({ status: "pending" });
});
it("rejects traversal, sibling prefixes, and invalid task inputs", async () => {
  const { deviceId } = await pair();
  for (const targetPath of ["/work/../secret", "/work-other/a", "relative"]) {
    await expect(enqueueLocalTaskDb(db, { companyId, deviceId, kind: "read_file", targetPath })).rejects.toThrow();
  }
  await expect(pollPendingTasksDb(db, { companyId, deviceId, limit: 0 })).rejects.toThrow();
  await expect(recordHeartbeatDb(db, { companyId, deviceId, detectedClis: [], pendingOutboxCount: -1 })).rejects.toThrow();
});
it("isolates tokens, heartbeat, lists, enqueue, poll, and acknowledgements by company", async () => {
  const device = await pair(), foreign = { companyId: otherCompany, deviceId: device.deviceId };
  const task = await enqueueLocalTaskDb(db, { companyId, deviceId: device.deviceId, kind: "read_file", targetPath: "/work/a" });
  expect(await verifyDeviceTokenDb(db, { ...foreign, token: device.deviceToken })).toBe(false);
  expect((await listEndpointsDb(db, otherCompany)).some(e => e.deviceId === device.deviceId)).toBe(false);
  await expect(recordHeartbeatDb(db, { ...foreign, detectedClis: [], pendingOutboxCount: 0 })).rejects.toThrow();
  await expect(enqueueLocalTaskDb(db, { ...foreign, kind: "read_file", targetPath: "/work/a" })).rejects.toThrow();
  await expect(pollPendingTasksDb(db, foreign)).rejects.toThrow();
  await expect(ackTaskResultDb(db, { ...foreign, taskId: task.taskId, ok: true })).rejects.toThrow();
  const second = await pair();
  await expect(ackTaskResultDb(db, { companyId, deviceId: second.deviceId, taskId: task.taskId, ok: true })).rejects.toThrow();
});
it("consumes a pairing code atomically under concurrent pairing attempts", async () => {
  const { code } = await issuePairingCodeDb(db, { companyId, botName: "Race", requestedFolders: folders });
  const input = { companyId, code, deviceToken: randomBytes(32).toString("hex"), os: "linux", arch: "x64", detectedClis: [] };
  const results = await Promise.allSettled([completePairingDb(db, input), completePairingDb(db, input)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  if (results[0].status === "fulfilled") expect(results[0].value).not.toHaveProperty("deviceToken");
});
it("rejects foreign, expired, and invalid pairings without consuming valid codes", async () => {
  const { code } = await issuePairingCodeDb(db, { companyId, botName: "Scope", requestedFolders: folders });
  const input = { companyId, code, deviceToken: randomBytes(32).toString("hex"), os: "linux", arch: "x64", detectedClis: [] };
  await expect(completePairingDb(db, { ...input, companyId: otherCompany })).rejects.toThrow();
  await expect(completePairingDb(db, { ...input, os: "" })).rejects.toThrow();
  await expect(completePairingDb(db, { ...input, detectedClis: [null as never] })).rejects.toThrow();
  await expect(completePairingDb(db, { ...input, deviceToken: "short" })).rejects.toThrow();
  expect(await completePairingDb(db, input)).toMatchObject({ companyId });
  const expired = await issuePairingCodeDb(db, { companyId, botName: "Old", requestedFolders: [], nowMs: 1, ttlMs: 1 });
  await expect(completePairingDb(db, { ...input, code: expired.code })).rejects.toThrow();
});
it("disables all device operations after revocation and records failed task results", async () => {
  const device = await pair(), scope = { companyId, deviceId: device.deviceId };
  const task = await enqueueLocalTaskDb(db, { ...scope, kind: "read_file", targetPath: "/work/a" });
  expect(await ackTaskResultDb(db, { ...scope, taskId: task.taskId, ok: false, error: "missing" })).toMatchObject({ status: "failed", error: "missing" });
  await db.execute(sql`UPDATE personal_endpoint_bots SET revoked_at = now() WHERE device_id = ${device.deviceId}`);
  expect(await verifyDeviceTokenDb(db, { ...scope, token: device.deviceToken })).toBe(false);
  await expect(recordHeartbeatDb(db, { ...scope, detectedClis: [], pendingOutboxCount: 0 })).rejects.toThrow();
  await expect(pollPendingTasksDb(db, scope)).rejects.toThrow();
  expect((await listEndpointsDb(db, companyId)).some(e => e.deviceId === device.deviceId)).toBe(false);
});
it("applies Windows containment rules and rejects alternate streams and device paths", async () => {
  const { deviceId } = await pair(companyId, [{ path: "C:\\Work", mode: "rw" }]);
  expect(await enqueueLocalTaskDb(db, { companyId, deviceId, kind: "write_file", targetPath: "c:/WORK/a.txt" })).toMatchObject({ status: "pending" });
  for (const targetPath of ["C:/Work-other/a", "C:/Work/../secret", "C:/Work/a:stream", "C:/Work/NUL"]) {
    await expect(enqueueLocalTaskDb(db, { companyId, deviceId, kind: "read_file", targetPath })).rejects.toThrow();
  }
});
it("keeps one durable result during concurrent conflicting acknowledgements", async () => {
  const { deviceId } = await pair(), scope = { companyId, deviceId };
  const task = await enqueueLocalTaskDb(db, { ...scope, kind: "read_file", targetPath: "/work/a" });
  const [a, b] = await Promise.all([ackTaskResultDb(db, { ...scope, taskId: task.taskId, ok: true, output: "first" }),
    ackTaskResultDb(db, { ...scope, taskId: task.taskId, ok: false, error: "second" })]);
  expect(a).toEqual(b);
  expect(await pollPendingTasksDb(db, scope)).toEqual([]);
});
it("enforces the company/device foreign key even for direct SQL writes", async () => {
  const { deviceId } = await pair();
  await expect(db.execute(sql`INSERT INTO personal_endpoint_tasks (company_id, device_id, kind, target_path)
    VALUES (${otherCompany}, ${deviceId}, 'read_file', '/work/a')`)).rejects.toThrow();
});
it("marks stale heartbeats offline without losing the endpoint", async () => {
  const { deviceId } = await pair(), at = Date.now();
  await recordHeartbeatDb(db, { companyId, deviceId, detectedClis: [], pendingOutboxCount: 0, nowMs: at });
  expect((await listEndpointsDb(db, companyId, at + 60_001)).find(e => e.deviceId === deviceId)).toMatchObject({ online: false });
});
