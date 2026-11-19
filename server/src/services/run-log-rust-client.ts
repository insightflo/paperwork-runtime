import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { notFound } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_READ_LIMIT_BYTES = 16 * 1024 * 1024;
// A 16 MiB raw chunk escaped into a JSON string fits inside 64 MiB.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export function resolveRunLogBin(): string | null {
  const configured = process.env.PAPERCLIP_RUN_LOG_BIN?.trim() ?? "";
  if (!configured || !path.isAbsolute(configured) || configured.includes("\0")) {
    return null;
  }
  return configured;
}

/** Shared (offset, limitBytes) clamp so the Rust and TS read paths stay byte-identical. */
export function normalizeRunLogReadRange(opts?: { offset?: number; limitBytes?: number }) {
  const offset = Number.isFinite(opts?.offset) ? Math.max(0, Math.trunc(opts!.offset!)) : 0;
  const limitBytes = Number.isFinite(opts?.limitBytes)
    ? Math.max(1, Math.min(MAX_READ_LIMIT_BYTES, Math.trunc(opts!.limitBytes!)))
    : 256_000;
  return { offset, limitBytes };
}

/** Helper reported the log path missing (exit 2 / {"error":"not_found"}) — never fall back. */
export class RunLogHelperNotFoundError extends Error {
  constructor() {
    super("run log not found");
    this.name = "RunLogHelperNotFoundError";
  }
}

function runHelper<TResponse>(
  bin: string,
  subcommand: "finalize" | "read-range",
  payload: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TResponse> {
  return new Promise<TResponse>((resolve, reject) => {
    const child = spawn(bin, [subcommand], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    const timer = setTimeout(() => fail(new Error("run_log_timeout")), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new Error("run_log_stdout_overflow"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (err) => fail(err));
    child.stdin.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 2 || stderr.includes('"error":"not_found"')) {
        reject(new RunLogHelperNotFoundError());
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr || `run_log_exit_${code ?? "signal"}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8")) as TResponse);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

export function runRustLogFinalize(bin: string, absPath: string) {
  return runHelper<{ bytes: number; sha256: string; compressed: boolean }>(
    bin,
    "finalize",
    { path: absPath },
  );
}

export function runRustLogReadRange(bin: string, absPath: string, offset: number, limitBytes: number) {
  return runHelper<{ content: string; nextOffset?: number }>(
    bin,
    "read-range",
    { path: absPath, offset, limitBytes },
  );
}

/**
 * Pure-Node streaming rollback reader for `<path>.gz`: decodes only enough to serve
 * [offset, offset+limitBytes] plus one probe byte (mirrors the Rust reader), then stops.
 * Corrupt-gzip errors before the early stop still propagate.
 */
export async function readGzipFileRangeNodeFallback(
  gzPath: string,
  offset: number,
  limitBytes: number,
  notFoundMessage: string,
): Promise<{ content: string; nextOffset?: number }> {
  try {
    await fs.stat(gzPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound(notFoundMessage);
    throw err;
  }
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(gzPath);
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let collected = 0;
    let cursor = 0;
    const wantEnd = offset + limitBytes + 1;
    let settled = false;

    const cleanup = () => {
      gunzip.removeAllListeners();
      readStream.removeAllListeners();
      gunzip.destroy();
      readStream.destroy();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const buf = Buffer.concat(chunks, collected);
      if (buf.length > limitBytes) {
        resolve({
          content: buf.subarray(0, limitBytes).toString("utf8"),
          nextOffset: offset + limitBytes,
        });
        return;
      }
      resolve({ content: buf.toString("utf8") });
    };

    readStream.on("error", (err: NodeJS.ErrnoException) =>
      fail(err.code === "ENOENT" ? notFound(notFoundMessage) : err));
    gunzip.on("data", (chunk: Buffer) => {
      if (settled) return;
      const start = cursor;
      cursor += chunk.length;
      const sliceStart = Math.max(0, offset - start);
      const sliceEnd = Math.min(chunk.length, wantEnd - start);
      if (sliceEnd > sliceStart) {
        const piece = chunk.subarray(sliceStart, sliceEnd);
        chunks.push(piece);
        collected += piece.length;
        if (collected > limitBytes) finish();
      }
    });
    gunzip.on("end", finish);
    gunzip.on("error", fail);
    readStream.pipe(gunzip);
  });
}

/** Stream `<path>.gz` through gunzip into a sha256 — matches the Rust idempotent finalize. */
export function sha256GzipFileNodeFallback(
  gzPath: string,
): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const readStream = createReadStream(gzPath);
    const gunzip = createGunzip();
    gunzip.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    gunzip.on("end", () => resolve({ bytes, sha256: hash.digest("hex") }));
    gunzip.on("error", reject);
    readStream.on("error", reject);
    readStream.pipe(gunzip);
  });
}
