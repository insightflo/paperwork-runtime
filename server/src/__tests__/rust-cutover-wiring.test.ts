import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthRoutes } from "../routes/health.js";
import { RUST_CORE_CUTOVER_ENV_KEYS } from "../services/rust-cutover-registry.js";

type CutoverKey = (typeof RUST_CORE_CUTOVER_ENV_KEYS)[number];
const total = RUST_CORE_CUTOVER_ENV_KEYS.length;

function stubCutoverEnv(
  master: string | undefined,
  overrides: Partial<Record<CutoverKey, string | undefined>> = {},
) {
  vi.stubEnv("PAPERWORK_RUST_CORE_ALL", master);
  vi.stubEnv("PAPERCLIP_DEV_SERVER_STATUS_FILE", "");
  for (const key of RUST_CORE_CUTOVER_ENV_KEYS) {
    vi.stubEnv(key, overrides[key]);
  }
}

function cutoverEnvSnapshot() {
  return Object.fromEntries(
    RUST_CORE_CUTOVER_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
}

async function importRuntimeFresh() {
  vi.resetModules();
  await import("../services/paperwork-engine-runtime.js");
}

function healthApp() {
  const app = express();
  app.use("/health", healthRoutes({} as Db));
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("unified Rust core cutover startup wiring and health summary", () => {
  it("leaves cutover env unchanged and reports only pre-existing enablement when the master switch is unset", async () => {
    const manuallyEnabledKey = RUST_CORE_CUTOVER_ENV_KEYS[0];
    stubCutoverEnv(undefined, { [manuallyEnabledKey]: "1" });
    const before = cutoverEnvSnapshot();

    await importRuntimeFresh();

    expect(cutoverEnvSnapshot()).toEqual(before);
    expect(process.env.PAPERWORK_RUST_CORE_ALL).toBeUndefined();

    const res = await request(healthApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.rustCoreCutover).toEqual({
      masterEnabled: false,
      enabledCount: 1,
      total,
    });
  });

  it("applies the master switch at runtime module initialization while preserving per-domain zero opt-outs", async () => {
    const optedOutKey = RUST_CORE_CUTOVER_ENV_KEYS[0];
    stubCutoverEnv("1", { [optedOutKey]: "0" });

    await importRuntimeFresh();

    expect(process.env[optedOutKey]).toBe("0");
    for (const key of RUST_CORE_CUTOVER_ENV_KEYS.slice(1)) {
      expect(process.env[key]).toBe("1");
    }

    const res = await request(healthApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.rustCoreCutover).toEqual({
      masterEnabled: true,
      enabledCount: total - 1,
      total,
    });
  });
});
