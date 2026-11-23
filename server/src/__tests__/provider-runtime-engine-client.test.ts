import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  checkProviderRuntimeBlocklist,
  ProviderRuntimeEngineError,
} from "../services/provider-runtime-engine-client.js";

const mocks = vi.hoisted(() => ({
  getShared: vi.fn(),
  engineCall: vi.fn(),
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

vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: mocks.getShared,
}));

const fakeEngine = { call: mocks.engineCall } as unknown as PaperworkEngineClient;
const ADMIN = { type: "board", userId: "admin", source: "local_implicit", isInstanceAdmin: true };
const ROUTE = "/api/instance/settings/provider-runtimes/check-blocklist";
const VALID_BODY = {
  provider: "claude",
  version: "1.2.3",
  blocklist: { versions: ["9.x-*"], sha256s: [] },
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

describe("checkProviderRuntimeBlocklist service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getShared.mockReturnValue(fakeEngine);
    mocks.engineCall.mockResolvedValue({ blocked: false });
  });

  const badInputs: Array<[string, unknown]> = [
    ["unknown provider", { ...VALID_BODY, provider: "gpt" }],
    ["non-string provider", { ...VALID_BODY, provider: 7 }],
    ["traversal version ../1.0", { ...VALID_BODY, version: "../1.0" }],
    ["slash version a/b", { ...VALID_BODY, version: "a/b" }],
    ["whitespace-only version", { ...VALID_BODY, version: "   " }],
    ["invalid sha256", { ...VALID_BODY, sha256: "deadbeef" }],
    ["non-object blocklist", { ...VALID_BODY, blocklist: ["x"] }],
    ["empty version entry", { ...VALID_BODY, blocklist: { versions: [""], sha256s: [] } }],
    ["non-array versions", { ...VALID_BODY, blocklist: { versions: "1.0", sha256s: [] } }],
    ["bad sha256s entry", { ...VALID_BODY, blocklist: { versions: [], sha256s: ["zz"] } }],
    ["missing body", undefined],
  ];

  it.each(badInputs)("rejects %s fail-closed before engine access", async (_label, input) => {
    const pending = checkProviderRuntimeBlocklist(input);
    await expect(pending).rejects.toThrow(ProviderRuntimeEngineError);
    await expect(pending).rejects.toMatchObject({ reason: "invalid_input" });
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });

  it("maps daemon and engine failures to typed reasons", async () => {
    mocks.engineCall.mockRejectedValueOnce(new Error("timeout"));
    await expect(checkProviderRuntimeBlocklist(VALID_BODY)).rejects.toMatchObject({ reason: "rpc_error" });
    mocks.engineCall.mockResolvedValueOnce({ blocked: "no" });
    await expect(checkProviderRuntimeBlocklist(VALID_BODY)).rejects.toMatchObject({ reason: "invalid_response" });
    mocks.getShared.mockReturnValueOnce(null);
    await expect(checkProviderRuntimeBlocklist(VALID_BODY)).rejects.toMatchObject({ reason: "engine_unavailable" });
    mocks.getShared.mockImplementationOnce(() => {
      throw new Error("no bin");
    });
    await expect(checkProviderRuntimeBlocklist(VALID_BODY)).rejects.toMatchObject({ reason: "engine_unavailable" });
    expect(mocks.engineCall).toHaveBeenCalledTimes(2);
  });
});

describe("POST /instance/settings/provider-runtimes/check-blocklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getShared.mockReturnValue(fakeEngine);
    mocks.engineCall.mockResolvedValue({ blocked: false });
  });

  it("returns 400 on invalid input without touching the engine", async () => {
    const res = await request(createApp(ADMIN))
      .post(ROUTE)
      .send({ provider: "gpt", version: "1", blocklist: { versions: [], sha256s: [] } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid provider runtime blocklist request" });
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", { type: "none" }],
    ["non-admin board", { type: "board", userId: "u1", source: "session", isInstanceAdmin: false, companyIds: ["c1"] }],
    ["agent-bearer", { type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" }],
  ])("rejects %s with 403 before engine access", async (_label, actor) => {
    const res = await request(createApp(actor)).post(ROUTE).send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["engine unavailable (null)", () => mocks.getShared.mockReturnValue(null)],
    ["shared-client factory throws", () => mocks.getShared.mockImplementation(() => {
      throw new Error("no bin");
    })],
    ["rpc failure", () => mocks.engineCall.mockRejectedValue(new Error("timeout"))],
    ["malformed reply {blocked:'no'}", () => mocks.engineCall.mockResolvedValue({ blocked: "no" })],
    ["malformed reply {reason:123}", () => mocks.engineCall.mockResolvedValue({ blocked: false, reason: 123 })],
    ["null reply", () => mocks.engineCall.mockResolvedValue(null)],
  ])("returns sanitized 503 on %s", async (_label, setup) => {
    setup();
    const res = await request(createApp(ADMIN)).post(ROUTE).send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Provider runtime blocklist check unavailable" });
    expect(res.body).not.toHaveProperty("blocked");
  });

  it("returns advisory blocked verdict with reason", async () => {
    mocks.engineCall.mockResolvedValue({ provider: "claude", version: "1.2.3", blocked: true, reason: "version" });
    const res = await request(createApp(ADMIN)).post(ROUTE).send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ advisory: true, blocked: true, reason: "version" });
    expect(mocks.engineCall).toHaveBeenCalledWith(
      "provider.check_blocklist",
      VALID_BODY,
      { timeoutMs: undefined },
    );
  });

  it("returns advisory unblocked verdict when engine replies reason:null", async () => {
    mocks.engineCall.mockResolvedValue({ provider: "claude", version: "1.2.3", blocked: false, reason: null });
    const res = await request(createApp(ADMIN)).post(ROUTE).send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ advisory: true, blocked: false });
  });
});
