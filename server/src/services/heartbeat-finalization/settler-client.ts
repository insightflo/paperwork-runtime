import { execFile } from "node:child_process";
import path from "node:path";
import { getDbConnectionUrl, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

const SETTLER_TIMEOUT_MS = 15_000;
const SETTLER_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const ALLOWED_SSL_MODES = new Set(["disable", "allow", "prefer"]);

export interface RustSettledRunReport {
  runId: string;
  companyId: string;
  issueId: string | null;
  workflowStepRunId: string | null;
  agentStatusReleased: {
    companyId: string;
    agentId: string;
    outcome: string;
  } | null;
}

export interface RustSettlerRecoverResult {
  processed: number;
  settled: RustSettledRunReport[];
}

export function resolveSettlerBin(): string | null {
  const configured = process.env.PAPERCLIP_SETTLER_BIN?.trim() ?? "";
  if (!configured || !path.isAbsolute(configured) || configured.includes("\0")) {
    return null;
  }
  return configured;
}

function getPlainTcpPostgresUrl(db: Db): string | null {
  const rawUrl = getDbConnectionUrl(db);
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    if (!parsed.hostname || parsed.searchParams.has("sslrootcert")) return null;
    const sslMode = parsed.searchParams.get("sslmode")?.trim().toLowerCase();
    if (sslMode && !ALLOWED_SSL_MODES.has(sslMode)) return null;
    return rawUrl;
  } catch {
    return null;
  }
}

/**
 * Delegates terminal-unsettled v1 run recovery to `paperclip-settler` when configured
 * and running against a root plain-TCP Db handle. Transactions and mock DBs lack a
 * registered URL and automatically fall back to the TypeScript path.
 */
export async function runRustSettlerRecoverOnce(
  db: Db,
  now: Date,
  graceMs: number,
): Promise<RustSettlerRecoverResult | null> {
  const bin = resolveSettlerBin();
  if (!bin) return null;
  const dbUrl = getPlainTcpPostgresUrl(db);
  if (!dbUrl) return null;

  const normalizedGrace = Math.trunc(graceMs);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        ["recover-once", "--now", now.toISOString(), "--grace-ms", String(normalizedGrace)],
        {
          env: { PATH: process.env.PATH ?? "", DATABASE_URL: dbUrl },
          timeout: SETTLER_TIMEOUT_MS,
          maxBuffer: SETTLER_MAX_BUFFER_BYTES,
        },
        (error, out, stderr) => {
          if (error) {
            const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message;
            reject(new Error(detail));
            return;
          }
          resolve(out);
        },
      );
    });
    const parsed = JSON.parse(stdout) as Partial<RustSettlerRecoverResult>;
    if (typeof parsed.processed !== "number" || !Array.isArray(parsed.settled)) {
      throw new Error("invalid paperclip-settler JSON response");
    }
    return { processed: parsed.processed, settled: parsed.settled };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "rust paperclip-settler recover-once failed; falling back to TypeScript settlement",
    );
    return null;
  }
}
