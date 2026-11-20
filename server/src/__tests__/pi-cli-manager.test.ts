import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  getPiCliStatus,
  logoutPiCliProvider,
  runCliRuntimeUpdate,
  runPiCliUpdate,
  syncInstanceProvidersWithPiCli,
  type PiCliExecFile,
  type PiCliManagerOptions,
} from "../services/pi-cli-manager.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/cli-runtime/target/release/paperclip-cli-runtime");

beforeAll(async () => {
  if (!fs.existsSync(rustBin)) {
    const cargoBin = process.env.CARGO || "cargo";
    execFileSync(cargoBin, ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/cli-runtime/Cargo.toml")], {
      stdio: "inherit",
    });
  }
  tempDb = await startEmbeddedPostgresTestDatabase("pi-cli-manager-");
  db = createDb(tempDb.connectionString);
}, 120_000);

afterAll(async () => {
  if (db) await db.$client.end({ timeout: 5 });
  await tempDb?.cleanup();
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
}, 30_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPiCliStatus", () => {
  it("reports version, provider models, runtimes, and auth without leaking secrets", async () => {
    const agentDir = await tempDir("pi-status-");
    const secret = "status-test-secret-key";
    await fsp.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          zai: { baseUrl: ZAI_BASE_URL, api: "openai-completions", models: [{ id: "glm-4.6" }, { id: "glm-4.5" }] },
          solo: { baseUrl: "https://solo.example/v1", models: [{ id: "m1" }] },
        },
      }),
    );
    await fsp.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ zai: { type: "api_key", key: secret }, solo: { type: "api_key", key: "solo-secret" } }),
    );
    const execFileImpl: PiCliExecFile = async (_command, args) => {
      if (args[0] === "--version") return { stdout: "pi 9.9.9\n", stderr: "" };
      if (args[0] === "--list-models") return { stdout: "provider  model\nzai  glm-4.6\nzai  glm-4.5\n", stderr: "" };
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    const status = await getPiCliStatus({ agentDir, piCommand: "/fake/pi", execFileImpl });
    expect(status).toMatchObject({
      installed: true,
      executablePath: "/fake/pi",
      version: "pi 9.9.9",
      agentDir,
      catalogModels: ["zai/glm-4.5", "zai/glm-4.6"],
    });
    expect(status.runtimes?.length).toBeGreaterThanOrEqual(1);
    const zai = status.providers.find((provider) => provider.id === "zai");
    expect(zai).toMatchObject({
      baseUrl: ZAI_BASE_URL,
      api: "openai-completions",
      modelCount: 2,
      models: ["zai/glm-4.6", "zai/glm-4.5"],
      authConfigured: true,
    });
    expect(status.providers.find((provider) => provider.id === "solo")).toMatchObject({ modelCount: 1, authConfigured: true });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status)).not.toContain("solo-secret");
  });

  it("uses the compiled Rust paperclip-cli-runtime binary for multi-CLI status", async () => {
    const homeDir = await tempDir("rust-cli-home-");
    const agentDir = path.join(homeDir, ".pi", "agent");
    await fsp.mkdir(agentDir, { recursive: true });
    const fakePi = path.join(homeDir, "fake-pi");
    await fsp.writeFile(
      fakePi,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"pi 9.9.9\"; exit 0; fi\nif [ \"$1\" = \"--list-models\" ]; then printf \"provider  model\\nzai  glm-4.6\\n\"; exit 0; fi\nexit 1\n",
    );
    await fsp.chmod(fakePi, 0o755);
    const status = await getPiCliStatus({ homeDir, agentDir, piCommand: fakePi });
    expect(status.installed).toBe(true);
    expect(status.version).toBe("9.9.9");
    expect(status.catalogModels).toEqual(["zai/glm-4.6"]);
    expect(status.runtimes?.map((r) => r.id)).toEqual(
      expect.arrayContaining(["pi", "codex", "claude", "opencode", "commandcode", "antigravity", "gemini", "hermes", "cursor"]),
    );
  });
});

describe("syncInstanceProvidersWithPiCli", () => {
  it("writes pi config files and imports cli-only providers without plaintext keys", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a1".repeat(32));
    const agentDir = await tempDir("pi-sync-");
    const svc = instanceSettingsService(db);
    const instanceKey = "instance-provider-secret";
    const cliKey = "cli-provider-secret";
    await svc.updateGeneral({
      llmStructuredProviders: [
        { id: "zai", name: "Z.AI", baseUrl: ZAI_BASE_URL, model: "zai/glm-4.6", apiKey: instanceKey },
      ],
    });
    await fsp.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { clionly: { baseUrl: "https://cli.example/v1", models: [{ id: "cli-model" }] } } }),
    );
    await fsp.writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ clionly: { type: "api_key", key: cliKey } }),
    );
    const execFileImpl: PiCliExecFile = async () => {
      throw new Error("pi not installed");
    };
    const result = await syncInstanceProvidersWithPiCli(db, { direction: "both", agentDir, piCommand: "/fake/pi", execFileImpl });
    expect(result).toMatchObject({ ok: true, action: "sync" });

    const modelsJson = JSON.parse(await fsp.readFile(path.join(agentDir, "models.json"), "utf8"));
    expect(modelsJson.providers.zai).toMatchObject({ baseUrl: ZAI_BASE_URL, api: "openai-completions" });
    expect(modelsJson.providers.zai.models).toEqual([{ id: "glm-4.6" }]);
    expect(modelsJson.providers.clionly.models).toEqual([{ id: "cli-model" }]);

    const authPath = path.join(agentDir, "auth.json");
    expect(JSON.parse(await fsp.readFile(authPath, "utf8"))).toEqual({
      clionly: { type: "api_key", key: cliKey },
      zai: { type: "api_key", key: instanceKey },
    });
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);

    const general = await svc.getGeneral();
    expect(general.llmStructuredProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "zai", apiKeyConfigured: true }),
        expect.objectContaining({ id: "clionly", baseUrl: "https://cli.example/v1", model: "cli-model", apiKeyConfigured: true }),
      ]),
    );
    expect(JSON.stringify(general)).not.toContain(cliKey);
    expect(JSON.stringify(general)).not.toContain(instanceKey);
    expect((await svc.getLlmStructuredRuntimeConfig("clionly")).apiKey).toBe(cliKey);
  });
});

describe("runPiCliUpdate, runCliRuntimeUpdate, and logoutPiCliProvider", () => {
  it("runs update targets across runtimes and removes provider auth", async () => {
    const agentDir = await tempDir("pi-logout-");
    const authPath = path.join(agentDir, "auth.json");
    await fsp.writeFile(
      authPath,
      JSON.stringify({ zai: { type: "api_key", key: "zai-secret" }, other: { type: "api_key", key: "other-secret" } }),
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const execFileImpl: PiCliExecFile = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "--version") return { stdout: "pi 1.0.0\n", stderr: "" };
      if (args[0] === "--list-models") return { stdout: "", stderr: "" };
      if (args[0] === "update" || args[0] === "auth" || args[0] === "upgrade") return { stdout: "", stderr: "" };
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    const opts: PiCliManagerOptions = { agentDir, piCommand: "/fake/pi", execFileImpl };

    await expect(runPiCliUpdate("self", opts)).resolves.toMatchObject({ ok: true, action: "update_self" });
    await expect(runPiCliUpdate("models", opts)).resolves.toMatchObject({ ok: true, action: "update_models" });
    await expect(runCliRuntimeUpdate("claude", "self", opts)).resolves.toMatchObject({ ok: true, action: "update_cli" });
    await expect(runCliRuntimeUpdate("codex", "models", opts)).resolves.toMatchObject({ ok: true, action: "refresh_models" });
    await expect(runCliRuntimeUpdate("antigravity", "self", opts)).resolves.toMatchObject({ ok: false, action: "update_cli" });
    await expect(runPiCliUpdate("bogus" as "self", opts)).rejects.toThrow();

    await expect(logoutPiCliProvider("zai", opts)).resolves.toMatchObject({ ok: true, action: "logout" });
    expect(JSON.parse(await fsp.readFile(authPath, "utf8"))).toEqual({ other: { type: "api_key", key: "other-secret" } });
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
    await expect(logoutPiCliProvider("bad;id", opts)).rejects.toThrow();

    expect(calls).toContainEqual({ command: "/fake/pi", args: ["update", "--self", "--no-approve"] });
    expect(calls).toContainEqual({ command: "/fake/pi", args: ["update", "--models", "--no-approve"] });
    expect(calls).toContainEqual({ command: "claude", args: ["update"] });
    expect(calls).toContainEqual({ command: "/fake/pi", args: ["auth", "logout", "zai"] });
  });
});
