import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb } from "@paperclipai/db";
import { personalEndpointTasks } from "@paperclipai/db/schema/personal_endpoint_bots";
import { collabChannelsService } from "../services/collab-channels.js";
import { completePairingDb, issuePairingCodeDb } from "../services/endpoint-bot-db-store.js";
import { createEndpointBotPairingService } from "../services/endpoint-bot-pairing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("collab-endpoint-db-");
  db = createDb(temp.connectionString);
}, 60_000);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await temp?.cleanup();
});

async function setup(store?: Parameters<typeof collabChannelsService>[1]) {
  const [company] = await db.insert(companies).values({
    name: "Endpoint channel", issuePrefix: randomUUID(),
  }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "alpha" }).returning();
  const svc = collabChannelsService(db, store);
  const channel = await svc.createChannel(company.id, { name: "Ops", memberAgentIds: [agent.id] });
  const thread = await svc.createThread(company.id, channel.id, {
    title: "Endpoint work", body: "Start", authorType: "user", authorId: "local-board",
  });
  return { company, agent, svc, channel, thread };
}
type Context = Awaited<ReturnType<typeof setup>>;
async function post(ctx: Context, body: string, svc = ctx.svc) {
  return svc.postMessage(ctx.company.id, ctx.channel.id, ctx.thread.id, {
    body, authorType: "user", authorId: "local-board",
  });
}
async function replies(ctx: Context) {
  return (await ctx.svc.listMessages(ctx.company.id, ctx.channel.id, ctx.thread.id))
    .filter(message => message.authorType === "system");
}
async function tasks(ctx: Context, reader = db) {
  return reader.select().from(personalEndpointTasks).where(eq(personalEndpointTasks.companyId, ctx.company.id));
}
async function pair(ctx: Context, mode: "ro" | "rw" = "rw", nowMs = Date.now()) {
  const { code } = await issuePairingCodeDb(db, {
    companyId: ctx.company.id, botName: "my-mac", requestedFolders: [{ path: "/workspace", mode }], nowMs,
  });
  return completePairingDb(db, {
    companyId: ctx.company.id, code, deviceToken: randomBytes(32).toString("hex"),
    os: "darwin", arch: "arm64", detectedClis: [], nowMs,
  });
}

it("keeps injected stores and ordinary messages independent of endpoint tables, then initializes once", async () => {
  await db.execute(sql.raw("DROP TABLE IF EXISTS personal_endpoint_tasks, personal_endpoint_bots, personal_endpoint_pairing_codes"));
  const memory = createEndpointBotPairingService();
  const injected = await setup(memory);
  const { code } = memory.issuePairingCode({
    companyId: injected.company.id, botName: "memory", requestedFolders: [{ path: "/workspace", mode: "rw" }],
  });
  const device = memory.completePairing({ code, os: "darwin", arch: "arm64", detectedClis: [] });
  await post(injected, "@memory list /workspace");
  const [task] = memory.pollPendingTasks({ companyId: injected.company.id, deviceId: device.deviceId });
  expect(task).toMatchObject({ kind: "list_dir", targetPath: "/workspace", status: "pending" });
  expect((await replies(injected))[0].body).toBe(`Queued task ${task.taskId} for @memory.`);

  const ctx = await setup();
  await post(ctx, "ordinary message");
  expect(await replies(ctx)).toEqual([]);
  expect((await db.execute(sql`SELECT to_regclass('public.personal_endpoint_tasks') AS name`))[0].name).toBeNull();
  const transaction = vi.spyOn(db, "transaction");
  try {
    // Two service instances sharing a Db must share the same initialization promise.
    await Promise.all([
      post(ctx, "@ghost list /workspace"),
      post(injected, "@ghost list /workspace", collabChannelsService(db)),
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
    await post(ctx, "@ghost list /workspace", collabChannelsService(db));
    expect(transaction).toHaveBeenCalledTimes(1);
  } finally { transaction.mockRestore(); }
  expect(await replies(ctx)).toHaveLength(2);
  expect((await replies(ctx)).every(reply =>
    reply.body === "No paired endpoint named @ghost was found in this company.")).toBe(true);
  expect(await tasks(ctx)).toEqual([]);
});

it("dispatches a Postgres-paired bot from a fresh connection and persists its task and thread reply", async () => {
  const ctx = await setup();
  const device = await pair(ctx);
  const fresh = createDb(temp.connectionString);
  try {
    const posted = await post(ctx, "@my-mac list /workspace", collabChannelsService(fresh));
    expect(posted).toMatchObject({ authorType: "user", body: "@my-mac list /workspace" });
    const stored = await tasks(ctx); // Read through the original connection, not dispatcher state.
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      companyId: ctx.company.id, deviceId: device.deviceId, kind: "list_dir",
      targetPath: "/workspace", status: "pending",
    });
    const reply = await replies(ctx);
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({
      companyId: ctx.company.id, channelId: ctx.channel.id, threadId: ctx.thread.id,
      actionKind: "message", expectsReply: false,
      body: `Queued task ${stored[0].taskId} for @my-mac.`,
    });
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, ctx.company.id), eq(agentWakeupRequests.source, "on_demand"),
    ));
    expect(wakes).toHaveLength(2);
    expect(wakes.every(wake => wake.agentId === ctx.agent.id
      && wake.payload?.threadId === ctx.thread.id)).toBe(true);
  } finally { await fresh.$client.end({ timeout: 5 }); }
});

it("keeps stale endpoints offline without enqueuing a task", async () => {
  const ctx = await setup();
  await pair(ctx, "rw", Date.now() - 61_000);
  await post(ctx, "@my-mac list /workspace");
  expect(await tasks(ctx)).toEqual([]);
  expect((await replies(ctx))[0].body).toBe("@my-mac is offline. Reconnect the device and try again.");
});

it.each([
  ["ro", "@my-mac run /workspace -- pwd"],
  ["rw", "@my-mac read /workspace-other/secret"],
  ["rw", "@my-mac list /workspace/../secret"],
] as const)("preserves folder-policy denials (%s, %s)", async (mode, command) => {
  const ctx = await setup();
  await pair(ctx, mode);
  await post(ctx, command);
  expect(await tasks(ctx)).toEqual([]);
  expect((await replies(ctx))[0].body).toBe(
    "@my-mac could not accept this task. Check the allowed path and folder permissions.",
  );
});

it("enqueues read and shell commands with their original payloads", async () => {
  const ctx = await setup();
  const device = await pair(ctx);
  await post(ctx, "@MY-MAC read /workspace/README.md");
  await post(ctx, "@my-mac run /workspace -- pwd");
  expect(await tasks(ctx)).toEqual(expect.arrayContaining([
    expect.objectContaining({ deviceId: device.deviceId, kind: "read_file", targetPath: "/workspace/README.md" }),
    expect.objectContaining({ deviceId: device.deviceId, kind: "shell_exec", targetPath: "/workspace", command: "pwd" }),
  ]));
  expect(await tasks(ctx)).toHaveLength(2);
  expect(await replies(ctx)).toHaveLength(2);
});

it("does not dispatch endpoints belonging to another company", async () => {
  const owner = await setup();
  await pair(owner);
  const stranger = await setup();
  await post(stranger, "@my-mac list /workspace");
  expect(await tasks(owner)).toEqual([]);
  expect(await tasks(stranger)).toEqual([]);
  expect((await replies(stranger))[0].body).toBe("No paired endpoint named @my-mac was found in this company.");
});
