import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import { createApp } from "../app.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const COMPANY = "00000000-0000-4000-8000-00000000b401";
const OTHER_COMPANY = "00000000-0000-4000-8000-00000000b402";
const USER = "enterprise-bot-user";

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
    await db.insert(companyMemberships).values({
      companyId: COMPANY,
      principalType: "user",
      principalId: USER,
      status: "active",
      membershipRole: "member",
    });
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS client_terminals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE cascade,
        kind text NOT NULL,
        name text NOT NULL,
        owner_user_id text,
        team_id uuid,
        bot_id uuid,
        token_hash text NOT NULL,
        transport text NOT NULL DEFAULT 'outbound_wss',
        status text NOT NULL DEFAULT 'offline',
        last_heartbeat_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
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
});
