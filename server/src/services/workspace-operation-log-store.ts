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

const STORE_LABEL = "workspace-operation-log-store";
const NOT_FOUND_MESSAGE = "Workspace operation log not found";
export type WorkspaceOperationLogStoreType = "local_file";

export interface WorkspaceOperationLogHandle {
  store: WorkspaceOperationLogStoreType;
  logRef: string;
}

export interface WorkspaceOperationLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface WorkspaceOperationLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface WorkspaceOperationLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface WorkspaceOperationLogStore {
  begin(input: { companyId: string; operationId: string }): Promise<WorkspaceOperationLogHandle>;
  append(
    handle: WorkspaceOperationLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(handle: WorkspaceOperationLogHandle): Promise<WorkspaceOperationLogFinalizeSummary>;
  read(handle: WorkspaceOperationLogHandle, opts?: WorkspaceOperationLogReadOptions): Promise<WorkspaceOperationLogReadResult>;
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

export function createLocalFileWorkspaceOperationLogStore(basePath: string): WorkspaceOperationLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  return {
    async begin(input) {
      const [companyId] = safeSegments(input.companyId);
      const operationId = safeSegments(input.operationId)[0]!;
      const relDir = companyId;
      const relPath = path.join(relDir, `${operationId}.ndjson`);
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
        // Whether finalized to .gz or vanished cleanly, never resurrect a ghost
        // .ndjson and never throw ENOENT into the workspace-operations catch.
        if (isRunLogEnoent(err)) {
          warnRunLogFallback(STORE_LABEL, "append dropped: log missing or already finalized", err);
          return;
        }
        throw err;
      }
      try {
        const line = JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk });
        await fh.writeFile(`${line}\n`, "utf8");
      } catch (writeErr) {
        await fh.close().catch(() => undefined);
        throw writeErr;
      }
      await fh.close();
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

let cachedStore: WorkspaceOperationLogStore | null = null;

export function getWorkspaceOperationLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
  cachedStore = createLocalFileWorkspaceOperationLogStore(basePath);
  return cachedStore;
}
