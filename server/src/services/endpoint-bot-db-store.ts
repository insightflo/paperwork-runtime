import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personalEndpointBots as bots, personalEndpointPairingCodes as codes,
  personalEndpointTasks as tasks } from "@paperclipai/db/schema/personal_endpoint_bots";
import { createEndpointBotPairingService, createMemoryEndpointBotPairingStore,
  type DetectedCli, type LocalTask, type StoredEndpoint } from "./endpoint-bot-pairing.js";

type Service = ReturnType<typeof createEndpointBotPairingService>;
type Input<K extends keyof Service> = Parameters<Service[K]>[0];
type Scope = { companyId: string; deviceId: string };
type Bot = typeof bots.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const botScope = (s: Scope) => and(eq(bots.companyId, s.companyId), eq(bots.deviceId, s.deviceId), isNull(bots.revokedAt));
const taskScope = (s: Scope & { taskId: string }) => and(eq(tasks.companyId, s.companyId),
  eq(tasks.deviceId, s.deviceId), eq(tasks.taskId, s.taskId));
function timestamp(nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime())) throw new Error("invalid timestamp");
  return new Date(nowMs);
}
function required(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("non-empty string required");
}
function validator(row: Bot) {
  const store = createMemoryEndpointBotPairingStore();
  const endpoint: StoredEndpoint = { companyId: row.companyId, deviceId: row.deviceId, botName: row.botName,
    os: row.os, arch: row.arch, tokenHash: row.tokenHash, tokenPreview: row.tokenPreview,
    detectedClis: row.detectedClisJson, allowedFolders: row.allowedFoldersJson,
    lastSeenMs: row.lastSeenAt.getTime(), pendingOutboxCount: row.pendingOutboxCount };
  store.putEndpoint(endpoint);
  return createEndpointBotPairingService(store);
}
function taskView(row: typeof tasks.$inferSelect): LocalTask {
  return { companyId: row.companyId, deviceId: row.deviceId, taskId: row.taskId, kind: row.kind,
    targetPath: row.targetPath, command: row.command ?? undefined, args: row.argsJson ?? undefined,
    status: row.status, ok: row.ok ?? undefined, output: row.output ?? undefined, error: row.error ?? undefined,
    createdAtMs: row.createdAt.getTime(), completedAtMs: row.ackedAt?.getTime() };
}
async function activeEndpoint(db: Db | Tx, scope: Scope) {
  const [row] = await db.select().from(bots).where(botScope(scope)).for("share");
  if (!row) throw new Error("endpoint not found");
  return row;
}
/** Replay the packaged migration; serializes concurrent boots without modifying the journal. */
export async function ensurePersonalEndpointTables(db: Db): Promise<void> {
  const entry = pathToFileURL(createRequire(import.meta.url).resolve("@paperclipai/db"));
  const ddl = await readFile(new URL("./migrations/0141_personal_endpoint_bots.sql", entry), "utf8");
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(3500141)`);
    for (const statement of ddl.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.execute(sql.raw(statement));
    }
  });
}
export async function issuePairingCodeDb(db: Db, input: Input<"issuePairingCode">) {
  const at = timestamp(input.nowMs);
  const store = createMemoryEndpointBotPairingStore(), service = createEndpointBotPairingService(store);
  for (let attempt = 0; attempt < 5; attempt++) {
    const issued = service.issuePairingCode({ ...input, nowMs: at.getTime() }), code = store.getCode(issued.code)!;
    const [inserted] = await db.insert(codes).values({ code: code.code, companyId: input.companyId,
      botName: input.botName, requestedFoldersJson: code.allowedFolders, expiresAt: timestamp(issued.expiresAtMs),
      createdAt: at }).onConflictDoNothing().returning({ code: codes.code });
    if (inserted) return issued;
  }
  throw new Error("pairing code collision; retry issuance");
}
async function persistPairingDb(db: Db, input: { companyId?: string; code: string; deviceToken: string;
  os: string; arch: string; detectedClis: DetectedCli[]; nowMs?: number }) {
  required(input.os); required(input.arch); required(input.deviceToken);
  if (Buffer.byteLength(input.deviceToken) < 32) throw new Error("device token must contain at least 32 bytes");
  const at = timestamp(input.nowMs), tokenHash = hash(input.deviceToken), tokenPreview = `sha256:${tokenHash.slice(0, 8)}`;
  return db.transaction(async tx => {
    const [code] = await tx.update(codes).set({ consumedAt: at }).where(and(
      input.companyId === undefined ? undefined : eq(codes.companyId, input.companyId),
      eq(codes.code, input.code), isNull(codes.consumedAt), gt(codes.expiresAt, at))).returning();
    if (!code) throw new Error("invalid or expired pairing code");
    const row: Bot = { companyId: code.companyId, deviceId: randomUUID(), botName: code.botName, tokenHash, tokenPreview,
      os: input.os, arch: input.arch, detectedClisJson: input.detectedClis, allowedFoldersJson: code.requestedFoldersJson,
      pendingOutboxCount: 0, lastSeenAt: at, revokedAt: null, createdAt: at };
    validator(row).recordHeartbeat({ companyId: row.companyId, deviceId: row.deviceId,
      detectedClis: input.detectedClis, pendingOutboxCount: 0, nowMs: at.getTime() });
    await tx.insert(bots).values(row);
    return { companyId: row.companyId, deviceId: row.deviceId, botName: row.botName, tokenPreview };
  });
}
/** The device supplies its own random token (at least 32 bytes); plaintext is never stored or returned. */
export async function completePairingDb(db: Db, input: Parameters<typeof persistPairingDb>[1] & { companyId: string }) {
  required(input.companyId);
  return persistPairingDb(db, input);
}
/** Public code redemption: return the server-generated credential only after the transaction commits. */
export async function completePairingByCodeDb(db: Db, input: Input<"completePairing">) {
  const deviceToken = randomBytes(32).toString("hex");
  const paired = await persistPairingDb(db, { code: input.code, os: input.os, arch: input.arch,
    detectedClis: input.detectedClis, nowMs: input.nowMs, deviceToken });
  return { companyId: paired.companyId, deviceId: paired.deviceId, botName: paired.botName, deviceToken };
}
export async function verifyDeviceTokenDb(db: Db, input: Scope & { token: string }): Promise<boolean> {
  const [row] = await db.select({ tokenHash: bots.tokenHash }).from(bots).where(botScope(input));
  const matches = timingSafeEqual(Buffer.from(row?.tokenHash ?? "0".repeat(64), "hex"), Buffer.from(hash(input.token), "hex"));
  return !!row && matches;
}
export async function recordHeartbeatDb(db: Db, input: Input<"recordHeartbeat">) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(bots).where(botScope(input)).for("update");
    if (!row) throw new Error("endpoint not found");
    const view = validator(row).recordHeartbeat(input);
    await tx.update(bots).set({ detectedClisJson: view.detectedClis, pendingOutboxCount: view.pendingOutboxCount,
      lastSeenAt: timestamp(view.lastSeenMs) }).where(botScope(input));
    return view;
  });
}
export async function listEndpointsDb(db: Db, companyId: string, nowMs?: number) {
  required(companyId);
  const at = timestamp(nowMs).getTime();
  const rows = await db.select().from(bots).where(and(eq(bots.companyId, companyId), isNull(bots.revokedAt)))
    .orderBy(asc(bots.createdAt), asc(bots.deviceId));
  return rows.map(row => validator(row).listEndpoints(companyId, at)[0]);
}
export async function enqueueLocalTaskDb(db: Db, input: Input<"enqueueLocalTask">): Promise<LocalTask> {
  return db.transaction(async tx => {
    const row = await activeEndpoint(tx, input);
    // Reuse the existing POSIX/Windows lexical policy; the device must still check real paths/symlinks.
    const task = validator(row).enqueueLocalTask(input);
    const [inserted] = await tx.insert(tasks).values({ companyId: input.companyId, deviceId: input.deviceId,
      taskId: task.taskId, kind: task.kind, targetPath: task.targetPath, command: task.command,
      argsJson: task.args, createdAt: timestamp(task.createdAtMs) }).returning();
    return taskView(inserted);
  });
}
/** At-least-once: tasks remain pending until a device-scoped, first-wins acknowledgement. */
export async function pollPendingTasksDb(db: Db, input: Input<"pollPendingTasks">): Promise<LocalTask[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid limit");
  return db.transaction(async tx => {
    await activeEndpoint(tx, input);
    const rows = await tx.select().from(tasks).where(and(eq(tasks.companyId, input.companyId),
      eq(tasks.deviceId, input.deviceId), eq(tasks.status, "pending"))).orderBy(asc(tasks.createdAt), asc(tasks.taskId)).limit(limit);
    return rows.map(taskView);
  });
}
export async function ackTaskResultDb(db: Db, input: Input<"ackTaskResult">): Promise<LocalTask> {
  if (typeof input.ok !== "boolean" || (input.output !== undefined && typeof input.output !== "string")
    || (input.error !== undefined && typeof input.error !== "string")) throw new Error("invalid task result");
  const at = timestamp(input.nowMs);
  return db.transaction(async tx => {
    await activeEndpoint(tx, input);
    const [row] = await tx.update(tasks).set({ status: input.ok ? "completed" : "failed", ok: input.ok,
      output: input.output ?? null, error: input.error ?? null, ackedAt: at })
      .where(and(taskScope(input), eq(tasks.status, "pending"))).returning();
    if (row) return taskView(row);
    const [existing] = await tx.select().from(tasks).where(taskScope(input));
    if (!existing) throw new Error("task not found");
    return taskView(existing);
  });
}
