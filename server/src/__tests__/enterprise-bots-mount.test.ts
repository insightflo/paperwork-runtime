import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import { createApp } from "../app.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const COMPANY = "00000000-0000-4000-8000-00000000b401";
const OTHER_COMPANY = "00000000-0000-4000-8000-00000000b402";
const USER = "enterprise-bot-user";
const ADMIN_USER = "enterprise-bot-admin";
const VIEWER_USER = "enterprise-bot-viewer";

describe("enterprise bots app mount", () => {
  let db!: ReturnType<typeof createDb>;
  let database!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let app!: Awaited<ReturnType<typeof createApp>>;
  let localPluginDir = "";
  let sessionUserId: string | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("enterprise-bots-mount-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: COMPANY, name: "Enterprise Bots", issuePrefix: "EB1" });
    await db.insert(companies).values({ id: OTHER_COMPANY, name: "Other Company", issuePrefix: "EB2" });
    await db.insert(companyMemberships).values([
      {
        companyId: COMPANY,
        principalType: "user",
        principalId: USER,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId: COMPANY,
        principalType: "user",
        principalId: ADMIN_USER,
        status: "active",
        membershipRole: "admin",
      },
      {
        companyId: COMPANY,
        principalType: "user",
        principalId: VIEWER_USER,
        status: "active",
        membershipRole: "viewer",
      },
    ]);
    localPluginDir = await mkdtemp(path.join(tmpdir(), "enterprise-bots-plugins-"));
    app = await createApp(db, {
      uiMode: "none",
      serverPort: 3100,
      storageService: {} as never,
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
      localPluginDir,
      resolveSession: async () => sessionUserId
        ? { session: { id: "session-1", userId: sessionUserId }, user: { id: sessionUserId, email: "bot@example.com", name: "Bot User" } }
        : null,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.runtimeShutdown.dispose();
    if (localPluginDir) await rm(localPluginDir, { recursive: true, force: true });
    if (database) await database.cleanup();
  }, 120_000);

  function post(pathname: string) {
    return request(app).post(pathname).set("Origin", "http://localhost:3100");
  }

  it("fails closed with 401 across operator endpoints when no user session is present", async () => {
    sessionUserId = null;
    const terminalId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const cases: Array<{ pathname: string; body: Record<string, unknown> }> = [
      {
        pathname: "/api/enterprise-bots/terminals/register",
        body: { companyId: COMPANY, kind: "personal_terminal", name: "unauthenticated-terminal" },
      },
      {
        pathname: `/api/enterprise-bots/terminals/${terminalId}/commands`,
        body: { companyId: COMPANY, action: "stop" },
      },
      {
        pathname: `/api/enterprise-bots/channels/${channelId}/invoke`,
        body: {
          companyId: COMPANY,
          targetBotId: crypto.randomUUID(),
          executionTarget: "none",
          capabilityKey: "inbox.triage",
        },
      },
    ];
    for (const testCase of cases) {
      const res = await post(testCase.pathname).send(testCase.body);
      expect(res.status).toBe(401);
    }
    for (const { pathname } of cases) {
      const malformed = await post(pathname).send({});
      expect(malformed.status).toBe(401);
    }
  });

  it("registers, heartbeats without a user session, and revokes through the mounted route", async () => {
    sessionUserId = USER;
    const registered = await post("/api/enterprise-bots/terminals/register").send({
      companyId: COMPANY,
      kind: "personal_terminal",
      name: "operator-terminal",
    }).expect(201);
    expect(registered.body.token).toMatch(/^pcp_term_/);
    expect(registered.body.terminal).not.toHaveProperty("tokenHash");
    const terminalId = registered.body.terminal.id as string;

    sessionUserId = null;
    const missingToken = await request(app)
      .post(`/api/enterprise-bots/terminals/${terminalId}/heartbeat`)
      .expect(401);
    expect(missingToken.body.error).toBe("terminal_token_rejected");
    const wrongToken = await request(app)
      .post(`/api/enterprise-bots/terminals/${terminalId}/heartbeat`)
      .set("Authorization", "Bearer not-the-terminal-token")
      .expect(401);
    expect(wrongToken.body.error).toBe("terminal_token_rejected");

    const heartbeat = await request(app)
      .post(`/api/enterprise-bots/terminals/${terminalId}/heartbeat`)
      .set("Authorization", `Bearer ${registered.body.token}`)
      .expect(200);
    expect(heartbeat.body.terminal).toMatchObject({ id: terminalId, status: "online" });
    expect(heartbeat.body.terminal).not.toHaveProperty("tokenHash");

    sessionUserId = USER;
    const revoked = await post(`/api/enterprise-bots/terminals/${terminalId}/commands`).send({
      companyId: COMPANY,
      action: "revoke",
    }).expect(200);
    expect(revoked.body).toMatchObject({
      action: "revoke",
      decision: { allowed: true },
      terminal: { id: terminalId, status: "revoked" },
    });
    expect(revoked.body.terminal).not.toHaveProperty("tokenHash");
  }, 30_000);

  it("returns 403 for an authenticated user outside the requested company", async () => {
    sessionUserId = USER;
    const res = await post("/api/enterprise-bots/terminals/register").send({
      companyId: OTHER_COMPANY,
      kind: "personal_terminal",
      name: "cross-company-terminal",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("company_scope_denied");
  });

  it("rejects spoofed botContext as invalid input instead of trusting it", async () => {
    sessionUserId = USER;
    const res = await post(`/api/enterprise-bots/terminals/${crypto.randomUUID()}/commands`).send({
      companyId: COMPANY,
      action: "exec",
      botContext: { botId: crypto.randomUUID(), explicitOwnerContext: true, botApproved: true },
    });
    expect(res.status).toBe(400);
  });

  it("blocks viewer role from registering terminals", async () => {
    sessionUserId = VIEWER_USER;
    const res = await post("/api/enterprise-bots/terminals/register").send({
      companyId: COMPANY,
      kind: "personal_terminal",
      name: "viewer-blocked",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("viewer_cannot_register_terminal");
  });

  it("supports OpenBot snapshot, CRUD, ping, and token-authenticated inbound webhook against Postgres", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pong: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      // Member cannot create bots
      sessionUserId = USER;
      await post(`/api/enterprise-bots/companies/${COMPANY}/bots`).send({
        kind: "company",
        name: "Unauthorized Bot",
      }).expect(403);

      // Admin creates a company OpenBot
      sessionUserId = ADMIN_USER;
      const created = await post(`/api/enterprise-bots/companies/${COMPANY}/bots`).send({
        kind: "company",
        name: "Mounted OpenBot",
        webhookUrl: `http://127.0.0.1:${port}/webhook`,
        capabilities: [{ capabilityKey: "ops.ping", callableBy: "company", dataScope: "company" }],
      }).expect(201);
      expect(created.body.inboundToken).toMatch(/^pcp_bot_/);
      expect(created.body.bot).toMatchObject({ kind: "company", name: "Mounted OpenBot", hasInboundToken: true });
      expect(created.body.bot).not.toHaveProperty("inboundTokenHash");
      const botId = created.body.bot.id as string;
      const inboundToken = created.body.inboundToken as string;

      // Snapshot returns bot & terminals without token hashes
      const snap = await request(app)
        .get(`/api/enterprise-bots/companies/${COMPANY}/snapshot`)
        .set("Origin", "http://localhost:3100")
        .expect(200);
      expect(snap.body.bots.some((b: { id: string }) => b.id === botId)).toBe(true);
      expect(snap.body.bots.every((b: Record<string, unknown>) => !("inboundTokenHash" in b))).toBe(true);

      // Ping hits local test server and persists lastPingStatus = ok
      const ping = await post(`/api/enterprise-bots/companies/${COMPANY}/bots/${botId}/ping`).expect(200);
      expect(ping.body).toMatchObject({ ok: true, statusCode: 200 });

      // Inbound works without a board session (Bearer pcp_bot_...)
      sessionUserId = null;
      await request(app)
        .post(`/api/enterprise-bots/bots/${botId}/inbound`)
        .set("Authorization", "Bearer pcp_bot_invalid")
        .send({ title: "Should fail" })
        .expect(401);

      const inbound = await request(app)
        .post(`/api/enterprise-bots/bots/${botId}/inbound`)
        .set("Authorization", `Bearer ${inboundToken}`)
        .send({ event: "webhook", title: "Inbound Alert", message: "All systems nominal" })
        .expect(200);
      expect(inbound.body).toMatchObject({ ok: true, botId });
      expect(typeof inbound.body.issueId).toBe("string");

      // Revoke bot -> inbound returns 403
      sessionUserId = ADMIN_USER;
      await request(app)
        .patch(`/api/enterprise-bots/companies/${COMPANY}/bots/${botId}`)
        .set("Origin", "http://localhost:3100")
        .send({ status: "revoked" })
        .expect(200);

      sessionUserId = null;
      const revoked = await request(app)
        .post(`/api/enterprise-bots/bots/${botId}/inbound`)
        .set("Authorization", `Bearer ${inboundToken}`)
        .send({ message: "Should be forbidden" })
        .expect(403);
      expect(revoked.body.error).toBe("bot_revoked");

      // Delete bot
      sessionUserId = ADMIN_USER;
      await request(app)
        .delete(`/api/enterprise-bots/companies/${COMPANY}/bots/${botId}`)
        .set("Origin", "http://localhost:3100")
        .expect(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
