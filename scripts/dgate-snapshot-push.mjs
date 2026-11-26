#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DGATE_URL = "http://127.0.0.1:4747";
export const DEFAULT_PAPERWORK_URL = "https://paperwork.insightflo.si";
export const DEFAULT_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BACKOFF_MS = 30000;

export class UsageError extends Error {}

class BridgeError extends Error {
  constructor(message, { fatal = false, status = null, stage = null } = {}) {
    super(message);
    this.name = "BridgeError";
    this.fatal = fatal;
    this.status = status;
    this.stage = stage;
  }
}

function isFatalHttpStatus(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function httpError(stage, status) {
  return new BridgeError(`${stage} failed with HTTP ${status}`, {
    fatal: isFatalHttpStatus(status), status, stage,
  });
}

function normalizeHttpBaseUrl(rawValue, label) {
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    throw new UsageError(`${label} is required`);
  }
  let url;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw new UsageError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new UsageError(`${label} must not include credentials`);
  }
  if (url.search || url.hash) {
    throw new UsageError(`${label} must not include a query string or fragment`);
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeBearerToken(rawValue, missingMessage) {
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    throw new UsageError(missingMessage);
  }
  const token = rawValue.trim();
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new UsageError("paperwork API token must contain only printable ASCII characters without whitespace");
  }
  return token;
}

export function buildSnapshotUrl(dgateUrl = DEFAULT_DGATE_URL) {
  const base = normalizeHttpBaseUrl(dgateUrl, "dgate URL");
  if (base.endsWith("/api/snapshot")) return base;
  if (base.endsWith("/api")) return `${base}/snapshot`;
  return `${base}/api/snapshot`;
}

export function buildPushUrl(paperworkUrl = DEFAULT_PAPERWORK_URL, companyId) {
  const base = normalizeHttpBaseUrl(paperworkUrl, "paperwork URL");
  if (typeof companyId !== "string" || companyId.trim() === "") {
    throw new UsageError("paperwork company id is required");
  }
  const apiBase = base.endsWith("/api") ? base : `${base}/api`;
  return `${apiBase}/companies/${encodeURIComponent(companyId.trim())}/dashboard/dgate/snapshot`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(response, stage) {
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new BridgeError(`${stage} returned invalid JSON`, { fatal: true, stage });
  }
  if (!isPlainObject(parsed)) {
    throw new BridgeError(`${stage} returned non-object JSON`, { fatal: true, stage });
  }
  return parsed;
}

export async function pushOnce(options) {
  if (!isPlainObject(options)) throw new UsageError("push options are required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UsageError("timeoutMs must be a positive integer");
  }
  const token = normalizeBearerToken(options.token, "paperwork API token is required");
  const snapshotUrl = buildSnapshotUrl(options.dgateUrl ?? DEFAULT_DGATE_URL);
  const pushUrl = buildPushUrl(options.paperworkUrl ?? DEFAULT_PAPERWORK_URL, options.companyId);

  const snapshotResponse = await fetchImpl(snapshotUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!snapshotResponse.ok) throw httpError("dgate snapshot fetch", snapshotResponse.status);
  const snapshot = await readJsonObject(snapshotResponse, "dgate snapshot fetch");

  const body = JSON.stringify(snapshot);
  const pushResponse = await fetchImpl(pushUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!pushResponse.ok) throw httpError("paperwork snapshot push", pushResponse.status);
  const acknowledgement = await readJsonObject(pushResponse, "paperwork snapshot push");

  return {
    snapshotUrl,
    pushUrl,
    status: pushResponse.status,
    snapshotBytes: Buffer.byteLength(body, "utf8"),
    fetchedAt: typeof acknowledgement.fetchedAt === "string" ? acknowledgement.fetchedAt : null,
  };
}

export function backoffMs(intervalMs, consecutiveFailures) {
  const failureCount = Math.max(1, Math.floor(consecutiveFailures));
  const exponent = Math.min(failureCount - 1, 3);
  return Math.min(intervalMs * 2 ** exponent, MAX_BACKOFF_MS);
}

function sleep(ms, signal) {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) return resolvePromise();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolvePromise();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function errorSummary(error) {
  if (!(error instanceof Error)) return "unknown error";
  const causeCode = error.cause && typeof error.cause === "object" && "code" in error.cause
    ? String(error.cause.code)
    : null;
  return causeCode ? `${error.message} (${causeCode})` : error.message;
}

function logPushSuccess(log, result) {
  log(`[dgate-snapshot-push] pushed snapshot (${result.snapshotBytes} bytes) to ${result.pushUrl}`);
}

export async function runLoop(config, {
  log = console.log,
  error = console.error,
  signal = null,
  sleepImpl = sleep,
} = {}) {
  let consecutiveFailures = 0;
  while (!signal?.aborted) {
    try {
      const result = await pushOnce(config);
      consecutiveFailures = 0;
      logPushSuccess(log, result);
      await sleepImpl(config.intervalMs, signal);
    } catch (err) {
      if (err instanceof UsageError || (err instanceof BridgeError && err.fatal)) {
        error(`[dgate-snapshot-push] fatal error: ${errorSummary(err)}`);
        return 1;
      }
      consecutiveFailures += 1;
      const delayMs = backoffMs(config.intervalMs, consecutiveFailures);
      error(`[dgate-snapshot-push] push failed: ${errorSummary(err)}; retrying in ${delayMs}ms`);
      await sleepImpl(delayMs, signal);
    }
  }
  return 0;
}

function usage() {
  return `Usage: node scripts/dgate-snapshot-push.mjs [options]

Options:
  --dgate-url <url>       dg serve base URL (env DGATE_WEB_URL; default http://127.0.0.1:4747)
  --paperwork-url <url>   papercompany base URL (env PAPERWORK_URL; default https://paperwork.insightflo.si)
  --company-id <id>       target company id (env PAPERWORK_COMPANY_ID; required)
  --token <token>         bearer token (env PAPERWORK_API_TOKEN; required, never logged; env preferred)
  --interval-ms <ms>      loop interval in milliseconds (default 5000)
  --once                  fetch and push one snapshot, then exit
  --help                  print this help`;
}

export function parseConfig(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dgate-url": { type: "string" },
      "paperwork-url": { type: "string" },
      "company-id": { type: "string" },
      token: { type: "string" },
      "interval-ms": { type: "string" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  const intervalMs = Number(values["interval-ms"] ?? DEFAULT_INTERVAL_MS);
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new UsageError("--interval-ms must be a positive integer");
  }
  const companyId = (values["company-id"] ?? env.PAPERWORK_COMPANY_ID ?? "").trim();
  if (!companyId) throw new UsageError("missing company id: pass --company-id or set PAPERWORK_COMPANY_ID");
  const token = normalizeBearerToken(
    values.token ?? env.PAPERWORK_API_TOKEN ?? "",
    "missing API token: pass --token or set PAPERWORK_API_TOKEN",
  );
  return {
    help: false,
    once: values.once,
    intervalMs,
    dgateUrl: values["dgate-url"] ?? env.DGATE_WEB_URL ?? DEFAULT_DGATE_URL,
    paperworkUrl: values["paperwork-url"] ?? env.PAPERWORK_URL ?? DEFAULT_PAPERWORK_URL,
    companyId,
    token,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, {
  log = console.log,
  error = console.error,
} = {}) {
  let config;
  try {
    config = parseConfig(argv, env);
  } catch (err) {
    if (err instanceof UsageError || err instanceof TypeError) {
      error(`[dgate-snapshot-push] ${err.message}\n${usage()}\n`);
      return 2;
    }
    throw err;
  }
  if (config.help) {
    log(`${usage()}\n`);
    return 0;
  }
  if (config.once) {
    try {
      logPushSuccess(log, await pushOnce(config));
      return 0;
    } catch (err) {
      error(`[dgate-snapshot-push] push failed: ${errorSummary(err)}`);
      return 1;
    }
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    log(`[dgate-snapshot-push] pushing every ${config.intervalMs}ms; press Ctrl+C to stop`);
    return await runLoop(config, { log, error, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exitCode = await main();
