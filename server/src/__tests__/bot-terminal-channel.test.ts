import { createHash, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { createEnterpriseBotsRouter } from "../routes/enterprise-bots.js";
import {
  createBotTerminalChannelService, createTerminalToken, hashTerminalToken,
  type BotActor, type BotTerminalRecord, type EnterpriseBotStore, type NewBotTerminal,
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
interface MemoryStoreSeed { approvals?: Array<{ botId: string; channelId: string; botOwnerUserId: string }> }

function createMemoryStore(seed: MemoryStoreSeed = {}) {
  const terminals = new Map<string, BotTerminalRecord>();
  const bots = [
    { id: BOT_PERSONAL, companyId: COMPANY, kind: "personal" as const, ownerUserId: OWNER, teamId: null, callableBy: "company" as const, status: "active" },
    { id: BOT_TEAM_HR, companyId: COMPANY, kind: "team" as const, ownerUserId: null, teamId: TEAM_HR, callableBy: "company" as const, status: "active" },
  ];
  const capabilities = [
    { botId: BOT_PERSONAL, capabilityKey: "inbox.triage", callableBy: "company" as const, dataScope: "company" as const, requiresApproval: false },
    { botId: BOT_PERSONAL, capabilityKey: "hr.salary.read", callableBy: "company" as const, dataScope: "self" as const, requiresApproval: false },
    { botId: BOT_PERSONAL, capabilityKey: "hr.salary.export", callableBy: "company" as const, dataScope: "self" as const, requiresApproval: true },
    { botId: BOT_TEAM_HR, capabilityKey: "hr.records.read", callableBy: "company" as const, dataScope: "team" as const, requiresApproval: false },
  ];
  const store: EnterpriseBotStore = {
    async createTerminal(input: NewBotTerminal) {
      const record: BotTerminalRecord = { ...input, id: randomUUID(), status: "offline", lastSeenAt: null, revokedAt: null };
      terminals.set(record.id, record);
      return { ...record };
    },
    getTerminal: async (companyId, id) => { const t = terminals.get(id); return t && t.companyId === companyId ? { ...t } : null; },
    getTerminalById: async (id) => { const t = terminals.get(id); return t ? { ...t } : null; },
    async markTerminalSeen(id, seenAt) { const t = terminals.get(id); if (t) Object.assign(t, { status: "online", lastSeenAt: seenAt }); },
    async revokeTerminal(id, revokedAt) { const t = terminals.get(id); if (t) Object.assign(t, { status: "revoked", revokedAt }); },
    getBot: async (companyId, id) => { const b = bots.find((bot) => bot.id === id); return b && b.companyId === companyId ? b : null; },
    getBotCapability: async (botId, capabilityKey) => capabilities.find((c) => c.botId === botId && c.capabilityKey === capabilityKey) ?? null,
    getChannel: async (companyId, id) => id === CHANNEL_SHARED && companyId === COMPANY ? { id, companyId, kind: "shared", teamId: null } : null,
    listChannelMemberIds: async () => [OWNER, SALES, "u-hr", BOT_PERSONAL, BOT_TEAM_HR],
    hasChannelOwnerApproval: async (_companyId, botId, botOwnerUserId, channelId) =>
      (seed.approvals ?? []).some((a) => a.botId === botId && a.channelId === channelId && a.botOwnerUserId === botOwnerUserId),
  };
  return { store, terminals };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2026-01-15T10:00:00.000Z");
function setup(seed: MemoryStoreSeed = {}) {
  const memory = createMemoryStore(seed);
  return { ...memory, service: createBotTerminalChannelService(memory.store, { now: () => NOW }) };
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

function createApp(resolveActor: Parameters<typeof createEnterpriseBotsRouter>[1], seed: MemoryStoreSeed = {}) {
  const { service, terminals } = setup(seed);
  const app = express();
  app.use(express.json());
  app.use("/api", createEnterpriseBotsRouter(service, resolveActor));
  app.use(errorHandler);
  return { app, service, terminals };
}

// Router tests authenticate by header; admins get the admin role so the exec-denied path is exercised.
const resolveFromHeader = () => (req: Request, _companyId: string) => {
  const user = String(req.headers["x-actor"] ?? "");
  return user ? actor({ userId: user, role: user === "u-admin" ? "admin" : "member" }) : null;
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
});
