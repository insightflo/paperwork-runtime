import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import { errorHandler } from "../middleware/index.js";
import {
  createAuthRateLimiter,
  resetAuthRateLimitBuckets,
} from "../middleware/auth-rate-limit.js";
import { assertCompanyAdminAccess } from "../routes/authz.js";
import { accessService } from "../services/access.js";
import { accessRoutes } from "../routes/access.js";
import { authAccountRoutes } from "../routes/auth-account.js";
import { HttpError } from "../errors.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("Stage 18 Auth Rate Limiter", () => {
  beforeEach(() => {
    resetAuthRateLimitBuckets();
  });

  it("allows requests within window and returns 429 + Retry-After when exceeded", async () => {
    const app = express();
    app.use(express.json());
    app.post(
      "/api/auth/sign-in",
      createAuthRateLimiter({
        bucketName: "test-sign-in",
        windowMs: 60_000,
        maxRequests: 2,
      }),
      (_req, res) => res.json({ ok: true }),
    );

    const first = await request(app)
      .post("/api/auth/sign-in")
      .set("x-forwarded-for", "203.0.113.10")
      .send({ email: "Alice@Example.com" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/auth/sign-in")
      .set("x-forwarded-for", "203.0.113.10")
      .send({ email: "  alice@example.com  " });
    expect(second.status).toBe(200);

    const blocked = await request(app)
      .post("/api/auth/sign-in")
      .set("x-forwarded-for", "203.0.113.10")
      .send({ email: "alice@example.com" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(blocked.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // Different email from same IP gets its own bucket
    const otherEmail = await request(app)
      .post("/api/auth/sign-in")
      .set("x-forwarded-for", "203.0.113.10")
      .send({ email: "bob@example.com" });
    expect(otherEmail.status).toBe(200);
  });
});

describe("Stage 18 Better Auth Fail-Closed Secret & Session Config", () => {
  it("fails closed when deploymentMode is authenticated and no auth secret is configured", () => {
    const prevBetter = process.env.BETTER_AUTH_SECRET;
    const prevJwt = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    try {
      const config = {
        deploymentMode: "authenticated",
        allowedHostnames: [],
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://auth.example.com",
        authDisableSignUp: false,
        authSocialProviders: [],
      } as unknown as Config;

      expect(() => createBetterAuthInstance({} as Db, config)).toThrow(
        /BETTER_AUTH_SECRET or PAPERCLIP_AGENT_JWT_SECRET/,
      );
    } finally {
      if (prevBetter !== undefined) process.env.BETTER_AUTH_SECRET = prevBetter;
      if (prevJwt !== undefined) process.env.PAPERCLIP_AGENT_JWT_SECRET = prevJwt;
    }
  });

  it("preserves local_trusted fallback and sets minPasswordLength + session TTL", () => {
    const prevBetter = process.env.BETTER_AUTH_SECRET;
    const prevJwt = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    try {
      const config = {
        deploymentMode: "local_trusted",
        allowedHostnames: [],
        authBaseUrlMode: "auto",
        authDisableSignUp: false,
        authSocialProviders: [],
      } as unknown as Config;

      const auth = createBetterAuthInstance({} as Db, config);
      expect(auth.options.emailAndPassword?.minPasswordLength).toBe(10);
      expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24 * 7);
      expect(auth.options.session?.updateAge).toBe(60 * 60 * 24);
    } finally {
      if (prevBetter !== undefined) process.env.BETTER_AUTH_SECRET = prevBetter;
      if (prevJwt !== undefined) process.env.PAPERCLIP_AGENT_JWT_SECRET = prevJwt;
    }
  });
});

describe("Stage 18 RBAC Guard (assertCompanyAdminAccess)", () => {
  function makeReq(actor: express.Request["actor"]): express.Request {
    return { actor } as express.Request;
  }

  it("returns 403 for viewer without users:manage_permissions", async () => {
    const checker = {
      getMembership: vi.fn().mockResolvedValue({ status: "active", membershipRole: "viewer" }),
      canUser: vi.fn().mockResolvedValue(false),
    };
    const req = makeReq({
      type: "board",
      userId: "viewer-1",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
      source: "session",
    });

    await expect(assertCompanyAdminAccess(checker, req, COMPANY_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("allows admin and owner membership roles", async () => {
    for (const role of ["admin", "owner"] as const) {
      const checker = {
        getMembership: vi.fn().mockResolvedValue({ status: "active", membershipRole: role }),
        canUser: vi.fn().mockResolvedValue(false),
      };
      const req = makeReq({
        type: "board",
        userId: `user-${role}`,
        companyIds: [COMPANY_ID],
        isInstanceAdmin: false,
        source: "session",
      });
      await expect(assertCompanyAdminAccess(checker, req, COMPANY_ID)).resolves.toBeUndefined();
    }
  });

  it("allows local_implicit board actor without DB queries", async () => {
    const checker = {
      getMembership: vi.fn(),
      canUser: vi.fn(),
    };
    const req = makeReq({
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    });
    await expect(assertCompanyAdminAccess(checker, req, COMPANY_ID)).resolves.toBeUndefined();
    expect(checker.getMembership).not.toHaveBeenCalled();
  });
});

describe("Stage 18 Lockout Guards (409 Conflict)", () => {
  function createMockDbForSelectQueue(results: unknown[][]) {
    let idx = 0;
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(results[idx++] ?? [])),
      })),
    }));
    const del = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([])),
      })),
    }));
    return { select, delete: del } as unknown as Db;
  }

  it("blocks demoting or suspending the last active company owner with 409", async () => {
    const ownerRow = {
      id: "member-owner-1",
      companyId: COMPANY_ID,
      principalType: "user",
      principalId: "user-owner-1",
      status: "active",
      membershipRole: "owner",
    };
    const db = createMockDbForSelectQueue([[ownerRow], [{ id: "member-owner-1" }]]);
    const svc = accessService(db);

    let caught: unknown;
    try {
      await svc.updateCompanyMember(COMPANY_ID, "member-owner-1", { membershipRole: "admin" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({ status: 409 });
  });

  it("blocks removing the last active company owner with 409", async () => {
    const ownerRow = {
      id: "member-owner-1",
      companyId: COMPANY_ID,
      principalType: "user",
      principalId: "user-owner-1",
      status: "active",
      membershipRole: "owner",
    };
    const db = createMockDbForSelectQueue([[ownerRow], [{ id: "member-owner-1" }]]);
    const svc = accessService(db);

    await expect(svc.removeCompanyMember(COMPANY_ID, "member-owner-1")).rejects.toMatchObject({
      status: 409,
    });
  });

  it("blocks demoting the last instance_admin with 409", async () => {
    const db = createMockDbForSelectQueue([
      [{ id: "role-1", userId: "admin-1", role: "instance_admin" }],
    ]);
    const svc = accessService(db);

    await expect(svc.demoteInstanceAdmin("admin-1")).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("Stage 18 GET /companies/:companyId/invites omits tokenHash", () => {
  it("lists company invites without exposing tokenHash", async () => {
    const inviteRow = {
      id: "inv-1",
      companyId: COMPANY_ID,
      inviteType: "company_join",
      tokenHash: "deadbeef-secret-hash-must-never-leak",
      allowedJoinTypes: "human",
      defaultsPayload: null,
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      invitedByUserId: "local-board",
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-11-26T00:00:00.000Z"),
      updatedAt: new Date("2026-11-26T00:00:00.000Z"),
    };

    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => Promise.resolve([inviteRow])),
          })),
        })),
      })),
    } as unknown as Db;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/invites`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("inv-1");
    expect(res.body[0].tokenHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("deadbeef-secret-hash");
  });
});

describe("Stage 18 Active Session Management Routes", () => {
  it("lists active sessions with isCurrent and revokes owned/other sessions", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600_000);
    const selectRows = [
      {
        id: "sess-current",
        createdAt: now,
        expiresAt: future,
        ipAddress: "127.0.0.1",
        userAgent: "Chrome",
      },
      {
        id: "sess-other",
        createdAt: now,
        expiresAt: future,
        ipAddress: "10.0.0.2",
        userAgent: "Safari",
      },
    ];

    let deleteReturning: Array<{ id: string }> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => Promise.resolve(selectRows)),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve(deleteReturning)),
        })),
      })),
    } as unknown as Db;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        sessionId: "sess-current",
        email: "user@example.com",
        name: "User One",
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", authAccountRoutes(db));
    app.use(errorHandler);

    const listRes = await request(app).get("/api/auth/sessions");
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(2);
    expect(listRes.body[0].isCurrent).toBe(true);
    expect(listRes.body[1].isCurrent).toBe(false);

    deleteReturning = [];
    const notOwnedRes = await request(app).delete("/api/auth/sessions/sess-stranger");
    expect(notOwnedRes.status).toBe(404);

    deleteReturning = [{ id: "sess-other" }];
    const revokeOthersRes = await request(app).post("/api/auth/sessions/revoke-others");
    expect(revokeOthersRes.status).toBe(200);
    expect(revokeOthersRes.body).toEqual({ ok: true, revokedCount: 1 });
  });
});
