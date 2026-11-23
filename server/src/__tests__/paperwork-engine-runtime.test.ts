import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  closeSharedPaperworkEngineClient, getSharedPaperworkEngineClient, resetSharedPaperworkEngineForTests,
  resolveDefaultPaperworkEngineBin, runOrderedShutdownSteps,
} from "../services/paperwork-engine-runtime.js";
import { planProviderLogin, probeAllProviders, ProviderAuthClientError } from "../services/provider-auth-core-client.js";

vi.mock("node:child_process", { spy: true });

let dir: string | undefined;
afterEach(async () => {
  await resetSharedPaperworkEngineForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const repoRoot = path.resolve(tmpdir(), "fake-repo");
const workspaceRelease = path.join(repoRoot, "target/release/paperwork-engine");
const stagedRelease = path.join(repoRoot, "crates/paperwork-engine/target/release/paperwork-engine");
const workspaceDebug = path.join(repoRoot, "target/debug/paperwork-engine");

describe("engine discovery", () => {
  it.each(["", "   ", "relative/engine", `${repoRoot}/bad\0bin`])("rejects override %j without probing", (bin) => {
    const existsSync = vi.fn(() => true);
    expect(resolveDefaultPaperworkEngineBin({ repoRoot, env: { PAPERWORK_ENGINE_BIN: bin }, existsSync })).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("uses only a trimmed absolute override, even if it is missing", () => {
    const bin = path.join(repoRoot, "override");
    const env = { PAPERWORK_ENGINE_BIN: ` ${bin} ` };
    const existsSync = vi.fn((p: string) => p !== bin).mockReturnValueOnce(true);
    expect(resolveDefaultPaperworkEngineBin({ repoRoot, env, existsSync })).toBe(bin);
    expect(resolveDefaultPaperworkEngineBin({ repoRoot, env, existsSync })).toBeNull();
    expect(existsSync.mock.calls).toEqual([[bin], [bin]]);
  });

  it("rejects a relative root without probing", () => {
    const existsSync = vi.fn(() => true);
    expect(resolveDefaultPaperworkEngineBin({ repoRoot: "relative", env: {}, existsSync })).toBeNull();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("rejects a relative root even when the override is an existing absolute path", () => {
    const env = { PAPERWORK_ENGINE_BIN: process.execPath };
    expect(resolveDefaultPaperworkEngineBin({ repoRoot: "relative", env })).toBeNull();
  });

  const candidates = [workspaceRelease, stagedRelease, workspaceDebug];
  it.each([0, 1, 2, 3])("discovers the first available candidate at index %i", (first) => {
    const existsSync = vi.fn((p: string) => candidates.slice(first).includes(p));
    expect(resolveDefaultPaperworkEngineBin({ repoRoot, env: {}, existsSync })).toBe(candidates[first] ?? null);
    expect(existsSync.mock.calls.flat()).toEqual(candidates.slice(0, first + 1));
  });
});

function fakeClient(close = vi.fn<PaperworkEngineClient["close"]>().mockResolvedValue(undefined)) {
  return {
    close, call: vi.fn<PaperworkEngineClient["call"]>(), getPid: vi.fn(() => null),
    health: vi.fn<PaperworkEngineClient["health"]>(), redactText: vi.fn<PaperworkEngineClient["redactText"]>(),
  } satisfies PaperworkEngineClient;
}

function activate(client: PaperworkEngineClient) {
  vi.stubEnv("PAPERWORK_ENGINE_BIN", process.execPath);
  const factory = vi.fn(() => client);
  expect(getSharedPaperworkEngineClient(factory)).toBe(client);
  expect(factory).toHaveBeenCalledExactlyOnceWith(process.execPath);
  return factory;
}

describe("shared engine lifecycle", () => {
  it("publishes one close promise before calling close and blocks re-entry and replacements", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const client = fakeClient(vi.fn(() => {
      expect(getSharedPaperworkEngineClient(factory)).toBeNull();
      expect(closeSharedPaperworkEngineClient()).toBe(closing);
      return pending;
    }));
    const factory = activate(client);
    expect(getSharedPaperworkEngineClient(factory)).toBe(client);
    const closing = closeSharedPaperworkEngineClient();
    expect(client.close).not.toHaveBeenCalled();
    expect(closeSharedPaperworkEngineClient()).toBe(closing);
    await Promise.resolve();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(getSharedPaperworkEngineClient(factory)).toBeNull();
    release();
    await closing;
    await closeSharedPaperworkEngineClient();
    expect(getSharedPaperworkEngineClient(factory)).toBeNull();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each(["reject", "throw"])("stays closed after close %s", async (mode) => {
    const failure = new Error(mode);
    const client = fakeClient(vi.fn(() => {
      if (mode === "throw") throw failure;
      return Promise.reject(failure);
    }));
    const factory = activate(client);
    const closing = closeSharedPaperworkEngineClient();
    expect(closeSharedPaperworkEngineClient()).toBe(closing);
    await expect(closing).rejects.toBe(failure);
    await expect(closeSharedPaperworkEngineClient()).resolves.toBeUndefined();
    expect(getSharedPaperworkEngineClient(factory)).toBeNull();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("closing from idle prevents a late lazy spawn", async () => {
    vi.stubEnv("PAPERWORK_ENGINE_BIN", process.execPath);
    const done = closeSharedPaperworkEngineClient();
    const factory = vi.fn(() => fakeClient());
    expect(getSharedPaperworkEngineClient(factory)).toBeNull();
    await done;
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([false, true])("reset closes the active client and restores idle (rejects: %s)", async (rejects) => {
    const client = fakeClient(vi.fn(async () => { if (rejects) throw new Error("close failed"); }));
    activate(client);
    await resetSharedPaperworkEngineForTests();
    expect(client.close).toHaveBeenCalledTimes(1);
    activate(fakeClient());
  });
});

describe("ordered shutdown", () => {
  it.each([1, 2])("still runs all steps when step %i rejects", async (failsAt) => {
    const error = new Error("shutdown step failed");
    const order: number[] = [];
    const steps = [1, 2, 3].map((step) => async () => {
      await Promise.resolve();
      order.push(step);
      if (step === failsAt) throw error;
    });
    await expect(runOrderedShutdownSteps(steps)).rejects.toBe(error);
    expect(order).toEqual([1, 2, 3]);
  });

  it("aggregates synchronous throws and rejections in order", async () => {
    const first = new Error("first");
    const second = new Error("second");
    const last = vi.fn();
    await expect(runOrderedShutdownSteps([() => { throw first; }, () => Promise.reject(second), last]))
      .rejects.toMatchObject({ name: "AggregateError", message: "Ordered shutdown failed", errors: [first, second] });
    expect(last).toHaveBeenCalledOnce();
  });
});

const status = { provider: "claude", evidence: "missing" };
const plan = { provider: "claude", command: "claude", args: ["login"], interactive: true, notes: [] };

describe("provider auth engine routing", () => {
  it("prefers an injected engine over direct-binary overrides for both methods", async () => {
    vi.stubEnv("PAPERCLIP_PROVIDER_AUTH_BIN", "");
    const engineClient = fakeClient();
    engineClient.call.mockResolvedValueOnce({ providers: [status] }).mockResolvedValueOnce(plan);
    const opts = { engineClient, binPath: null, timeoutMs: 123 };
    expect(await probeAllProviders(opts)).toEqual([{ ...status, auxiliaryPresent: [] }]);
    expect(await planProviderLogin("claude", opts)).toEqual(plan);
    expect(engineClient.call.mock.calls).toEqual([
      ["provider.auth_probe_all", {}, { timeoutMs: 123 }],
      ["provider.auth_plan_login", { provider: "claude" }, { timeoutMs: 123 }],
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("validates engine response shapes and binds login plans to the requested provider", async () => {
    const engineClient = fakeClient();
    const opts = { engineClient };
    await expect(planProviderLogin("invalid" as "claude", opts)).rejects.toMatchObject({ reason: "invalid_provider" });
    expect(engineClient.call).not.toHaveBeenCalled();
    engineClient.call.mockResolvedValueOnce([status]).mockResolvedValueOnce({ ...plan, provider: "codex" })
      .mockResolvedValueOnce({ ...plan, args: [1] }).mockResolvedValueOnce({ ...plan, extra: true });
    await expect(probeAllProviders(opts)).rejects.toMatchObject({ reason: "invalid_json" });
    for (let i = 0; i < 3; i++) {
      await expect(planProviderLogin("claude", opts)).rejects.toMatchObject({ reason: "invalid_json" });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", "timeout"], ["response_too_large", "stdout_overflow"], ["process_exited", "non_zero_exit"],
    ["closed", "non_zero_exit"], ["bin_not_configured", "binary_missing"], ["rpc_error", "invalid_json"],
    ["protocol_error", "invalid_json"], ["request_too_large", "invalid_json"], ["queue_full", "invalid_json"],
    [null, "spawn_error"],
  ] as const)("maps %s without falling back", async (code, reason) => {
    const engineClient = fakeClient();
    engineClient.call.mockRejectedValue(code ? new PaperworkEngineError(code) : new Error("unexpected"));
    const opts = { engineClient, binPath: process.execPath };
    await expect(probeAllProviders(opts)).rejects.toEqual(new ProviderAuthClientError(reason));
    await expect(planProviderLogin("claude", opts)).rejects.toEqual(new ProviderAuthClientError(reason));
    expect(engineClient.call).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses one resident daemon with no call overrides and never spawns the CLI after RPC errors", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paperwork-engine-runtime-"));
    const bin = path.join(dir, "engine-stub");
    await writeFile(bin, `#!/usr/bin/env node
const readline = require("node:readline").createInterface({ input: process.stdin });
const seen = new Set();
readline.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const results = {
    "provider.auth_probe_all": Object.keys(params).length === 0 && { providers: [${JSON.stringify(status)}] },
    "provider.auth_plan_login": params.provider === "claude" && ${JSON.stringify(plan)},
  };
  const result = results[method];
  const body = seen.has(method) || !result ? { error: { code: -32603, message: "stub failure" } } : { result };
  seen.add(method);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
});
`, { mode: 0o755 });
    vi.stubEnv("PAPERCLIP_PROVIDER_AUTH_BIN", undefined);
    vi.stubEnv("PAPERWORK_ENGINE_BIN", bin);
    expect(await probeAllProviders()).toEqual([{ ...status, auxiliaryPresent: [] }]);
    expect(await planProviderLogin("claude")).toEqual(plan);
    await expect(probeAllProviders()).rejects.toEqual(new ProviderAuthClientError("invalid_json"));
    await expect(planProviderLogin("claude")).rejects.toEqual(new ProviderAuthClientError("invalid_json"));
    expect(spawn).toHaveBeenCalledExactlyOnceWith(bin, [], expect.objectContaining({ shell: false }));
  });
});
