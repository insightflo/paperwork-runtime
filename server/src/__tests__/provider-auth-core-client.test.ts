import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import {
  isValidProviderAuthId,
  planProviderLogin,
  probeAllProviders,
  ProviderAuthClientError,
  PROVIDER_AUTH_IDS,
  resolveProviderAuthBin,
} from "../services/provider-auth-core-client.js";

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(), getExperimental: vi.fn(), updateGeneral: vi.fn(),
    updateExperimental: vi.fn(), listCompanyIds: vi.fn(async () => []),
    testLlmStructuredConnection: vi.fn(),
  }),
  logActivity: vi.fn(async () => undefined),
}));

// STUB_MODE 로 행동을 바꾸는 실행 가능 node stub — 실 Rust bin 대신 spawn 계약만 검증한다.
const STUB = `#!/usr/bin/env node
const mode = process.env.STUB_MODE || "ok";
const sub = process.argv[2];
const plan = { provider: process.argv[3] || "claude", command: "c", args: ["login"], interactive: true, notes: ["n1"] };
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
if (mode === "ok") out(sub === "probe-all" ? [{ provider: "claude", evidence: "missing" }, { provider: "codex", evidence: "api_key_env_present", envVar: "OPENAI_API_KEY" }] : plan);
else if (mode === "extra") out(sub === "probe-all" ? [{ provider: "claude", evidence: "missing", bogus: 1, credentialMeta: { exists: true, isSymlink: true, sizeBytes: 1, mtimeEpochMs: 2, inode: 3, junk: "x" } }] : { ...plan, extra: "strip" });
else if (mode === "mismatch") out({ provider: "codex", command: "codex", args: ["auth", "login"], interactive: true, notes: [] });
else if (mode === "badexit") { process.stderr.write("secret-stderr-token"); process.exit(2); }
else if (mode === "malformed") out("not-json{{{");
else if (mode === "schema") out(sub === "probe-all" ? [{ provider: "claude", evidence: "bogus" }] : { provider: "claude", command: 5, args: [], interactive: true, notes: [] });
else if (mode === "inf") out('[{"provider":"claude","evidence":"credential_file_present","credentialMeta":{"exists":true,"isSymlink":false,"sizeBytes":1e309,"mtimeEpochMs":1,"inode":2}}]');
else if (mode === "sleep") setInterval(() => {}, 60000);
else if (mode === "bigout") { const s = "x".repeat(1024); for (let i = 0; i < 600; i++) process.stdout.write(s); }
else if (mode === "bigerr") { const s = "e".repeat(1024); for (let i = 0; i < 40; i++) process.stderr.write(s); }
`;

let dir: string;
let stub: string;
let nonexec: string;

const ADMIN = { type: "board", userId: "u", source: "local_implicit", isInstanceAdmin: true };
const NON_ADMIN = { type: "board", userId: "u2", source: "session", isInstanceAdmin: false };
const AUTH_URL = "/api/instance/settings/general/provider-auth";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", instanceSettingsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pac-client-"));
  stub = path.join(dir, "stub");
  await writeFile(stub, STUB, "utf8");
  await chmod(stub, 0o755);
  nonexec = path.join(dir, "nonexec");
  await writeFile(nonexec, "#!/bin/true\n", "utf8");
  await chmod(nonexec, 0o644);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("PAPERCLIP_PROVIDER_AUTH_BIN", stub);
  vi.stubEnv("STUB_MODE", "ok");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("provider-auth-core client", () => {
  it("resolveProviderAuthBin fail-closed: configured set 시 runnable defaultBin 도 절대 미참조", () => {
    vi.stubEnv("PAPERCLIP_PROVIDER_AUTH_BIN", "");
    expect(resolveProviderAuthBin(path.join(dir, "no-such"), stub)).toBeNull();
    expect(resolveProviderAuthBin("relative/bin", stub)).toBeNull();
    expect(resolveProviderAuthBin(undefined, stub)).toBe(stub);
    expect(PROVIDER_AUTH_IDS).toContain("claude");
    expect(isValidProviderAuthId("bogus")).toBe(false);
  });

  it("probe-all: valid JSON 을 투영하고 unexpected 필드를 제거한다", async () => {
    vi.stubEnv("STUB_MODE", "extra");
    expect(await probeAllProviders({ binPath: stub })).toEqual([{
      provider: "claude", evidence: "missing", auxiliaryPresent: [],
      credentialMeta: { exists: true, isSymlink: true, sizeBytes: 1, mtimeEpochMs: 2, inode: 3 },
    }]);
  });

  it("plan-login: valid plan 반환 + provider echo 불일치 시 invalid_json", async () => {
    expect(await planProviderLogin("claude", { binPath: stub }))
      .toEqual({ provider: "claude", command: "c", args: ["login"], interactive: true, notes: ["n1"] });
    vi.stubEnv("STUB_MODE", "mismatch");
    await expect(planProviderLogin("claude", { binPath: stub })).rejects.toMatchObject({ reason: "invalid_json" });
  });

  it.each([
    ["malformed", "invalid_json"],
    ["schema", "invalid_json"],
    ["inf", "invalid_json"], // JSON.parse 는 1e309 → Infinity — Number.isFinite 가 fail-close
    ["badexit", "non_zero_exit"],
  ])("mode %s → %s", async (mode, reason) => {
    vi.stubEnv("STUB_MODE", mode);
    await expect(probeAllProviders({ binPath: stub })).rejects.toMatchObject({ reason });
  });

  it("에러 살균: raw stderr·OS 에러 텍스트를 유출하지 않는다", async () => {
    vi.stubEnv("STUB_MODE", "badexit");
    const err = await probeAllProviders({ binPath: stub }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthClientError);
    expect(err.message).not.toContain("secret-stderr-token");
    const spawnErr = await probeAllProviders({ binPath: nonexec }).catch((e) => e);
    expect(spawnErr).toMatchObject({ reason: "spawn_error" });
    expect(spawnErr.message).not.toMatch(/EACCES|permission denied/i);
  });

  it("timeout: 즉시 settle(SIGKILL+pipe destroy) — close 를 기다리지 않는다", async () => {
    vi.stubEnv("STUB_MODE", "sleep");
    const t0 = Date.now();
    await expect(probeAllProviders({ binPath: stub, timeoutMs: 150 })).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("stdout/stderr overflow: bounded pipe 초과 시 즉시 settle", async () => {
    vi.stubEnv("STUB_MODE", "bigout");
    await expect(probeAllProviders({ binPath: stub })).rejects.toMatchObject({ reason: "stdout_overflow" });
    vi.stubEnv("STUB_MODE", "bigerr");
    await expect(probeAllProviders({ binPath: stub })).rejects.toMatchObject({ reason: "stderr_overflow" });
  });
});

describe("provider-auth routes", () => {
  it("GET provider-auth: 200 {providers} + no-store, admin 만 허용", async () => {
    const okRes = await request(createApp(ADMIN)).get(AUTH_URL);
    expect(okRes.status).toBe(200);
    expect(okRes.headers["cache-control"]).toBe("no-store");
    expect(okRes.body.providers).toHaveLength(2);
    expect(okRes.body.providers[0]).toEqual({ provider: "claude", evidence: "missing", auxiliaryPresent: [] });
    expect((await request(createApp(NON_ADMIN)).get(AUTH_URL)).status).toBe(403);
  });

  it("GET login-plan: 200 {plan} + no-store, echo mismatch → 503, non-admin 403", async () => {
    const res = await request(createApp(ADMIN)).get(`${AUTH_URL}/claude/login-plan`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.plan).toEqual({ provider: "claude", command: "c", args: ["login"], interactive: true, notes: ["n1"] });
    vi.stubEnv("STUB_MODE", "mismatch");
    const bad = await request(createApp(ADMIN)).get(`${AUTH_URL}/claude/login-plan`);
    expect(bad.status).toBe(503);
    expect(bad.body).toEqual({ error: "provider_auth_probe_unavailable", reason: "invalid_json" });
    expect((await request(createApp(NON_ADMIN)).get(`${AUTH_URL}/claude/login-plan`)).status).toBe(403);
  });

  it("invalid provider → 400(spawn·resolve 이전에 거절)", async () => {
    vi.stubEnv("PAPERCLIP_PROVIDER_AUTH_BIN", path.join(dir, "no-such"));
    expect((await request(createApp(ADMIN)).get(`${AUTH_URL}/bogus/login-plan`)).status).toBe(400);
  });

  it("configured bin 결측 → 503 binary_missing(defaultBin 미참조 증명, 경로/OS 텍스트 비유출)", async () => {
    vi.stubEnv("PAPERCLIP_PROVIDER_AUTH_BIN", path.join(dir, "no-such"));
    const res = await request(createApp(ADMIN)).get(AUTH_URL);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "provider_auth_probe_unavailable", reason: "binary_missing" });
    expect(JSON.stringify(res.body)).not.toContain(dir);
  });

  it("non-zero exit → 503 non_zero_exit, raw stderr 비유출", async () => {
    vi.stubEnv("STUB_MODE", "badexit");
    const res = await request(createApp(ADMIN)).get(AUTH_URL);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "provider_auth_probe_unavailable", reason: "non_zero_exit" });
    expect(JSON.stringify(res.body)).not.toContain("secret-stderr-token");
  });
});
