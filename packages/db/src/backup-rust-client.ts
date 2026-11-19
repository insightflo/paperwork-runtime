// Shared database-backup utilities plus the safety-gated client for the Rust
// `paperclip-db-backup` helper. The helper receives its JSON config on stdin
// (never argv, so `ps` cannot leak the connection string), runs with a minimal
// env, and fails closed: once it executes, errors surface as-is and are never
// retried through the JS fallback. Only a missing binary (ENOENT) or an
// unsupported connection string falls back to the JS implementation.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { RunDatabaseBackupOptions, RunDatabaseBackupResult, RunDatabaseRestoreOptions } from "./backup-lib.js";

const STDERR_TAIL_LIMIT = 256 * 1024;

export function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function pruneOldBackups(backupDir: string, retentionDays: number, filenamePrefix: string): number {
  if (!existsSync(backupDir)) return 0;
  const safeRetention = Math.max(1, Math.trunc(retentionDays));
  const cutoff = Date.now() - safeRetention * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`) || !(name.endsWith(".sql") || name.endsWith(".sql.gz"))) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      unlinkSync(fullPath);
      pruned++;
    }
  }

  return pruned;
}

export function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  return `${result.backupFile} (${size}${pruned})`;
}

export function sanitizeRestoreErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const firstLine = typeof record.message === "string"
      ? record.message.split(/\r?\n/, 1)[0]?.trim()
      : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const severity = typeof record.severity === "string" ? record.severity.trim() : "";
    const message = firstLine || detail || (error instanceof Error ? error.message : String(error));
    return severity ? `${severity}: ${message}` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function resolveDbBackupBin(): string | null {
  const configured = process.env.PAPERCLIP_DB_BACKUP_BIN?.trim() ?? "";
  if (configured.length === 0 || !isAbsolute(configured) || configured.includes("\0")) return null;
  return configured;
}

function isNonNegativeInteger(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

// rust-postgres parses these as u32 seconds/counts/milliseconds.
function isU32(value: string): boolean {
  return isNonNegativeInteger(value) && Number(value) <= 4294967295;
}

// Strict allowlist of query params the rust-postgres NoTls config understands.
// Anything else must fall back to the JS implementation rather than risk a
// silently-ignored parameter (e.g. sslmode or hostaddr). sslmode=prefer would
// make NoTls fail against an SSL-capable server, and keepalives is a Rust
// bool there, so both only accept their exact rust-safe spellings.
const RUST_ALLOWED_QUERY_PARAMS: Record<string, (value: string) => boolean> = {
  sslmode: (value) => value === "disable",
  application_name: () => true,
  connect_timeout: (value) => /^[1-9]\d*$/.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER,
  target_session_attrs: (value) => value === "any" || value === "read-write",
  keepalives: (value) => value === "true" || value === "false",
  keepalives_idle: isU32,
  keepalives_interval: isU32,
  keepalives_count: isU32,
  tcp_user_timeout: isU32,
};

export function isRustPostgresConnectionCompatible(connectionString: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return false;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  if (url.hostname.length === 0) return false;
  for (const key of new Set(url.searchParams.keys())) {
    const check = RUST_ALLOWED_QUERY_PARAMS[key];
    if (!check || url.searchParams.getAll(key).some((value) => !check(value))) return false;
  }
  return true;
}

type HelperOutcome = { status: "ok"; stdout: string } | { status: "failed"; code: number | null; stderr: string } | { status: "missing" };

function spawnDbBackup(bin: string, command: "backup" | "restore", config: Record<string, unknown>): Promise<HelperOutcome> {
  return new Promise((resolveOutcome) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [command], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    } catch (error) {
      resolveOutcome((error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "failed", code: null, stderr: `failed to start: ${(error as Error).message}` });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > STDERR_TAIL_LIMIT && stderrChunks.length > 1) stderrBytes -= stderrChunks.shift()!.length;
    });
    child.stdin?.on("error", () => {}); // EPIPE when the helper exits before reading all of stdin
    child.stdin?.end(JSON.stringify(config));
    const finish = (outcome: HelperOutcome) => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };
    child.on("error", (error) => {
      const errno = (error as NodeJS.ErrnoException).code;
      finish(errno === "ENOENT" ? { status: "missing" } : { status: "failed", code: null, stderr: `failed to start: ${error.message}` });
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0) finish({ status: "ok", stdout: Buffer.concat(stdoutChunks).toString("utf8").trim() });
      else finish({ status: "failed", code, stderr: stderr || `paperclip-db-backup ${command} exited with code ${code}` });
    });
  });
}

async function runDbBackupHelper(command: "backup" | "restore", config: Record<string, unknown>): Promise<string | "missing"> {
  const bin = resolveDbBackupBin();
  if (!bin) return "missing";
  const outcome = await spawnDbBackup(bin, command, config);
  if (outcome.status === "missing") return "missing";
  if (outcome.status === "failed") throw new Error(outcome.stderr);
  return outcome.stdout;
}

export type RustDelegationResult<T> = { delegated: false } | { delegated: true; value: T };

export async function tryRustDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RustDelegationResult<RunDatabaseBackupResult>> {
  const bin = resolveDbBackupBin();
  if (!bin || !isRustPostgresConnectionCompatible(opts.connectionString)) return { delegated: false };
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const retentionDays = Math.max(1, Math.trunc(opts.retentionDays));
  // The visible file name, timestamp and pruning stay in TS so retention and
  // naming parity with the JS implementation hold regardless of the executor.
  const backupFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}.sql.gz`);
  const stdout = await runDbBackupHelper("backup", {
    connectionString: opts.connectionString,
    backupFile,
    connectTimeoutSeconds: Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5)),
    includeMigrationJournal: opts.includeMigrationJournal === true,
    excludeTables: opts.excludeTables,
    nullifyColumns: opts.nullifyColumns,
  });
  if (stdout === "missing") return { delegated: false };
  let parsed: { backupFile: string; sizeBytes: number };
  try {
    parsed = JSON.parse(stdout) as { backupFile: string; sizeBytes: number };
  } catch {
    throw new Error(`paperclip-db-backup returned an unreadable result: ${stdout.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed.backupFile !== "string" || typeof parsed.sizeBytes !== "number" || !Number.isFinite(parsed.sizeBytes)) {
    throw new Error(`paperclip-db-backup returned an unreadable result: ${stdout.slice(0, 200)}`);
  }
  return { delegated: true, value: { backupFile: parsed.backupFile, sizeBytes: parsed.sizeBytes, prunedCount: pruneOldBackups(opts.backupDir, retentionDays, filenamePrefix) } };
}

export async function tryRustDatabaseRestore(opts: RunDatabaseRestoreOptions): Promise<RustDelegationResult<void>> {
  const bin = resolveDbBackupBin();
  if (!bin || !isRustPostgresConnectionCompatible(opts.connectionString)) return { delegated: false };
  try {
    const stdout = await runDbBackupHelper("restore", {
      connectionString: opts.connectionString,
      backupFile: opts.backupFile,
      connectTimeoutSeconds: Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5)),
    });
    if (stdout === "missing") return { delegated: false };
    return { delegated: true, value: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The Rust helper already prefixes restore failures; wrap exactly once.
    if (message.startsWith("Failed to restore ")) throw error;
    throw new Error(`Failed to restore ${basename(opts.backupFile)}: ${sanitizeRestoreErrorMessage(message)}`);
  }
}
