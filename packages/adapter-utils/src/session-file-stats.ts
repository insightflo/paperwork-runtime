import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_MIN_JSONL_BYTES = 256 * 1024;

function resolveFsScanSessionBin(fileSizeBytes: number): string | null {
  const configured = process.env.PAPERCLIP_FS_SCAN_BIN?.trim() ?? "";
  if (!configured || !path.isAbsolute(configured) || configured.includes("\0")) return null;
  const rawMin = process.env.PAPERCLIP_FS_SCAN_MIN_JSONL_BYTES?.trim();
  const parsedMin = rawMin !== undefined && rawMin !== "" ? Number(rawMin) : NaN;
  const minBytes = Number.isFinite(parsedMin) && parsedMin >= 0 ? parsedMin : DEFAULT_MIN_JSONL_BYTES;
  return fileSizeBytes >= minBytes ? configured : null;
}

async function countViaFsScan(
  bin: string,
  filePath: string,
  stopAfter: number | undefined,
): Promise<{ count: number | null } | null> {
  try {
    const { execFile } = await import("node:child_process");
    const args = ["session-count", "--file", filePath];
    if (stopAfter !== undefined) args.push("--stop-after", String(stopAfter));
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, out) => {
          if (error) reject(error);
          else resolve(out);
        },
      );
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const count = (parsed as { count?: unknown }).count;
    if (count === null || (typeof count === "number" && Number.isInteger(count) && count >= 0)) {
      return { count };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * [session hygiene] pi 계열 어댑터의 sessionId는 세션 JSONL 파일 경로다.
 *   최상위 type==="message" 엔트리 수(≈ 대화 메시지 수)를 센다.
 *   파일이 아니거나 읽을 수 없으면 null (해당 어댑터는 이 트리거에서 제외).
 */
export async function countSessionFileMessages(
  sessionId: string | null | undefined,
  options: { stopAfter?: number } = {},
): Promise<number | null> {
  const value = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!value || !path.isAbsolute(value) || !value.endsWith(".jsonl")) return null;
  let stat;
  try {
    stat = await fs.stat(value);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return 0;

  const fsScanBin = resolveFsScanSessionBin(stat.size);
  if (fsScanBin) {
    const accelerated = await countViaFsScan(fsScanBin, value, options.stopAfter);
    if (accelerated !== null) return accelerated.count;
  }

  const stream = fsSync.createReadStream(value, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let failed = false;
  stream.on("error", () => {
    failed = true;
    lines.close();
  });
  let count = 0;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry: unknown = JSON.parse(trimmed);
        if (
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
          && (entry as { type?: unknown }).type === "message"
        ) {
          count += 1;
          if (options.stopAfter !== undefined && count > options.stopAfter) break;
        }
      } catch {
        // malformed line — 개수에 반영하지 않고 건너뛴다
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return failed ? null : count;
}
