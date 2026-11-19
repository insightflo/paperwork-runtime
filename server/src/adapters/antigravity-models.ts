import { spawnSync } from "node:child_process";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";
import { models as antigravityFallbackModels } from "@paperclipai/adapter-antigravity-local";
import type { AdapterModel } from "./types.js";
import { dedupeAdapterModels } from "./local-cli-models.js";

const ANTIGRAVITY_MODELS_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_MODELS_CACHE_TTL_MS = 60_000;
const MAX_BUFFER_BYTES = 512 * 1024;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const HEADER_TOKENS = new Set(["id", "name", "model", "models", "available", "label"]);

export type AntigravityModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

type AntigravityModelsRunner = (command: string, args: string[]) => AntigravityModelsCommandResult;

let cached: { command: string; expiresAt: number; models: AdapterModel[] } | null = null;

function resolveAntigravityCommand(): string {
  return process.env.PAPERCLIP_ANTIGRAVITY_COMMAND?.trim() || "agy";
}

function defaultAntigravityModelsRunner(
  command: string,
  args: string[],
): AntigravityModelsCommandResult {
  const envWithPath = ensurePathInEnv(process.env);
  const env = Object.fromEntries(
    Object.entries(envWithPath).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    timeout: ANTIGRAVITY_MODELS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    // agy waits on an open stdin pipe; ignore stdin so `agy models` exits immediately.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    hasError: Boolean(result.error),
  };
}

let antigravityModelsRunner: AntigravityModelsRunner = defaultAntigravityModelsRunner;

function sanitizeModelId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[,;]+$/g, "")
    .trim();
}

function isLikelyModelId(raw: string): boolean {
  const id = sanitizeModelId(raw);
  if (!id || HEADER_TOKENS.has(id.toLowerCase())) return false;
  return MODEL_ID_RE.test(id);
}

function normalizeTerminalLine(rawLine: string): string {
  const stripped = rawLine.replace(ANSI_ESCAPE_RE, "");
  const segments = stripped
    .split("\r")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : "";
}

function collectFromJsonValue(value: unknown, target: AdapterModel[]) {
  if (typeof value === "string") {
    const id = sanitizeModelId(value);
    if (isLikelyModelId(id)) target.push({ id, label: id });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromJsonValue(item, target);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const rec = value as Record<string, unknown>;
  for (const key of ["id", "name", "model", "modelId"]) {
    const rawId = rec[key];
    if (typeof rawId === "string") {
      const id = sanitizeModelId(rawId);
      const rawLabel = typeof rec.label === "string" ? rec.label.trim() : "";
      if (isLikelyModelId(id)) target.push({ id, label: rawLabel || id });
      break;
    }
  }
  for (const key of ["models", "data", "items", "availableModels"]) {
    if (key in rec) collectFromJsonValue(rec[key], target);
  }
}

/**
 * Parse `agy models` output (`<id>\t<label>` lines, optional JSON, or `Available models:` fallback).
 */
export function parseAntigravityModelsOutput(stdout: string, stderr = ""): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  const trimmedStdout = stdout.replace(ANSI_ESCAPE_RE, "").trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      collectFromJsonValue(JSON.parse(trimmedStdout) as unknown, parsed);
    } catch {
      // Fall through to text parsing when stdout is not valid JSON.
    }
  }

  for (const lineRaw of stdout.replace(/\r\n/g, "\n").split("\n")) {
    const line = normalizeTerminalLine(lineRaw);
    if (!line) continue;
    const bullet = line.replace(/^[-*•]\s+/, "").trim();
    const splitCols = bullet.includes("\t")
      ? bullet.split("\t")
      : /\s{2,}/.test(bullet)
        ? bullet.split(/\s{2,}/)
        : null;
    if (splitCols && splitCols.length >= 2) {
      const id = sanitizeModelId(splitCols[0] ?? "");
      const label = splitCols.slice(1).join(" ").trim();
      if (isLikelyModelId(id)) parsed.push({ id, label: label || id });
      continue;
    }
    if (!bullet.includes(" ") && /[/-]|\d/.test(bullet)) {
      const id = sanitizeModelId(bullet);
      if (isLikelyModelId(id)) parsed.push({ id, label: id });
    }
  }

  if (parsed.length === 0) {
    const combined = `${stdout}\n${stderr}`.replace(ANSI_ESCAPE_RE, "");
    for (const match of combined.matchAll(/available models?:\s*([^\n]+)/gi)) {
      for (const token of (match[1] ?? "").split(/[,\s]+/)) {
        const id = sanitizeModelId(token);
        if (isLikelyModelId(id)) parsed.push({ id, label: id });
      }
    }
  }

  return dedupeAdapterModels(parsed);
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeAdapterModels([...antigravityFallbackModels, ...models]).sort((a, b) => {
    if (a.id === "auto") return -1;
    if (b.id === "auto") return 1;
    return a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" });
  });
}

/**
 * List Antigravity models via `agy models`, merging `auto` fallback and caching for 60s.
 */
export async function listAntigravityModels(): Promise<AdapterModel[]> {
  const command = resolveAntigravityCommand();
  const fallback = dedupeAdapterModels(antigravityFallbackModels);
  const now = Date.now();
  if (cached && cached.command === command && cached.expiresAt > now) {
    return cached.models;
  }

  const result = antigravityModelsRunner(command, ["models"]);
  if (!result.hasError && (result.status ?? 1) === 0) {
    const discovered = parseAntigravityModelsOutput(result.stdout, result.stderr);
    if (discovered.length > 0) {
      const merged = mergedWithFallback(discovered);
      cached = { command, expiresAt: now + ANTIGRAVITY_MODELS_CACHE_TTL_MS, models: merged };
      return merged;
    }
  }

  if (cached && cached.command === command && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

export function resetAntigravityModelsCacheForTests() {
  cached = null;
}

export function setAntigravityModelsRunnerForTests(runner: AntigravityModelsRunner | null) {
  antigravityModelsRunner = runner ?? defaultAntigravityModelsRunner;
}
