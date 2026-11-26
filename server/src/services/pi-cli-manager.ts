import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { resetCommandCodeModelsCacheForTests } from "@paperclipai/adapter-commandcode-local/server";
import { resetPiModelsCacheForTests } from "@paperclipai/adapter-pi-local/server";
import type {
  CliRuntimeId,
  CliRuntimeStatus,
  PiCliActionResult,
  PiCliProviderStatus,
  PiCliStatusSnapshot,
} from "@paperclipai/shared/types/instance";
import { resetClaudeModelsCacheForTests } from "../adapters/claude-models.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { listAdapterModels } from "../adapters/registry.js";
import { badRequest } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { instanceSettingsService } from "./instance-settings.js";

const STATUS_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 60_000;
const RUST_BIN_TIMEOUT_MS = 25_000;
const NPM_VIEW_TIMEOUT_MS = 2_500;
const NPM_LATEST_CACHE_TTL_MS = 5 * 60_000;
const PI_NPM_PACKAGE = "@mariozechner/pi-coding-agent";
const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const PROVIDER_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const COMMON_PI_PATHS = ["/home/opc/.npm-global/bin/pi", "/home/opc/.bun/bin/pi", path.join(os.homedir(), ".bun", "bin", "pi")];
const VALID_RUNTIME_IDS = new Set<CliRuntimeId>([
  "pi", "codex", "claude", "opencode", "commandcode", "antigravity", "gemini", "hermes", "cursor",
]);

export type PiCliExecFile = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
export interface PiCliManagerOptions { homeDir?: string; agentDir?: string; piCommand?: string; execFileImpl?: PiCliExecFile; /** npm 최신 버전 조회(checkUpdates) off 시 false. 기본 on. */ checkUpdates?: boolean }
export type PiCliSyncDirection = "both" | "to_pi" | "from_pi";
interface StoredProvider { id: string; name: string; baseUrl: string; model?: string; apiKeyEncrypted?: unknown }

const execFileAsync = promisify(execFile);
const defaultExecFile: PiCliExecFile = (command, args, options) =>
  execFileAsync(command, args, { timeout: options.timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFile = (candidate: string) => { try { return statSync(candidate).isFile(); } catch { return false; } };
const entryModels = (raw: unknown): unknown[] => (isRecord(raw) && Array.isArray(raw.models) ? raw.models : []);
const modelEntryId = (entry: unknown): string | undefined =>
  typeof entry === "string" && entry.trim() ? entry.trim()
    : isRecord(entry) && typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined;
const isHttpUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch { return false; }
};

export function isValidCliRuntimeId(value: unknown): value is CliRuntimeId {
  return typeof value === "string" && VALID_RUNTIME_IDS.has(value as CliRuntimeId);
}

function flushAllAdapterModelCaches(): void {
  resetPiModelsCacheForTests();
  resetCommandCodeModelsCacheForTests();
  resetCodexModelsCacheForTests();
  resetClaudeModelsCacheForTests();
}

function resolveRustCliRuntimeBin(opts: PiCliManagerOptions): string | null {
  if (opts.execFileImpl) return null;
  const configured = process.env.PAPERCLIP_CLI_RUNTIME_BIN?.trim();
  if (configured && path.isAbsolute(configured) && existsSync(configured)) return configured;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../../../crates/cli-runtime/target/release/paperclip-cli-runtime");
  return existsSync(candidate) ? candidate : null;
}

function runRustCliRuntime<TResponse>(bin: string, subcommand: "status" | "sync" | "logout", payload: unknown): Promise<TResponse> {
  return new Promise<TResponse>((resolve, reject) => {
    const child = spawn(bin, [subcommand], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("cli_runtime_timeout")), RUST_BIN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { fail(new Error("cli_runtime_stdout_overflow")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024); });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `cli_runtime_exit_${code ?? "signal"}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as TResponse);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function resolveAgentDir(opts: PiCliManagerOptions): string {
  const override = opts.agentDir ?? process.env.PAPERCLIP_PI_AGENT_DIR;
  return typeof override === "string" && override.trim() ? override.trim() : path.join(os.homedir(), ".pi", "agent");
}

function resolvePiCommand(opts: PiCliManagerOptions): { command: string; executablePath: string | null } {
  const override = opts.piCommand ?? process.env.PAPERCLIP_PI_COMMAND;
  if (typeof override === "string" && override.trim()) return { command: override.trim(), executablePath: override.trim() };
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = dir ? path.join(dir, "pi") : "";
    if (candidate && isFile(candidate)) return { command: candidate, executablePath: candidate };
  }
  for (const candidate of COMMON_PI_PATHS) {
    if (isFile(candidate)) return { command: candidate, executablePath: candidate };
  }
  return { command: "pi", executablePath: null };
}

const execPi = (opts: PiCliManagerOptions, command: string, args: string[], timeout: number) =>
  (opts.execFileImpl ?? defaultExecFile)(command, args, { timeout });

function execErrorLine(err: unknown): string {
  const text = isRecord(err) && typeof err.stderr === "string" && err.stderr.trim() ? err.stderr
    : err instanceof Error ? err.message : "";
  return (text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "unknown_error").slice(0, 200);
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeJsonAtomic(filePath: string, value: unknown, mode?: number): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
  if (mode !== undefined) try { chmodSync(tmpPath, mode); } catch { /* fs without chmod support */ }
  renameSync(tmpPath, filePath);
}

function hasCredential(entry: unknown): boolean {
  if (typeof entry === "string") return entry.trim().length > 0;
  return isRecord(entry) && Object.entries(entry).some(([k, v]) => k !== "type" && typeof v === "string" && v.trim().length > 0);
}

function readProviderStatuses(agentDir: string): PiCliProviderStatus[] {
  const modelsJson = readJsonFile(path.join(agentDir, "models.json"));
  const authJson = readJsonFile(path.join(agentDir, "auth.json"));
  const providers = isRecord(modelsJson.providers) ? modelsJson.providers : {};
  return Object.entries(providers).map(([id, raw]) => {
    const models = entryModels(raw).map(modelEntryId).filter((value): value is string => Boolean(value))
      .map((value) => (value.startsWith(`${id}/`) ? value : `${id}/${value}`));
    return {
      id,
      ...(isRecord(raw) && typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
      ...(isRecord(raw) && typeof raw.api === "string" ? { api: raw.api } : {}),
      modelCount: models.length,
      models,
      authConfigured: hasCredential(authJson[id]),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** 코어 semver 비교. "pi 9.9.9"처럼 접두 텍스트가 섞여도 첫 숫자 토큰을 기준으로 비교한다.
 * 파싱 실패시 0(같음) — 업데이트 있음으로 오탐하지 않는다. */
export function compareSemver(a: string, b: string): number {
  const coreNumbers = (value: string): number[] => {
    const token = value.trim().split(/\s+/).find((part) => /^\d/.test(part)) ?? "";
    return token
      .replace(/^v/i, "")
      .split(/[+-]/)[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10));
  };
  const [na, nb] = [coreNumbers(a), coreNumbers(b)];
  if (na.length === 0 || nb.length === 0) return 0;
  if (na.some(Number.isNaN) || nb.some(Number.isNaN)) return 0;
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (na[i] ?? 0) - (nb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** `npm view <pkg> version` 조회(짧은 타임아웃 + 모듈 캐시). 실패시 undefined. 성공만 캐시한다. */
const npmLatestCache = new Map<string, { version: string; expiresAt: number }>();

async function npmLatestVersion(pkg: string, opts: PiCliManagerOptions): Promise<string | undefined> {
  const cached = npmLatestCache.get(pkg);
  if (cached && cached.expiresAt > Date.now()) return cached.version;
  try {
    const { stdout } = await (opts.execFileImpl ?? defaultExecFile)("npm", ["view", pkg, "version"], { timeout: NPM_VIEW_TIMEOUT_MS });
    const version = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!/^\d+(\.\d+)+/.test(version)) return undefined;
    npmLatestCache.set(pkg, { version, expiresAt: Date.now() + NPM_LATEST_CACHE_TTL_MS });
    return version;
  } catch {
    return undefined;
  }
}

function parseCatalogModels(stdout: string, stderr: string): string[] {
  const ids = new Set<string>();
  for (const text of [stdout, stderr]) {
    const lines = text.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => {
      const cols = line.trim().split(/\s{2,}/).map((col) => col.trim().toLowerCase());
      return cols[0] === "provider" && cols[1] === "model";
    });
    for (const line of lines.slice(headerIndex >= 0 ? headerIndex + 1 : 0)) {
      const [provider = "", model = ""] = line.trim().split(/\s{2,}/).map((part) => part.trim());
      if (provider && model && provider !== "provider" && !/\s/.test(model)) ids.add(`${provider}/${model}`);
    }
  }
  return [...ids].sort().slice(0, 300);
}

async function enrichRuntimesWithAdapterModels(runtimes: CliRuntimeStatus[], piCatalogModels: string[]): Promise<CliRuntimeStatus[]> {
  return Promise.all(runtimes.map(async (rt) => {
    if (rt.id === "pi") {
      return { ...rt, modelCount: piCatalogModels.length, sampleModels: piCatalogModels.slice(0, 5) };
    }
    if (!rt.installed) return rt;
    try {
      const models = await Promise.race([
        listAdapterModels(rt.adapterType),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1_500)),
      ]);
      const ids = models.map((m) => m.id).filter(Boolean);
      return { ...rt, modelCount: ids.length, sampleModels: ids.slice(0, 5) };
    } catch {
      return rt;
    }
  }));
}

export async function getPiCliStatus(opts: PiCliManagerOptions = {}): Promise<PiCliStatusSnapshot> {
  const agentDir = resolveAgentDir(opts);
  const rustBin = resolveRustCliRuntimeBin(opts);
  if (rustBin) {
    try {
      const snapshot = await runRustCliRuntime<PiCliStatusSnapshot>(rustBin, "status", {
        homeDir: opts.homeDir ?? os.homedir(),
        piAgentDir: agentDir,
        ...(opts.piCommand ? { commandOverrides: { pi: opts.piCommand } } : {}),
        checkUpdates: opts.checkUpdates ?? true,
      });
      if (Array.isArray(snapshot.runtimes) && !opts.homeDir) {
        snapshot.runtimes = await enrichRuntimesWithAdapterModels(snapshot.runtimes, snapshot.catalogModels ?? []);
      }
      return snapshot;
    } catch {
      // Fall back to Node path below if Rust helper fails.
    }
  }

  const { command, executablePath } = resolvePiCommand(opts);
  const status: PiCliStatusSnapshot = {
    installed: false, executablePath: null, version: null, agentDir,
    providers: readProviderStatuses(agentDir), catalogModels: [],
  };
  try {
    const { stdout } = await execPi(opts, command, ["--version"], STATUS_TIMEOUT_MS);
    status.installed = true;
    status.executablePath = executablePath ?? command;
    status.version = stdout.split(/\r?\n/, 1)[0]?.trim() || "unknown";
    try {
      const catalog = await execPi(opts, command, ["--list-models"], STATUS_TIMEOUT_MS);
      status.catalogModels = parseCatalogModels(catalog.stdout, catalog.stderr);
    } catch (err) {
      status.error = execErrorLine(err);
    }
  } catch (err) {
    status.error = execErrorLine(err);
  }
  const piLatest = opts.checkUpdates === false ? undefined : await npmLatestVersion(PI_NPM_PACKAGE, opts);
  status.runtimes = [{
    id: "pi",
    name: "Pi CLI",
    adapterType: "pi_local",
    installed: status.installed,
    executablePath: status.executablePath,
    version: status.version,
    authConfigured: status.providers.some((p) => p.authConfigured),
    authSource: status.providers.some((p) => p.authConfigured) ? "~/.pi/agent/auth.json" : null,
    modelCount: status.catalogModels.length,
    sampleModels: status.catalogModels.slice(0, 5),
    supportsSelfUpdate: true,
    supportsModelUpdate: true,
    supportsProviderSync: true,
    ...(piLatest
      ? { latestVersion: piLatest, updateAvailable: status.installed && compareSemver(piLatest, status.version ?? "") > 0 }
      : {}),
    ...(status.error ? { error: status.error } : {}),
  }];
  return status;
}

function readStoredProviders(general: Record<string, unknown>): StoredProvider[] {
  if (!Array.isArray(general.llmStructuredProviders)) return [];
  return general.llmStructuredProviders.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.baseUrl !== "string" || !raw.baseUrl) return [];
    return [{
      id: raw.id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.id,
      baseUrl: raw.baseUrl,
      ...(typeof raw.model === "string" && raw.model ? { model: raw.model } : {}),
      ...(raw.apiKeyEncrypted !== undefined ? { apiKeyEncrypted: raw.apiKeyEncrypted } : {}),
    }];
  });
}

const resolveSecret = (encrypted: unknown): Promise<string | undefined> =>
  isRecord(encrypted) && isRecord(encrypted.material)
    ? localEncryptedProvider.resolveVersion({ material: encrypted.material, externalRef: null }).catch(() => undefined)
    : Promise.resolve(undefined);

export async function syncInstanceProvidersWithPiCli(
  db: Db,
  opts: PiCliManagerOptions & { direction?: PiCliSyncDirection; fetchImpl?: typeof fetch } = {},
): Promise<PiCliActionResult> {
  const direction = opts.direction ?? "both";
  if (direction !== "both" && direction !== "to_pi" && direction !== "from_pi") {
    throw badRequest(`Invalid pi-cli sync direction: ${String(direction)}`);
  }
  const agentDir = resolveAgentDir(opts);
  const general = (await db.select({ general: instanceSettings.general }).from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default")).then((rows) => rows[0]?.general)) ?? {};
  const storedProviders = readStoredProviders(general);
  const providers: Array<StoredProvider & { apiKey?: string }> = await Promise.all(
    storedProviders.map(async ({ apiKeyEncrypted, ...fields }) => ({ ...fields, apiKey: await resolveSecret(apiKeyEncrypted) })),
  );
  if (providers.length === 0 && typeof general.llmStructuredBaseUrl === "string" && general.llmStructuredBaseUrl) {
    providers.push({
      id: "default", name: "Default", baseUrl: general.llmStructuredBaseUrl,
      ...(typeof general.llmStructuredModel === "string" && general.llmStructuredModel ? { model: general.llmStructuredModel } : {}),
      apiKey: await resolveSecret(general.llmStructuredApiKeyEncrypted),
    });
  }

  let pushed = 0;
  let imported = 0;
  const rustBin = resolveRustCliRuntimeBin(opts);
  if (rustBin) {
    const syncOut = await runRustCliRuntime<{
      pushed: number;
      importedProviders: Array<{ id: string; name: string; baseUrl: string; model?: string; apiKey?: string }>;
    }>(rustBin, "sync", {
      homeDir: os.homedir(),
      piAgentDir: agentDir,
      direction,
      webProviders: providers,
    });
    pushed = syncOut.pushed;
    if (syncOut.importedProviders.length > 0) {
      await instanceSettingsService(db).updateGeneral({
        llmStructuredProviders: [
          ...storedProviders.map(({ apiKeyEncrypted, ...fields }) => fields),
          ...syncOut.importedProviders,
        ],
      });
      imported = syncOut.importedProviders.length;
    }
    flushAllAdapterModelCaches();
    return {
      ok: true, action: "sync",
      message: `pushed ${pushed} provider(s) to CLI harnesses, imported ${imported} provider(s) from pi`,
      status: await getPiCliStatus(opts),
    };
  }

  const modelsPath = path.join(agentDir, "models.json");
  const authPath = path.join(agentDir, "auth.json");

  if (direction !== "from_pi" && providers.length > 0) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const modelsJson = readJsonFile(modelsPath);
    const authJson = readJsonFile(authPath);
    const providerMap: Record<string, unknown> = isRecord(modelsJson.providers) ? modelsJson.providers : {};
    let authDirty = false;
    for (const provider of providers) {
      const rawEntry = providerMap[provider.id];
      const existing: Record<string, unknown> = isRecord(rawEntry) ? rawEntry : {};
      const models = Array.isArray(existing.models) ? [...existing.models] : [];
      const modelId = provider.model?.startsWith(`${provider.id}/`) ? provider.model.slice(provider.id.length + 1) : provider.model;
      if (modelId && !models.some((entry) => modelEntryId(entry) === modelId)) models.push({ id: modelId });
      providerMap[provider.id] = {
        ...existing,
        baseUrl: provider.baseUrl,
        api: typeof existing.api === "string" && existing.api ? existing.api : "openai-completions",
        models,
      };
      if (provider.apiKey) {
        authJson[provider.id] = { type: "api_key", key: provider.apiKey };
        authDirty = true;
      }
      pushed += 1;
    }
    modelsJson.providers = providerMap;
    writeJsonAtomic(modelsPath, modelsJson);
    if (authDirty) writeJsonAtomic(authPath, authJson, 0o600);
  }

  if (direction !== "to_pi") {
    const modelsJson = readJsonFile(modelsPath);
    const providerMap: Record<string, unknown> = isRecord(modelsJson.providers) ? modelsJson.providers : {};
    const authJson = readJsonFile(authPath);
    const additions: Array<{ id: string; name: string; baseUrl: string; model?: string; apiKey?: string }> = [];
    for (const [id, raw] of Object.entries(providerMap)) {
      if (!PROVIDER_ID_RE.test(id) || storedProviders.some((provider) => provider.id === id)) continue;
      const entry = isRecord(raw) ? raw : {};
      const baseUrl = typeof entry.baseUrl === "string" && isHttpUrl(entry.baseUrl) ? entry.baseUrl
        : id === "zai" ? ZAI_DEFAULT_BASE_URL : undefined;
      if (!baseUrl) continue;
      const model = entryModels(entry).map(modelEntryId).find((value) => value !== undefined);
      const authEntry = authJson[id];
      const apiKey = typeof authEntry === "string" && authEntry.trim() ? authEntry.trim()
        : isRecord(authEntry) && typeof authEntry.key === "string" && authEntry.key ? authEntry.key : undefined;
      additions.push({
        id,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
        baseUrl,
        ...(model && MODEL_ID_RE.test(model) ? { model } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
    }
    if (additions.length > 0) {
      await instanceSettingsService(db).updateGeneral({
        llmStructuredProviders: [...storedProviders.map(({ apiKeyEncrypted, ...fields }) => fields), ...additions],
      });
      imported = additions.length;
    }
  }

  flushAllAdapterModelCaches();
  return {
    ok: true, action: "sync",
    message: `pushed ${pushed} provider(s) to pi, imported ${imported} provider(s) from pi`,
    status: await getPiCliStatus(opts),
  };
}

const RUNTIME_UPDATE_COMMANDS: Partial<Record<CliRuntimeId, [string, string[]]>> = {
  claude: ["claude", ["update"]],
  codex: ["npm", ["update", "-g", "@openai/codex"]],
  opencode: ["opencode", ["upgrade"]],
  commandcode: ["npm", ["update", "-g", "commandcode"]],
  gemini: ["npm", ["update", "-g", "@google/gemini-cli"]],
  hermes: ["hermes", ["update"]],
};

export async function runCliRuntimeUpdate(
  runtimeId: CliRuntimeId,
  target: "self" | "models",
  opts: PiCliManagerOptions = {},
): Promise<PiCliActionResult> {
  if (!isValidCliRuntimeId(runtimeId)) throw badRequest(`Invalid runtimeId: ${String(runtimeId)}`);
  if (target !== "self" && target !== "models") throw badRequest(`Invalid update target: ${String(target)}`);
  if (runtimeId === "pi") return runPiCliUpdate(target, opts);
  if (target === "models") {
    flushAllAdapterModelCaches();
    return {
      ok: true,
      action: "refresh_models",
      message: `${runtimeId} model cache refreshed`,
      status: await getPiCliStatus(opts),
    };
  }
  const spec = RUNTIME_UPDATE_COMMANDS[runtimeId];
  if (!spec) {
    return {
      ok: false,
      action: "update_cli",
      message: `${runtimeId} does not support in-place CLI self-update`,
      status: await getPiCliStatus(opts),
    };
  }
  const [cmd, args] = spec;
  try {
    await execPi(opts, cmd, args, UPDATE_TIMEOUT_MS);
    flushAllAdapterModelCaches();
    return {
      ok: true,
      action: "update_cli",
      message: `${runtimeId} CLI update completed`,
      status: await getPiCliStatus(opts),
    };
  } catch (err) {
    flushAllAdapterModelCaches();
    return {
      ok: false,
      action: "update_cli",
      message: `${runtimeId} CLI update failed: ${execErrorLine(err)}`,
      status: await getPiCliStatus(opts),
    };
  }
}

export async function runPiCliUpdate(target: "self" | "models", opts: PiCliManagerOptions = {}): Promise<PiCliActionResult> {
  if (target !== "self" && target !== "models") throw badRequest(`Invalid pi update target: ${String(target)}`);
  const action = target === "self" ? ("update_self" as const) : ("update_models" as const);
  const { command } = resolvePiCommand(opts);
  try {
    await execPi(opts, command, ["update", `--${target}`, "--no-approve"], UPDATE_TIMEOUT_MS);
    flushAllAdapterModelCaches();
    return { ok: true, action, message: `pi update --${target} completed`, status: await getPiCliStatus(opts) };
  } catch (err) {
    flushAllAdapterModelCaches();
    return { ok: false, action, message: `pi update --${target} failed: ${execErrorLine(err)}`, status: await getPiCliStatus(opts) };
  }
}

export async function logoutPiCliProvider(
  providerId: string,
  opts: PiCliManagerOptions & { runtimeId?: CliRuntimeId } = {},
): Promise<PiCliActionResult> {
  if (!PROVIDER_ID_RE.test(providerId)) throw badRequest("Invalid providerId");
  const runtimeId = opts.runtimeId ?? "pi";
  const agentDir = resolveAgentDir(opts);
  const rustBin = resolveRustCliRuntimeBin(opts);
  if (rustBin) {
    await runRustCliRuntime(rustBin, "logout", {
      homeDir: os.homedir(),
      piAgentDir: agentDir,
      runtimeId,
      providerId,
    }).catch(() => undefined);
  } else {
    const authPath = path.join(agentDir, "auth.json");
    const authJson = readJsonFile(authPath);
    if (providerId in authJson) {
      delete authJson[providerId];
      writeJsonAtomic(authPath, authJson, 0o600);
    }
  }
  const { command } = resolvePiCommand(opts);
  let cliError: string | undefined;
  if (runtimeId === "pi") {
    try {
      await execPi(opts, command, ["auth", "logout", providerId], STATUS_TIMEOUT_MS);
    } catch (err) {
      cliError = execErrorLine(err);
    }
  }
  flushAllAdapterModelCaches();
  return {
    ok: true, action: "logout",
    message: `removed auth for provider "${providerId}"${cliError ? " (pi cli logout skipped)" : ""}`,
    status: await getPiCliStatus(opts),
  };
}
