import { promises as fs } from "node:fs";
import path from "node:path";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  finalizeRunLogNodeFallback,
  isRunLogEnoent,
  normalizeRunLogReadRange,
  openAppendNoCreate,
  readRunLogNodeFallback,
  resolveRunLogBin,
  RunLogHelperNotFoundError,
  runRustLogFinalize,
  runRustLogReadRange,
  warnRunLogFallback,
} from "./run-log-rust-client.js";

const STORE_LABEL = "run-log-store";
const NOT_FOUND_MESSAGE = "Run log not found";
export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export type RunLogEvent = { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string };

// The storage budget and file writer must count exactly the same UTF-8 record.
export function serializeRunLogEvent(event: RunLogEvent): string {
  return JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk }) + "\n";
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(handle: RunLogHandle, event: RunLogEvent): Promise<void>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

export function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      const absPath = resolveWithin(basePath, handle.logRef);
      let fh: fs.FileHandle;
      try {
        fh = await openAppendNoCreate(absPath);
      } catch (err) {
        // Missing .ndjson with a .gz sibling: finalized — drop quietly. Missing
        // with no .gz: mid-run deletion — rethrow so writeErrors still detects it.
        if (isRunLogEnoent(err) && (await fs.stat(`${absPath}.gz`).catch(() => null))) {
          warnRunLogFallback(STORE_LABEL, "append dropped: log already finalized to .gz", err);
          return;
        }
        throw err;
      }
      try {
        await fh.writeFile(serializeRunLogEvent(event), "utf8");
      } catch (writeErr) {
        await fh.close().catch(() => undefined);
        throw writeErr;
      }
      await fh.close().catch(() => undefined);
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const bin = resolveRunLogBin();
      if (bin) {
        try {
          return await runRustLogFinalize(bin, absPath);
        } catch (err) {
          if (err instanceof RunLogHelperNotFoundError) throw notFound(NOT_FOUND_MESSAGE);
          warnRunLogFallback(STORE_LABEL, "rust finalize failed; using Node fallback", err);
        }
      }
      return finalizeRunLogNodeFallback(absPath, NOT_FOUND_MESSAGE);
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound(NOT_FOUND_MESSAGE);
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const { offset, limitBytes } = normalizeRunLogReadRange(opts);
      const bin = resolveRunLogBin();
      if (bin) {
        try {
          return await runRustLogReadRange(bin, absPath, offset, limitBytes);
        } catch (err) {
          if (err instanceof RunLogHelperNotFoundError) throw notFound(NOT_FOUND_MESSAGE);
          warnRunLogFallback(STORE_LABEL, "rust read-range failed; using Node fallback", err);
        }
      }
      return readRunLogNodeFallback(absPath, offset, limitBytes, NOT_FOUND_MESSAGE);
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}
