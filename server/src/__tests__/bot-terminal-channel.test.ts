import { createHash, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { createEnterpriseBotsRouter } from "../routes/enterprise-bots.js";
import {
  BOT_CHANNEL_OWNER_APPROVAL_TYPE,
  HEARTBEAT_ONLINE_WINDOW_MS,
  HEALTH_HISTORY_MAX,
  createBotTerminalChannelService, createTerminalToken, hashTerminalToken, sanitizeAuditDetails,
  type BotActor, type BotAuditEventRecord, type BotCapabilityRecord, type BotPendingApprovalRecord, type BotTerminalRecord,
  type BotTerminalChannelServiceOptions, type EnterpriseBotRecord, type EnterpriseBotStore,
  type NewBotTerminal,
} from "../services/bot-terminal-channel.js";

const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER_COMPANY = "00000000-0000-4000-8000-000000000002";
const TEAM_SALES = "10000000-0000-4000-8000-000000000001";
const TEAM_HR = "10000000-0000-4000-8000-000000000002";
const BOT_PERSONAL = "20000000-0000-4000-8000-000000000001";
const BOT_TEAM_HR = "20000000-0000-4000-8000-000000000002";
const CHANNEL_SHARED = "30000000-0000-4000-8000-000000000001";
const OWNER = "u-owner";
const SALES = "u-sales";

const actor = (overrides: Partial<BotActor> = {}): BotActor => ({ userId: SALES, companyId: COMPANY, teamId: TEAM_SALES, role: "member", ...overrides });
interface MemoryStoreSeed {
  approvals?: Array<{ botId: string; channelId: string; botOwnerUserId: string }>;
  pendingApprovals?: BotPendingApprovalRecord[];
  auditEvents?: BotAuditEventRecord[];
}

function createMemoryStore(seed: MemoryStoreSeed = {}) {
  const terminals = new Map<string, BotTerminalRecord>();
  const teamsList = [
    { id: TEAM_SALES, name: "Sales" },
    { id: TEAM_HR, name: "HR" },
  ];
  const bots = new Map<string, EnterpriseBotRecord>([
    [BOT_PERSONAL, {
      id: BOT_PERSONAL, companyId: COMPANY, kind: "personal", name: "Personal Bot",
      ownerUserId: OWNER, teamId: null, agentId: null, callableBy: "company", status: "active",
      webhookUrl: null, tokenSecretId: null, inboundTokenHash: null, lastPingAt: null, lastPingStatus: null,
    }],
    [BOT_TEAM_HR, {
      id: BOT_TEAM_HR, companyId: COMPANY, kind: "team", name: "HR Bot",
      ownerUserId: null, teamId: TEAM_HR, agentId: null, callableBy: "company", status: "active",
      webhookUrl: null, tokenSecretId: null, inboundTokenHash: null, lastPingAt: null, lastPingStatus: null,
    }],
  ]);
  const capabilities: BotCapabilityRecord[] = [
    { botId: BOT_PERSONAL, capabilityKey: "inbox.triage", callableBy: "company", dataScope: "company", requiresApproval: false },
    { botId: BOT_PERSONAL, capabilityKey: "hr.salary.read", callableBy: "company", dataScope: "self", requiresApproval: false },
    { botId: BOT_PERSONAL, capabilityKey: "hr.salary.export", callableBy: "company", dataScope: "self", requiresApproval: true },
    { botId: BOT_TEAM_HR, capabilityKey: "hr.records.read", callableBy: "company", dataScope: "team", requiresApproval: false },
  ];
  const pendingApprovals = new Map<string, BotPendingApprovalRecord>(
    (seed.pendingApprovals ?? []).map((a) => [a.id, { ...a }]),
  );
  const store: EnterpriseBotStore = {
    async createTerminal(input: NewBotTerminal) {
      const record: BotTerminalRecord = {
        ...input, id: randomUUID(), status: "offline", lastSeenAt: null, revokedAt: null, telemetry: null, healthHistory: null,
      };
      terminals.set(record.id, record);
      return { ...record };
    },
    getTerminal: async (companyId, id) => { const t = terminals.get(id); return t && t.companyId === companyId ? { ...t } : null; },
    getTerminalById: async (id) => { const t = terminals.get(id); return t ? { ...t } : null; },
    async markTerminalSeen(id, seenAt, update) {
      const t = terminals.get(id);
      if (t) {
        Object.assign(t, {
          status: "online",
          lastSeenAt: seenAt,
          ...(update?.telemetry !== undefined ? { telemetry: update.telemetry } : {}),
          ...(update?.healthHistory !== undefined ? { healthHistory: update.healthHistory } : {}),
        });
      }
    },
    async revokeTerminal(id, revokedAt) { const t = terminals.get(id); if (t) Object.assign(t, { status: "revoked", revokedAt }); },
    getBot: async (companyId, id) => { const b = bots.get(id); return b && b.companyId === companyId ? { ...b } : null; },
    getBotById: async (id) => { const b = bots.get(id); return b ? { ...b } : null; },
    listBots: async (companyId) => [...bots.values()].filter((b) => b.companyId === companyId).map((b) => ({ ...b })),
    listBotCapabilities: async (botIds) => capabilities.filter((c) => botIds.includes(c.botId)).map((c) => ({ ...c })),
    listTerminals: async (companyId) => [...terminals.values()].filter((t) => t.companyId === companyId).map((t) => ({ ...t })),
    listTeams: async (companyId) => companyId === COMPANY ? teamsList.map((t) => ({ ...t })) : [],
    listChannels: async (companyId) => companyId === COMPANY ? [{ id: CHANNEL_SHARED, companyId: COMPANY, kind: "shared", name: "Shared", teamId: null }] : [],
    listPendingApprovals: async (companyId) => [...pendingApprovals.values()].filter((a) => a.companyId === companyId && a.status === "pending").map((a) => ({ ...a })),
    listAuditEvents: async (companyId, limit) => (seed.auditEvents ?? [])
      .filter((e) => e.companyId === companyId)
      .slice(0, limit)
      .map((e) => ({ ...e })),
    async createBot(input, caps) {
      const bot: EnterpriseBotRecord = {
        ...input, id: randomUUID(), lastPingAt: null, lastPingStatus: null, createdAt: NOW, updatedAt: NOW,
      };
      bots.set(bot.id, bot);
      const insertedCaps: BotCapabilityRecord[] = caps.map((c) => ({
        botId: bot.id, capabilityKey: c.capabilityKey, callableBy: c.callableBy,
        dataScope: c.dataScope ?? "self", requiresApproval: c.requiresApproval ?? false,
      }));
      capabilities.push(...insertedCaps);
      return { bot: { ...bot }, capabilities: insertedCaps };
    },
    async updateBot(companyId, botId, patch, caps) {
      const bot = bots.get(botId);
      if (!bot || bot.companyId !== companyId) return null;
      Object.assign(bot, patch);
      if (caps !== undefined) {
        for (let i = capabilities.length - 1; i >= 0; i -= 1) {
          if (capabilities[i].botId === botId) capabilities.splice(i, 1);
        }
        capabilities.push(...caps.map((c) => ({
          botId, capabilityKey: c.capabilityKey, callableBy: c.callableBy,
          dataScope: c.dataScope ?? "self", requiresApproval: c.requiresApproval ?? false,
        })));
      }
      return { bot: { ...bot }, capabilities: capabilities.filter((c) => c.botId === botId).map((c) => ({ ...c })) };
    },
    async deleteBot(companyId, botId) {
      const bot = bots.get(botId);
      if (!bot || bot.companyId !== companyId) return false;
      bots.delete(botId);
      return true;
    },
    async recordBotPing(companyId, botId, pingAt, status, healthHistory) {
      const bot = bots.get(botId);
      if (bot && bot.companyId === companyId) {
        Object.assign(bot, {
          lastPingAt: pingAt,
          lastPingStatus: status,
          ...(healthHistory !== undefined ? { healthHistory } : {}),
        });
      }
    },
    async decideApproval(companyId, approvalId, decidedByUserId, status, note, decidedAt) {
      const a = pendingApprovals.get(approvalId);
      if (!a || a.companyId !== companyId) return null;
      Object.assign(a, { status, decidedByUserId, decisionNote: note, decidedAt });
      return { ...a };
    },
    getBotCapability: async (botId, capabilityKey) => capabilities.find((c) => c.botId === botId && c.capabilityKey === capabilityKey) ?? null,
    getChannel: async (companyId, id) => id === CHANNEL_SHARED && companyId === COMPANY ? { id, companyId, kind: "shared", teamId: null } : null,
    listChannelMemberIds: async () => [OWNER, SALES, "u-hr", BOT_PERSONAL, BOT_TEAM_HR],
    hasChannelOwnerApproval: async (_companyId, botId, botOwnerUserId, channelId) =>
      (seed.approvals ?? []).some((a) => a.botId === botId && a.channelId === channelId && a.botOwnerUserId === botOwnerUserId),
  };
  return { store, terminals, bots, pendingApprovals };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2026-01-15T10:00:00.000Z");
function setup(seed: MemoryStoreSeed = {}, options: BotTerminalChannelServiceOptions = {}) {
  const memory = createMemoryStore(seed);
  return { ...memory, service: createBotTerminalChannelService(memory.store, { now: () => NOW, ...options }) };
}

async function registerPersonalTerminal(service: ReturnType<typeof setup>["service"], owner = OWNER) {
  return service.registerTerminal(actor({ userId: owner, role: owner }), { companyId: COMPANY, kind: "personal_terminal", name: "ops-laptop" });
}

describe("registerTerminal", () => {
  it("stores only the SHA-256 hash and returns the plaintext token exactly once", async () => {
    const { service, terminals } = setup();
    const { terminal, token } = await registerPersonalTerminal(service);
    expect(token).toMatch(/^pcp_term_[0-9a-f]{64}$/);
    expect(terminal.tokenHash).toBe(sha256(token));
    expect(terminal.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(terminal.tokenHash).not.toBe(token);
    expect(JSON.stringify([...terminals.values()])).not.toContain(token);
    expect(token).not.toBe(terminal.tokenHash);
    const second = await registerPersonalTerminal(service);
    expect(second.token).not.toBe(token);
    expect(createTerminalToken()).not.toBe(hashTerminalToken(token));
  });

  it("enforces company scope and personal_terminal ownership", async () => {
    const { service } = setup();
    await expect(service.registerTerminal(actor(), { companyId: OTHER_COMPANY, kind: "personal_terminal", name: "x" }))
      .rejects.toMatchObject({ status: 403, message: "company_scope_denied" });
    await expect(service.registerTerminal(actor(), { companyId: COMPANY, kind: "personal_terminal", name: "x", ownerUserId: OWNER }))
      .rejects.toMatchObject({ status: 403, message: "personal_terminal_owner_required" });
    const delegated = await service.registerTerminal(actor({ role: "admin" }), { companyId: COMPANY, kind: "personal_terminal", name: "x", ownerUserId: OWNER });
    expect(delegated.terminal.ownerUserId).toBe(OWNER);
    const own = await service.registerTerminal(actor(), { companyId: COMPANY, kind: "personal_terminal", name: "x" });
    expect(own.terminal.ownerUserId).toBe(SALES);
    expect(own.terminal.status).toBe("offline");
  });

  it("enforces team scope for worker nodes and bot scope for both kinds", async () => {
    const { service } = setup();
    await expect(service.registerTerminal(actor(), { companyId: COMPANY, kind: "worker_node", name: "x" }))
      .rejects.toMatchObject({ status: 400, message: "team_required" });
    await expect(service.registerTerminal(actor(), { companyId: COMPANY, kind: "worker_node", name: "x", teamId: TEAM_HR }))
      .rejects.toMatchObject({ status: 403, message: "team_scope_denied" });
    const node = await service.registerTerminal(actor(), { companyId: COMPANY, kind: "worker_node", name: "x", teamId: TEAM_SALES });
    expect(node.terminal).toMatchObject({ kind: "worker_node", teamId: TEAM_SALES, ownerUserId: null, transport: "outbound_wss" });
    await expect(service.registerTerminal(actor(), { companyId: COMPANY, kind: "personal_terminal", name: "x", botId: BOT_TEAM_HR }))
      .rejects.toMatchObject({ status: 403, message: "terminal_bot_scope_mismatch" });
    await expect(service.registerTerminal(actor(), { companyId: COMPANY, kind: "personal_terminal", name: "x", botId: randomUUID() }))
      .rejects.toMatchObject({ status: 404, message: "bot_not_found" });
  });
});

describe("getCompanySnapshot derived terminal status", () => {
  it("derives online/offline/revoked from lastSeenAt freshness at read time", async () => {
    const { service, terminals } = setup();
    const { terminal, token } = await registerPersonalTerminal(service);
    await service.heartbeatTerminal(terminal.id, token);
    const statusNow = () =>
      service.getCompanySnapshot(COMPANY).then((s) => s.terminals.find((t) => t.id === terminal.id)!.status);
    expect(await statusNow()).toBe("online");
    const stored = [...terminals.values()].find((t) => t.id === terminal.id)!;
    stored.lastSeenAt = new Date(NOW.getTime() - HEARTBEAT_ONLINE_WINDOW_MS - 1_000);
    expect(await statusNow()).toBe("offline");
    stored.revokedAt = NOW;
    expect(await statusNow()).toBe("revoked");
  });
});

describe("heartbeatTerminal", () => {
  it("accepts the registered token timing-safely and marks the terminal online", async () => {
    const { service } = setup();
    const { terminal, token } = await registerPersonalTerminal(service);
    const beat = await service.heartbeatTerminal(terminal.id, token);
    expect(beat).toMatchObject({ id: terminal.id, status: "online", lastSeenAt: NOW });
  });

  it("rejects wrong, malformed, and unknown tokens fail-closed", async () => {
    const { service } = setup();
    const { terminal, token } = await registerPersonalTerminal(service);
    const flipped = (token.slice(0, -1)) + (token.endsWith("0") ? "1" : "0");
    for (const bad of [flipped, token.toUpperCase(), "", ` ${token}`, "a".repeat(257), null, undefined, 42]) {
      await expect(service.heartbeatTerminal(terminal.id, bad)).rejects.toMatchObject({ status: 401, message: "terminal_token_rejected" });
    }
    await expect(service.heartbeatTerminal(randomUUID(), token)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects revoked terminals even with the correct token", async () => {
    const { service } = setup();
    const { terminal, token } = await registerPersonalTerminal(service);
    await service.commandTerminal(actor({ userId: OWNER, role: "owner" }), terminal.id, "revoke");
    await expect(service.heartbeatTerminal(terminal.id, token)).rejects.toMatchObject({ status: 403, message: "terminal_revoked" });
  });
});

describe("commandTerminal", () => {
  it("denies admin exec on a personal_terminal but allows stop and revoke", async () => {
    const { service } = setup();
    const admin = actor({ userId: "u-admin", role: "admin" });
    const { terminal } = await registerPersonalTerminal(service);
    await expect(service.commandTerminal(admin, terminal.id, "exec")).rejects.toMatchObject({ status: 403, message: "personal_terminal_exec_denied" });
    expect((await service.commandTerminal(admin, terminal.id, "stop")).decision).toEqual({ allowed: true, reason: "allowed" });
    const revoked = await service.commandTerminal(admin, terminal.id, "revoke");
    expect(revoked.terminal).toMatchObject({ status: "revoked", revokedAt: NOW });
    await expect(service.commandTerminal(admin, terminal.id, "stop")).rejects.toMatchObject({ status: 403, message: "terminal_revoked" });
  });

  it("allows the owner, denies other members, and hides other companies", async () => {
    const { service } = setup();
    const { terminal } = await registerPersonalTerminal(service);
    expect((await service.commandTerminal(actor({ userId: OWNER, role: "member" }), terminal.id, "exec")).decision.allowed).toBe(true);
    await expect(service.commandTerminal(actor(), terminal.id, "stop")).rejects.toMatchObject({ status: 403, message: "personal_terminal_access_denied" });
    await expect(service.commandTerminal(actor({ companyId: OTHER_COMPANY }), terminal.id, "revoke")).rejects.toMatchObject({ status: 404, message: "terminal_not_found" });
  });

  it("requires explicit owner context when a personal bot drives a personal terminal", async () => {
    const { service } = setup();
    const { terminal } = await registerPersonalTerminal(service);
    const relay = actor({ userId: OWNER, role: "member" });
    await expect(service.commandTerminal(relay, terminal.id, "exec", { botId: BOT_PERSONAL }))
      .rejects.toMatchObject({ status: 403, message: "personal_terminal_access_denied" });
    const allowed = await service.commandTerminal(relay, terminal.id, "exec", { botId: BOT_PERSONAL, explicitOwnerContext: true });
    expect(allowed.decision).toEqual({ allowed: true, reason: "allowed" });
  });
});

describe("invokeChannelMention", () => {
  it("gates a shared-channel @mention of a personal bot on owner approval", async () => {
    const denied = setup();
    await expect(denied.service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_PERSONAL, "personal_terminal", "inbox.triage"))
      .rejects.toMatchObject({ status: 403, message: "personal_terminal_requires_owner_approval" });
    const approved = setup({ approvals: [{ botId: BOT_PERSONAL, channelId: CHANNEL_SHARED, botOwnerUserId: OWNER }] });
    const result = await approved.service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_PERSONAL, "personal_terminal", "inbox.triage");
    expect(result).toMatchObject({ forcedFilter: { companyId: COMPANY }, requiresApproval: false });
    await expect(approved.service.invokeChannelMention(actor({ userId: "u-outsider" }), CHANNEL_SHARED, BOT_PERSONAL, "personal_terminal", "inbox.triage"))
      .rejects.toMatchObject({ status: 403, message: "caller_not_channel_member" });
  });

  it("fails closed on cross-team secrets and unknown channel/bot/capability", async () => {
    const { service } = setup();
    await expect(service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_TEAM_HR, "worker_node", "hr.records.read"))
      .rejects.toMatchObject({ status: 403, message: "cross_team_secrets_denied" });
    await expect(service.invokeChannelMention(actor(), randomUUID(), BOT_PERSONAL, "personal_terminal", "inbox.triage"))
      .rejects.toMatchObject({ status: 404, message: "channel_not_found" });
    await expect(service.invokeChannelMention(actor(), CHANNEL_SHARED, randomUUID(), "personal_terminal", "inbox.triage"))
      .rejects.toMatchObject({ status: 404, message: "bot_not_found" });
    await expect(service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_PERSONAL, "personal_terminal", "nope"))
      .rejects.toMatchObject({ status: 404, message: "capability_not_found" });
    await expect(service.invokeChannelMention(actor({ companyId: OTHER_COMPANY }), CHANNEL_SHARED, BOT_PERSONAL, "personal_terminal", "inbox.triage"))
      .rejects.toMatchObject({ status: 404, message: "channel_not_found" });
  });

  it("enforces Sales→HR dataScope self", async () => {
    const { service } = setup();
    const hrRecord = { ownerUserId: "u-hr", teamId: TEAM_HR, companyId: COMPANY };
    await expect(service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_PERSONAL, "none", "hr.salary.read", hrRecord))
      .rejects.toMatchObject({ status: 403, message: "data_scope_self_violation" });
    await expect(service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_PERSONAL, "none", "hr.salary.read"))
      .rejects.toMatchObject({ status: 403, message: "data_scope_self_violation" });
    const own = await service.invokeChannelMention(actor(), CHANNEL_SHARED, BOT_PERSONAL, "none", "hr.salary.read", { ...hrRecord, ownerUserId: SALES });
    expect(own.forcedFilter).toEqual({ ownerUserId: SALES });
    expect(own.forcedFilter).not.toHaveProperty("teamId");
  });
});

function createApp(
  resolveActor: Parameters<typeof createEnterpriseBotsRouter>[1],
  seed: MemoryStoreSeed = {},
  options: BotTerminalChannelServiceOptions = {},
) {
  const { service, terminals, bots } = setup(seed, options);
  const app = express();
  app.use(express.json());
  app.use("/api", createEnterpriseBotsRouter(service, resolveActor));
  app.use(errorHandler);
  return { app, service, terminals, bots };
}

// Router tests authenticate by header; admins get the admin role so the exec-denied path is exercised.
const resolveFromHeader = () => (req: Request, _companyId: string) => {
  const user = String(req.headers["x-actor"] ?? "");
  if (!user) return null;
  const role = user === "u-admin" ? "admin" : user === "u-viewer" ? "viewer" : "member";
  return actor({ userId: user, role });
};

describe("enterprise-bots router", () => {
  it("registers, heartbeats, and never exposes the token outside the 201 response", async () => {
    const { app, terminals } = createApp(resolveFromHeader());
    const registered = await request(app).post("/api/terminals/register").set("x-actor", OWNER)
      .send({ companyId: COMPANY, kind: "personal_terminal", name: "ops-laptop" }).expect(201);
    expect(registered.body.token).toMatch(/^pcp_term_/);
    expect(registered.body.terminal).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(registered.body.terminal)).not.toContain(registered.body.token);
    expect([...terminals.values()][0].tokenHash).toBe(sha256(registered.body.token));

    const id = registered.body.terminal.id;
    const beat = await request(app).post(`/api/terminals/${id}/heartbeat`).set("Authorization", `Bearer ${registered.body.token}`).expect(200);
    expect(beat.body.terminal).toMatchObject({ id, status: "online" });
    const missing = await request(app).post(`/api/terminals/${id}/heartbeat`).expect(401);
    expect(missing.body.error).toBe("terminal_token_rejected");
    const wrong = await request(app).post(`/api/terminals/${id}/heartbeat`).set("Authorization", "Bearer not-the-token").expect(401);
    expect(JSON.stringify(wrong.body)).not.toContain("not-the-token");
    await request(app).post(`/api/terminals/not-a-uuid/heartbeat`).set("Authorization", `Bearer ${registered.body.token}`).expect(400);
  });

  it("accepts the paperwork-bot heartbeat wire shape and rejects the legacy flat shape", async () => {
    // Mirrors `build_enriched_heartbeat_payload` in crates/bot-runtime/src/client.rs.
    const { app, terminals } = createApp(resolveFromHeader());
    const reg = await request(app).post("/api/terminals/register").set("x-actor", OWNER)
      .send({ companyId: COMPANY, kind: "personal_terminal", name: "rust-daemon" }).expect(201);
    const terminalId = reg.body.terminal.id as string;
    const post = (body: unknown) => request(app).post(`/api/terminals/${terminalId}/heartbeat`)
      .set("Authorization", `Bearer ${reg.body.token as string}`).send(body);

    // Legacy shape: telemetry flat on the body, string protocolVersion, null lastRttMs -> strict() rejects.
    await post({ status: "online", hostname: null, os: "macos", arch: "aarch64", daemonVersion: "0.1.0",
      protocolVersion: "1.0", uptimeSecs: 0, lastRttMs: null, activeChildren: 0 }).expect(400);

    // First beat: no lastRttMs key at all (not null).
    const identity = { os: "macos", arch: "aarch64", daemonVersion: "0.1.0", protocolVersion: 1 };
    const first = await post({ telemetry: { ...identity, uptimeSecs: 0, activeChildren: 0 } }).expect(200);
    expect(first.body.terminal.telemetry).toEqual({ ...identity, uptimeSecs: 0, activeChildren: 0 });
    expect(first.body.terminal.healthHistory.at(-1)).toMatchObject({ ok: true, rttMs: null });

    // Second beat: lastRttMs is a number and the persisted terminal carries it.
    const second = await post({ telemetry: { ...identity, uptimeSecs: 15, activeChildren: 1, lastRttMs: 12 } }).expect(200);
    expect(second.body.terminal.telemetry).toMatchObject({ protocolVersion: 1, uptimeSecs: 15, activeChildren: 1, lastRttMs: 12 });
    expect(second.body.terminal.healthHistory.at(-1)).toMatchObject({ ok: true, rttMs: 12 });
    expect([...terminals.values()][0].telemetry).toMatchObject({ protocolVersion: 1, lastRttMs: 12 });
  });

  it("maps admin exec denial to 403 and revoke to 200 through the router", async () => {
    const { app, service } = createApp(resolveFromHeader());
    const { terminal } = await registerPersonalTerminal(service);
    const exec = await request(app).post(`/api/terminals/${terminal.id}/commands`).set("x-actor", "u-admin").send({ companyId: COMPANY, action: "exec" }).expect(403);
    expect(exec.body.error).toBe("personal_terminal_exec_denied");
    const revoke = await request(app).post(`/api/terminals/${terminal.id}/commands`).set("x-actor", "u-admin").send({ companyId: COMPANY, action: "revoke" }).expect(200);
    expect(revoke.body).toMatchObject({ action: "revoke", decision: { allowed: true }, terminal: { status: "revoked" } });
    expect(revoke.body.terminal).not.toHaveProperty("tokenHash");
    await request(app).post(`/api/terminals/${terminal.id}/commands`).set("x-actor", "u-admin").send({ companyId: COMPANY, action: "stop" }).expect(403);
  });

  it("returns 401 without an actor, 403 for another company, and 400 for invalid input", async () => {
    const { app, service } = createApp(resolveFromHeader());
    const { terminal } = await registerPersonalTerminal(service);
    await request(app).post(`/api/terminals/${terminal.id}/commands`).send({ companyId: COMPANY, action: "stop" }).expect(401);
    await request(app).post(`/api/terminals/${terminal.id}/commands`).set("x-actor", SALES).send({ companyId: OTHER_COMPANY, action: "stop" }).expect(403);
    await request(app).post("/api/terminals/register").set("x-actor", SALES).send({ companyId: COMPANY, kind: "personal_terminal" }).expect(400);
    await request(app).post("/api/terminals/register").set("x-actor", SALES).send({ companyId: COMPANY, kind: "personal_terminal", name: "x", tokenHash: "a".repeat(64) }).expect(400);
    await request(app).post(`/api/terminals/${terminal.id}/commands`).set("x-actor", SALES).send({ companyId: COMPANY, action: "restart" }).expect(400);
    await request(app).post(`/api/terminals/${terminal.id}/commands`).set("x-actor", SALES).send({ companyId: COMPANY, action: "exec", botContext: { botId: BOT_PERSONAL, explicitOwnerContext: true } }).expect(400);
    await request(app).post(`/api/channels/${CHANNEL_SHARED}/invoke`).set("x-actor", SALES).send({ companyId: COMPANY, targetBotId: BOT_PERSONAL }).expect(400);
  });

  it("enforces the approval gate and Sales→HR dataScope self end-to-end", async () => {
    const { app } = createApp(resolveFromHeader());
    const invoke = (body: Record<string, unknown>, user = SALES) => request(app).post(`/api/channels/${CHANNEL_SHARED}/invoke`).set("x-actor", user).send({ companyId: COMPANY, targetBotId: BOT_PERSONAL, ...body });
    const gated = await invoke({ executionTarget: "personal_terminal", capabilityKey: "inbox.triage" }).expect(403);
    expect(gated.body.error).toBe("personal_terminal_requires_owner_approval");
    const hr = await invoke({ executionTarget: "none", capabilityKey: "hr.salary.read", targetRecord: { ownerUserId: "u-hr", teamId: TEAM_HR, companyId: COMPANY } }).expect(403);
    expect(hr.body.error).toBe("data_scope_self_violation");
    const allowed = await invoke({ executionTarget: "none", capabilityKey: "hr.salary.read", targetRecord: { ownerUserId: SALES, teamId: TEAM_SALES } }).expect(200);
    expect(allowed.body).toMatchObject({ outcome: "allowed", forcedFilter: { ownerUserId: SALES }, requiresApproval: false });
    const pending = await invoke({ executionTarget: "none", capabilityKey: "hr.salary.export", targetRecord: { ownerUserId: SALES, teamId: null } }).expect(202);
    expect(pending.body).toMatchObject({ outcome: "requires_approval", requiresApproval: true });
  });

  it("allows an approved @mention and rejects unknown channels with 404", async () => {
    const { app } = createApp(resolveFromHeader(), { approvals: [{ botId: BOT_PERSONAL, channelId: CHANNEL_SHARED, botOwnerUserId: OWNER }] });
    const allowed = await request(app).post(`/api/channels/${CHANNEL_SHARED}/invoke`).set("x-actor", SALES)
      .send({ companyId: COMPANY, targetBotId: BOT_PERSONAL, executionTarget: "personal_terminal", capabilityKey: "inbox.triage" }).expect(200);
    expect(allowed.body).toMatchObject({ outcome: "allowed", bot: { id: BOT_PERSONAL, kind: "personal" }, capability: { capabilityKey: "inbox.triage", dataScope: "company" } });
    await request(app).post(`/api/channels/${randomUUID()}/invoke`).set("x-actor", SALES)
      .send({ companyId: COMPANY, targetBotId: BOT_PERSONAL, executionTarget: "none", capabilityKey: "inbox.triage" }).expect(404);
  });

  it("blocks viewer role from registering a terminal", async () => {
    const { app } = createApp(resolveFromHeader());
    const res = await request(app).post("/api/terminals/register").set("x-actor", "u-viewer")
      .send({ companyId: COMPANY, kind: "personal_terminal", name: "viewer-term" }).expect(403);
    expect(res.body.error).toBe("viewer_cannot_register_terminal");
  });

  it("registers worker_node terminals only with a teamId and enforces the caller's team scope", async () => {
    const { app } = createApp(resolveFromHeader());
    const missing = await request(app).post("/api/terminals/register").set("x-actor", SALES)
      .send({ companyId: COMPANY, kind: "worker_node", name: "gpu-node" }).expect(400);
    expect(missing.body.error).toBe("team_required");
    await request(app).post("/api/terminals/register").set("x-actor", SALES)
      .send({ companyId: COMPANY, kind: "worker_node", name: "gpu-node", teamId: TEAM_HR }).expect(403);
    const registered = await request(app).post("/api/terminals/register").set("x-actor", SALES)
      .send({ companyId: COMPANY, kind: "worker_node", name: "gpu-node", teamId: TEAM_SALES }).expect(201);
    expect(registered.body.terminal).toMatchObject({ kind: "worker_node", teamId: TEAM_SALES, ownerUserId: null });
    expect(registered.body.token).toMatch(/^pcp_term_/);
  });

  it("returns the company team directory to scoped callers only", async () => {
    const { app } = createApp(resolveFromHeader());
    await request(app).get(`/api/companies/${COMPANY}/teams`).expect(401);
    const listed = await request(app).get(`/api/companies/${COMPANY}/teams`).set("x-actor", SALES).expect(200);
    expect(listed.body).toEqual([{ id: TEAM_SALES, name: "Sales" }, { id: TEAM_HR, name: "HR" }]);
    await request(app).get(`/api/companies/${OTHER_COMPANY}/teams`).set("x-actor", SALES).expect(403);
    await request(app).get("/api/companies/not-a-uuid/teams").set("x-actor", SALES).expect(400);
  });

  it("supports snapshot, OpenBot CRUD, ping (without secret leak), inbound webhook, and approval decisions", async () => {
    const activityEvents: Array<Record<string, unknown>> = [];
    const wokenAgents: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
    const createdIssues: Array<{ title: string }> = [];
    const approvalId = randomUUID();
    const secretId = randomUUID();
    const boundAgentId = randomUUID();
    const secretVal = "super-secret-webhook-token-xyz";

    let pingMode: "ok" | "fail-secret" = "ok";
    const { app } = createApp(
      resolveFromHeader(),
      {
        pendingApprovals: [{
          id: approvalId,
          companyId: COMPANY,
          type: BOT_CHANNEL_OWNER_APPROVAL_TYPE,
          status: "pending",
          payload: { botId: BOT_PERSONAL, channelId: CHANNEL_SHARED },
          requestedByUserId: SALES,
          requestedByAgentId: null,
          decidedByUserId: null,
          decisionNote: null,
          decidedAt: null,
          createdAt: NOW,
        }],
      },
      {
        resolveSecret: async (_companyId, id) => (id === secretId ? secretVal : ""),
        fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (pingMode === "fail-secret") {
            throw new Error(`connection refused with header Bearer ${secretVal}`);
          }
          expect((init?.headers as Record<string, string>)?.authorization).toBe(`Bearer ${secretVal}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch,
        onInboundActivity: async (input) => { activityEvents.push(input); },
        wakeAgent: async (agentId, payload) => {
          wokenAgents.push({ agentId, payload });
          return { id: "run-1" };
        },
        createInboundIssue: async (_companyId, input) => {
          createdIssues.push({ title: input.title });
          return { id: "issue-1", identifier: "EB-1" };
        },
      },
    );

    // Non-admin cannot create bot
    await request(app).post(`/api/companies/${COMPANY}/bots`).set("x-actor", SALES)
      .send({ kind: "company", name: "External Bot" }).expect(403);

    // Admin creates company OpenBot with webhook & secret
    const created = await request(app).post(`/api/companies/${COMPANY}/bots`).set("x-actor", "u-admin")
      .send({
        kind: "company",
        name: "OpenBot Alpha",
        agentId: boundAgentId,
        webhookUrl: "https://bot.example.com/hook",
        tokenSecretId: secretId,
        capabilities: [{ capabilityKey: "alerts.send", callableBy: "company", dataScope: "company" }],
      }).expect(201);
    expect(created.body.inboundToken).toMatch(/^pcp_bot_[0-9a-f]{64}$/);
    expect(created.body.bot).toMatchObject({ kind: "company", name: "OpenBot Alpha", hasInboundToken: true });
    expect(created.body.bot).not.toHaveProperty("inboundTokenHash");
    const botId = created.body.bot.id as string;
    const inboundToken = created.body.inboundToken as string;

    // Snapshot lists bots, terminals, channels, pendingApprovals without hashes
    const snap = await request(app).get(`/api/companies/${COMPANY}/snapshot`).set("x-actor", SALES).expect(200);
    expect(snap.body.bots.some((b: { id: string }) => b.id === botId)).toBe(true);
    expect(snap.body.bots.every((b: Record<string, unknown>) => !("inboundTokenHash" in b))).toBe(true);
    expect(snap.body.channels).toHaveLength(1);
    expect(snap.body.pendingApprovals).toHaveLength(1);

    // Ping succeeds and updates lastPingStatus
    const pingOk = await request(app).post(`/api/companies/${COMPANY}/bots/${botId}/ping`).set("x-actor", "u-admin").expect(200);
    expect(pingOk.body).toMatchObject({ ok: true, statusCode: 200 });
    expect(typeof pingOk.body.latencyMs).toBe("number");

    // Ping error redacts secret value
    pingMode = "fail-secret";
    const pingErr = await request(app).post(`/api/companies/${COMPANY}/bots/${botId}/ping`).set("x-actor", "u-admin").expect(200);
    expect(pingErr.body.ok).toBe(false);
    expect(pingErr.body.error).not.toContain(secretVal);
    expect(pingErr.body.error).toContain("***REDACTED***");

    // Reject non-http/https webhook URL on PATCH
    await request(app).patch(`/api/companies/${COMPANY}/bots/${botId}`).set("x-actor", "u-admin")
      .send({ webhookUrl: "file:///etc/passwd" }).expect(400);

    // Inbound webhook: invalid token -> 401, valid token -> 200 (creates issue, wakes agent, logs activity)
    await request(app).post(`/api/bots/${botId}/inbound`).send({ title: "x" }).expect(401);
    await request(app).post(`/api/bots/${botId}/inbound`).set("Authorization", "Bearer pcp_bot_wrong").send({ title: "x" }).expect(401);
    const inboundRes = await request(app).post(`/api/bots/${botId}/inbound`)
      .set("Authorization", `Bearer ${inboundToken}`)
      .send({ event: "alert", title: "Disk 90%", message: "Check node 1" }).expect(200);
    expect(inboundRes.body).toMatchObject({ ok: true, botId, issueId: "issue-1", wokenAgentId: boundAgentId, runId: "run-1" });
    expect(createdIssues).toEqual([{ title: "Disk 90%" }]);
    expect(wokenAgents).toHaveLength(1);
    expect(activityEvents).toHaveLength(1);

    // Revoke bot via PATCH -> inbound returns 403
    const patched = await request(app).patch(`/api/companies/${COMPANY}/bots/${botId}`).set("x-actor", "u-admin")
      .send({ status: "revoked" }).expect(200);
    expect(patched.body.bot.status).toBe("revoked");
    const revokedInbound = await request(app).post(`/api/bots/${botId}/inbound`)
      .set("Authorization", `Bearer ${inboundToken}`)
      .send({ message: "after revoke" }).expect(403);
    expect(revokedInbound.body.error).toBe("bot_revoked");

    // Approval decision
    const decided = await request(app).post(`/api/companies/${COMPANY}/approvals/${approvalId}/decision`)
      .set("x-actor", "u-admin").send({ decision: "approve", note: "lgtm" }).expect(200);
    expect(decided.body.approval).toMatchObject({ id: approvalId, status: "approved", decisionNote: "lgtm" });

    // Delete bot
    await request(app).delete(`/api/companies/${COMPANY}/bots/${botId}`).set("x-actor", "u-admin").expect(200);
    await request(app).delete(`/api/companies/${COMPANY}/bots/${botId}`).set("x-actor", "u-admin").expect(404);
  });

  it("exposes /compatibility, persists heartbeat telemetry + 20-sample health ring, and records bot ping healthHistory", async () => {
    let pingCount = 0;
    const { app } = createApp(resolveFromHeader(), {}, {
      fetchFn: (async () => {
        pingCount += 1;
        return new Response(JSON.stringify({ ok: true }), { status: pingCount % 2 === 0 ? 503 : 200 });
      }) as typeof fetch,
    });

    // Compatibility endpoint (public)
    const compat = await request(app).get("/api/compatibility").expect(200);
    expect(compat.body).toEqual({
      protocol: { minimum: 1, maximum: 2 },
      capabilities: [
        "terminal.telemetry.v1",
        "bot.capabilities_matrix.v1",
        "channel.invoke_preview.v1",
        "bot.audit.v1",
      ],
    });

    // Register terminal and send 22 heartbeats with telemetry -> ring caps at 20
    const reg = await request(app).post("/api/terminals/register").set("x-actor", OWNER)
      .send({ companyId: COMPANY, kind: "personal_terminal", name: "telemetry-laptop" }).expect(201);
    const terminalId = reg.body.terminal.id as string;
    const token = reg.body.token as string;

    // Reject unknown telemetry fields strictly
    await request(app).post(`/api/terminals/${terminalId}/heartbeat`)
      .set("Authorization", `Bearer ${token}`)
      .send({ telemetry: { os: "darwin", extraUnknown: true } })
      .expect(400);

    for (let i = 1; i <= 22; i += 1) {
      const beat = await request(app).post(`/api/terminals/${terminalId}/heartbeat`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          telemetry: {
            os: "darwin",
            arch: "arm64",
            daemonVersion: "0.2.0",
            protocolVersion: 2,
            uptimeSecs: i * 10,
            cpuPct: 12.5,
            memRssMb: 48.2,
            activeChildren: 2,
            lastRttMs: i,
          },
        }).expect(200);
      expect(beat.body.terminal.telemetry).toMatchObject({ os: "darwin", arch: "arm64", lastRttMs: i });
      expect(beat.body.terminal.healthHistory).toHaveLength(Math.min(i, HEALTH_HISTORY_MAX));
    }

    const snap = await request(app).get(`/api/companies/${COMPANY}/snapshot`).set("x-actor", SALES).expect(200);
    const snapTerminal = snap.body.terminals.find((t: { id: string }) => t.id === terminalId);
    expect(snapTerminal.telemetry).toMatchObject({ daemonVersion: "0.2.0", protocolVersion: 2, lastRttMs: 22 });
    expect(snapTerminal.healthHistory).toHaveLength(20);
    expect(snapTerminal.healthHistory[0].rttMs).toBe(3);
    expect(snapTerminal.healthHistory[19].rttMs).toBe(22);

    // Bot ping appends to bots.healthHistory (capped at 20)
    const botRes = await request(app).post(`/api/companies/${COMPANY}/bots`).set("x-actor", "u-admin")
      .send({ kind: "company", name: "Ping Ring Bot", webhookUrl: "https://bot.example.com/ping" }).expect(201);
    const botId = botRes.body.bot.id as string;
    for (let i = 0; i < 22; i += 1) {
      await request(app).post(`/api/companies/${COMPANY}/bots/${botId}/ping`).set("x-actor", "u-admin").expect(200);
    }
    const snap2 = await request(app).get(`/api/companies/${COMPANY}/snapshot`).set("x-actor", SALES).expect(200);
    const snapBot = snap2.body.bots.find((b: { id: string }) => b.id === botId);
    expect(snapBot.healthHistory).toHaveLength(20);
    expect(snapBot.healthHistory[19]).toMatchObject({ ok: false, statusCode: 503 });
    expect(snapBot.healthHistory[18]).toMatchObject({ ok: true, statusCode: 200 });
  });

  it("supports PATCH /bots/:botId/capabilities, POST /channels/:channelId/invoke?dryRun=true, and GET /audit", async () => {
    const rawTermToken = "pcp_term_" + "a".repeat(64);
    const rawBotToken = "pcp_bot_" + "b".repeat(64);
    const { app } = createApp(resolveFromHeader(), {
      auditEvents: [
        {
          id: randomUUID(),
          companyId: COMPANY,
          actorType: "system",
          actorId: `bot:${BOT_PERSONAL}`,
          action: "enterprise_bot.inbound",
          entityType: "bot",
          entityId: BOT_PERSONAL,
          agentId: null,
          details: {
            event: "alert",
            token: rawBotToken,
            note: `leaked ${rawTermToken} in text`,
          },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          companyId: OTHER_COMPANY,
          actorType: "system",
          actorId: "bot:other",
          action: "enterprise_bot.inbound",
          entityType: "bot",
          entityId: randomUUID(),
          agentId: null,
          details: { event: "other" },
          createdAt: NOW,
        },
      ],
    });

    // PATCH capabilities: non-admin rejected (403)
    await request(app)
      .patch(`/api/companies/${COMPANY}/bots/${BOT_PERSONAL}/capabilities`)
      .set("x-actor", SALES)
      .send({ capabilities: [{ capabilityKey: "ops.run", callableBy: "team", dataScope: "team", requiresApproval: true }] })
      .expect(403);

    // PATCH capabilities: duplicate key rejected (400)
    await request(app)
      .patch(`/api/companies/${COMPANY}/bots/${BOT_PERSONAL}/capabilities`)
      .set("x-actor", "u-admin")
      .send({
        capabilities: [
          { capabilityKey: "ops.run", callableBy: "team", dataScope: "team", requiresApproval: false },
          { capabilityKey: "ops.run", callableBy: "company", dataScope: "company", requiresApproval: true },
        ],
      })
      .expect(400);

    // PATCH capabilities: admin batch replace succeeds
    const updatedCaps = await request(app)
      .patch(`/api/companies/${COMPANY}/bots/${BOT_PERSONAL}/capabilities`)
      .set("x-actor", "u-admin")
      .send({
        capabilities: [
          { capabilityKey: "inbox.triage", callableBy: "company", dataScope: "company", requiresApproval: false },
          { capabilityKey: "hr.salary.read", callableBy: "company", dataScope: "self", requiresApproval: false },
          { capabilityKey: "hr.salary.export", callableBy: "company", dataScope: "self", requiresApproval: true },
        ],
      })
      .expect(200);
    expect(updatedCaps.body.capabilities).toHaveLength(3);
    expect(updatedCaps.body.bot).not.toHaveProperty("inboundTokenHash");

    // dryRun=true: denied personal_terminal without approval -> 200 with dryRun: true
    const dryDenied = await request(app)
      .post(`/api/channels/${CHANNEL_SHARED}/invoke?dryRun=true`)
      .set("x-actor", SALES)
      .send({
        companyId: COMPANY,
        targetBotId: BOT_PERSONAL,
        executionTarget: "personal_terminal",
        capabilityKey: "inbox.triage",
      })
      .expect(200);
    expect(dryDenied.body).toEqual({
      dryRun: true,
      outcome: "denied",
      reason: "personal_terminal_requires_owner_approval",
      forcedFilter: null,
      requiresApproval: true,
    });

    // dryRun=true: dataScope self violation -> 200 with dryRun: true, outcome: denied
    const dryScopeDenied = await request(app)
      .post(`/api/channels/${CHANNEL_SHARED}/invoke?dryRun=true`)
      .set("x-actor", SALES)
      .send({
        companyId: COMPANY,
        targetBotId: BOT_PERSONAL,
        executionTarget: "none",
        capabilityKey: "hr.salary.read",
        targetRecord: { ownerUserId: "u-hr", teamId: TEAM_HR, companyId: COMPANY },
      })
      .expect(200);
    expect(dryScopeDenied.body).toEqual({
      dryRun: true,
      outcome: "denied",
      reason: "data_scope_self_violation",
      forcedFilter: null,
      requiresApproval: false,
    });

    // dryRun=true: allowed
    const dryAllowed = await request(app)
      .post(`/api/channels/${CHANNEL_SHARED}/invoke?dryRun=true`)
      .set("x-actor", SALES)
      .send({
        companyId: COMPANY,
        targetBotId: BOT_PERSONAL,
        executionTarget: "none",
        capabilityKey: "hr.salary.read",
        targetRecord: { ownerUserId: SALES, teamId: TEAM_SALES },
      })
      .expect(200);
    expect(dryAllowed.body).toEqual({
      dryRun: true,
      outcome: "allowed",
      reason: "allowed",
      forcedFilter: { ownerUserId: SALES },
      requiresApproval: false,
    });

    // dryRun=true: requires_approval
    const dryPending = await request(app)
      .post(`/api/channels/${CHANNEL_SHARED}/invoke?dryRun=true`)
      .set("x-actor", SALES)
      .send({
        companyId: COMPANY,
        targetBotId: BOT_PERSONAL,
        executionTarget: "none",
        capabilityKey: "hr.salary.export",
        targetRecord: { ownerUserId: SALES, teamId: null },
      })
      .expect(200);
    expect(dryPending.body).toEqual({
      dryRun: true,
      outcome: "requires_approval",
      reason: "requires_approval",
      forcedFilter: { ownerUserId: SALES },
      requiresApproval: true,
    });

    // GET /audit: company-scoped and redacts raw tokens
    const auditRes = await request(app)
      .get(`/api/companies/${COMPANY}/audit?limit=50`)
      .set("x-actor", SALES)
      .expect(200);
    expect(auditRes.body.events).toHaveLength(1);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawBotToken);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawTermToken);
    expect(auditRes.body.events[0].details).toEqual({
      event: "alert",
      token: "[REDACTED]",
      note: "leaked [REDACTED] in text",
    });

    // Invalid limit rejected
    await request(app)
      .get(`/api/companies/${COMPANY}/audit?limit=0`)
      .set("x-actor", SALES)
      .expect(400);
  });
});

describe("sanitizeAuditDetails raw token redaction", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";

  it("redacts bare legacy pcp_<32-hex> tokens in strings, arrays and nested objects", () => {
    expect(sanitizeAuditDetails({
      note: `leaked pcp_${HEX32} in text`,
      list: [`pcp_${HEX32.toUpperCase()}`, "pcp_abcdefghijklmnop"],
      nested: { deep: [`token=pcp_${"a".repeat(64)};end`] },
    })).toEqual({
      note: "leaked [REDACTED] in text",
      list: ["[REDACTED]", "[REDACTED]"],
      nested: { deep: ["token=[REDACTED];end"] },
    });
  });

  it("leaves short pcp_ identifiers untouched", () => {
    const details = {
      key: "pcp_id",
      env: "pcp_test",
      bare: "pcp_",
      short: "pcp_123456789012345",
      text: "prefix pcp_id and pcp_test remain",
    };
    expect(sanitizeAuditDetails(details)).toEqual(details);
  });

  it("still redacts short prefixed pcp_term_/pcp_bot_ values and sensitive keys", () => {
    expect(sanitizeAuditDetails({ a: "pcp_bot_x", b: "pcp_term_y", token: `pcp_${HEX32}` })).toEqual({
      a: "[REDACTED]",
      b: "[REDACTED]",
      token: "[REDACTED]",
    });
    expect(sanitizeAuditDetails(null)).toBeNull();
  });
});
