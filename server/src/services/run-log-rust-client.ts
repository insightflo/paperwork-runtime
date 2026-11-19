import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { notFound } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_READ_LIMIT_BYTES = 16 * 1024 * 1024;
// 16 MiB of raw control characters escapes to ~96 MiB inside a JSON string.
const MAX_STDOUT_BYTES = 7 * MAX_READ_LIMIT_BYTES;
const MAX_STDERR_BYTES = 64 * 1024;

export function resolveRunLogBin(): string | null {
  const configured = process.env.PAPERCLIP_RUN_LOG_BIN?.trim() ?? "";
  if (!configured || !path.isAbsolute(configured) || configured.includes("\0")) return null;
  return configured;
}

/** Shared (offset, limitBytes) clamp so the Rust and TS read paths stay byte-identical. */
export function normalizeRunLogReadRange(opts?: { offset?: number; limitBytes?: number }) {
  const offset = Number.isFinite(opts?.offset) ? Math.max(0, Math.trunc(opts!.offset!)) : 0;
  const limitBytes = Number.isFinite(opts?.limitBytes)
    ? Math.max(1, Math.min(MAX_READ_LIMIT_BYTES, Math.trunc(opts!.limitBytes!))) : 256_000;
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };

    timer = setTimeout(() => fail(new Error("run_log_timeout")), timeoutMs);

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
    child.stdout.on("error", (err) => fail(err));
    child.stderr.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        let helperReportedNotFound = false;
        try {
          helperReportedNotFound = (JSON.parse(stderr) as { error?: string }).error === "not_found";
        } catch { /* non-JSON stderr */ }
        if (code === 2 || helperReportedNotFound) {
          reject(new RunLogHelperNotFoundError());
          return;
        }
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

export async function runRustLogFinalize(bin: string, absPath: string) {
  const resp = await runHelper<{ bytes?: number; sha256?: string; compressed?: boolean }>(
    bin,
    "finalize",
    { path: absPath },
  );
  const bad = !resp || typeof resp.bytes !== "number" || typeof resp.compressed !== "boolean"
    || (resp.sha256 !== undefined && typeof resp.sha256 !== "string");
  if (bad) throw new Error("run_log_finalize_bad_shape");
  return resp as { bytes: number; sha256: string; compressed: boolean };
}

export async function runRustLogReadRange(bin: string, absPath: string, offset: number, limitBytes: number) {
  const resp = await runHelper<{ content?: string; nextOffset?: number }>(
    bin,
    "read-range",
    { path: absPath, offset, limitBytes },
  );
  if (!resp || typeof resp.content !== "string" || (resp.nextOffset !== undefined && typeof resp.nextOffset !== "number")) {
    throw new Error("run_log_read_bad_shape");
  }
  return resp as { content: string; nextOffset?: number };
}

/** Pure-Node `.gz` range reader: decodes only [offset, offset+limitBytes]+1 probe byte, mirrors the Rust reader. */
export async function readGzipFileRangeNodeFallback(
  gzPath: string,
  offset: number,
  limitBytes: number,
  notFoundMessage: string,
): Promise<{ content: string; nextOffset?: number }> {
  await fs.stat(gzPath).catch((err: NodeJS.ErrnoException) => {
    throw err.code === "ENOENT" ? notFound(notFoundMessage) : err;
  });
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(gzPath);
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    const wantEnd = offset + limitBytes + 1;
    let collected = 0, cursor = 0, settled = false;

    const cleanup = () => destroyStreamPair(gunzip, readStream);
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
        resolve({ content: buf.subarray(0, limitBytes).toString("utf8"), nextOffset: offset + limitBytes });
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
        chunks.push(chunk.subarray(sliceStart, sliceEnd));
        collected += sliceEnd - sliceStart;
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
  notFoundMessage: string,
): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0, settled = false;
    const readStream = createReadStream(gzPath);
    const gunzip = createGunzip();
    const cleanup = () => destroyStreamPair(gunzip, readStream);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    gunzip.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    gunzip.on("end", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ bytes, sha256: hash.digest("hex") });
    });
    gunzip.on("error", fail);
    readStream.on("error", (err: NodeJS.ErrnoException) =>
      fail(err.code === "ENOENT" ? notFound(notFoundMessage) : err));
    readStream.pipe(gunzip);
  });
}

function destroyStreamPair(gunzip: ReturnType<typeof createGunzip>, readStream: ReturnType<typeof createReadStream>) {
  gunzip.removeAllListeners();
  readStream.removeAllListeners();
  gunzip.destroy();
  readStream.destroy();
}

export function isRunLogEnoent(err: unknown): boolean {
  return (err as { code?: string })?.code === "ENOENT";
}

export function warnRunLogFallback(storeLabel: string, scope: string, err: unknown): void {
  console.warn(`[${storeLabel}] ${scope}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Stream a plain file into a sha256, mapping ENOENT to the store's notFound error. */
export function sha256RunLogFileNodeFallback(filePath: string, notFoundMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "ENOENT" ? notFound(notFoundMessage) : err));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Shared Node finalize: hash the plain file if it exists, else decode `<path>.gz`, else notFound. */
export async function finalizeRunLogNodeFallback(absPath: string, notFoundMessage: string) {
  const stat = await fs.stat(absPath).catch(() => null);
  if (stat) {
    const sha256 = await sha256RunLogFileNodeFallback(absPath, notFoundMessage);
    return { bytes: stat.size, sha256, compressed: false };
  }
  // The Rust helper may have renamed to .gz before a transient failure — stay idempotent.
  if (await fs.stat(`${absPath}.gz`).catch(() => null)) {
    const g = await sha256GzipFileNodeFallback(`${absPath}.gz`, notFoundMessage);
    return { bytes: g.bytes, sha256: g.sha256, compressed: true };
  }
  throw notFound(notFoundMessage);
}

async function readPlainRange(filePath: string, offset: number, limitBytes: number) {
  const stat = await fs.stat(filePath); // ENOENT propagates → caller tries the .gz sibling
  const start = Math.max(0, Math.min(offset, stat.size));
  const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));
  if (start > end) return { content: "", nextOffset: start };
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  const content = Buffer.concat(chunks).toString("utf8");
  return { content, nextOffset: end + 1 < stat.size ? end + 1 : undefined };
}

/** Shared Node read-range: plain file first, `<path>.gz` sibling on ENOENT. */
export async function readRunLogNodeFallback(absPath: string, offset: number, limitBytes: number, notFoundMessage: string) {
  try {
    return await readPlainRange(absPath, offset, limitBytes);
  } catch (err) {
    if (isRunLogEnoent(err)) {
      return readGzipFileRangeNodeFallback(`${absPath}.gz`, offset, limitBytes, notFoundMessage);
    }
    throw err;
  }
}

/** O_WRONLY|O_APPEND without O_CREAT — a vanished log must never resurrect. */
export function openAppendNoCreate(absPath: string): Promise<fs.FileHandle> {
  return fs.open(absPath, fsConstants.O_WRONLY | fsConstants.O_APPEND);
}
