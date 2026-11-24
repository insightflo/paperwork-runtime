import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";

const mocks = vi.hoisted(() => ({
  routeQuotaWithEngine: vi.fn(),
  svc: {
    getGeneral: vi.fn(),
    getExperimental: vi.fn(),
    updateGeneral: vi.fn(),
    updateExperimental: vi.fn(),
    listCompanyIds: vi.fn(),
  },
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => mocks.svc,
  logActivity: mocks.logActivity,
}));

vi.mock("../services/quota-router-engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/quota-router-engine-client.js")>()),
  routeQuotaWithEngine: mocks.routeQuotaWithEngine,
}));

const ADMIN = { type: "board", userId: "admin", source: "local_implicit", isInstanceAdmin: true };
const ROUTE = "/api/instance/settings/quota-router/route";
const VALID_BODY = {
  primary: { provider: "claude", model: "opus" },
  backup_order: [{ provider: "codex", model: "gpt" }],
  quotas: [{ provider: "claude", model: "opus", observed_at_epoch_ms: 900,
    stale_after_ms: 1000, remaining_pct: 80, hard_limited: true }],
  now_epoch_ms: 1000, min_remaining_pct: 50, allow_unknown_quota: true,
};
const RESULT = {
  selected: { provider: "claude", model: "opus" }, reason: "eligible",
  tried: [{ provider: "claude", model: "opus", reason: "eligible" }],
  earliest_reset_epoch_ms: null,
};

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /instance/settings/quota-router/route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeQuotaWithEngine.mockResolvedValue({ ok: true, result: RESULT });
  });

  it.each([
    ["unauthenticated", { type: "none" }],
    ["non-admin board", { type: "board", userId: "u1", source: "session", isInstanceAdmin: false, companyIds: ["c1"] }],
    ["agent-bearer", { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" }],
  ])("rejects %s with 403 before engine access", async (_label, actor) => {
    const res = await request(createApp(actor)).post(ROUTE).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mocks.routeQuotaWithEngine).not.toHaveBeenCalled();
  });

  it("returns advisory result with no-store on success", async () => {
    const res = await request(createApp(ADMIN)).post(ROUTE).send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ advisory: true, ...RESULT });
    expect(mocks.routeQuotaWithEngine).toHaveBeenCalledTimes(1);
    expect(mocks.routeQuotaWithEngine).toHaveBeenCalledWith(VALID_BODY);
  });

  it("returns sanitized 400 on invalid_input", async () => {
    mocks.routeQuotaWithEngine.mockResolvedValue({ ok: false, kind: "invalid_input" });
    const res = await request(createApp(ADMIN)).post(ROUTE).send({ bogus: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid quota route request" });
    expect(res.body).not.toHaveProperty("ok");
    expect(res.body).not.toHaveProperty("kind");
  });

  it.each([["engine_unavailable"], ["invalid_response"]])(
    "returns sanitized 503 on %s",
    async (kind) => {
      mocks.routeQuotaWithEngine.mockResolvedValue({ ok: false, kind });
      const res = await request(createApp(ADMIN)).post(ROUTE).send(VALID_BODY);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Quota router unavailable" });
      expect(res.body).not.toHaveProperty("ok");
      expect(res.body).not.toHaveProperty("kind");
    },
  );
});
