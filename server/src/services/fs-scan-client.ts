import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export function resolveFsScanBin(): string | null {
  const configured = process.env.PAPERCLIP_FS_SCAN_BIN?.trim() ?? "";
  if (!configured || !path.isAbsolute(configured) || configured.includes("\0")) {
    return null;
  }
  return configured;
}

/**
 * Invoke `paperclip-fs-scan <subcommand>` with JSON stdin and parse JSON stdout.
 * Callers treat a thrown error as a recoverable trigger to fall back to Node I/O.
 */
export function runFsScanJson<TResponse>(
  bin: string,
  subcommand: "file-hashes" | "machine-checks",
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

    const timer = setTimeout(() => fail(new Error("fs_scan_timeout")), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(new Error("fs_scan_stdout_overflow"));
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
      if (code !== 0) {
        reject(new Error(stderr || `fs_scan_exit_${code ?? "signal"}`));
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
