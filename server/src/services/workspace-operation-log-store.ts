import { constants as fsConstants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  normalizeRunLogReadRange,
  readGzipFileRangeNodeFallback,
  resolveRunLogBin,
  RunLogHelperNotFoundError,
  runRustLogFinalize,
  runRustLogReadRange,
  sha256GzipFileNodeFallback,
} from "./run-log-rust-client.js";

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

function isEnoent(err: unknown): boolean {
  return (err as { code?: string })?.code === "ENOENT";
}

function warnFallback(scope: string, err: unknown): void {
  console.warn(`[workspace-operation-log-store] ${scope}: ${err instanceof Error ? err.message : String(err)}`);
}

export function createLocalFileWorkspaceOperationLogStore(basePath: string): WorkspaceOperationLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    const stat = await fs.stat(filePath); // ENOENT propagates → caller tries the .gz sibling

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function readNodeFallback(absPath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    try {
      return await readFileRange(absPath, offset, limitBytes);
    } catch (err) {
      if (isEnoent(err)) {
        return readGzipFileRangeNodeFallback(`${absPath}.gz`, offset, limitBytes, NOT_FOUND_MESSAGE);
      }
      throw err;
    }
  }

  async function finalizeNodeFallback(absPath: string): Promise<WorkspaceOperationLogFinalizeSummary> {
    const stat = await fs.stat(absPath).catch(() => null);
    if (stat) {
      const sha256 = await sha256File(absPath);
      return { bytes: stat.size, sha256, compressed: false };
    }
    // The Rust helper may have renamed to .gz before a transient failure — stay idempotent.
    if (await fs.stat(`${absPath}.gz`).catch(() => null)) {
      const { bytes, sha256 } = await sha256GzipFileNodeFallback(`${absPath}.gz`);
      return { bytes, sha256, compressed: true };
    }
    throw notFound(NOT_FOUND_MESSAGE);
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
      let fh;
      try {
        // No O_CREAT: a vanished log must never resurrect into a ghost .ndjson.
        fh = await fs.open(absPath, fsConstants.O_WRONLY | fsConstants.O_APPEND);
      } catch (err) {
        if (isEnoent(err) && (await fs.stat(`${absPath}.gz`).catch(() => null))) {
          warnFallback("append dropped: log already finalized to .gz", err);
          return;
        }
        throw err;
      }
      try {
        const line = JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk });
        await fh.writeFile(`${line}\n`, "utf8");
      } finally {
        await fh.close();
      }
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
          warnFallback("rust finalize failed; using Node fallback", err);
        }
      }
      return finalizeNodeFallback(absPath);
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
          warnFallback("rust read-range failed; using Node fallback", err);
        }
      }
      return readNodeFallback(absPath, offset, limitBytes);
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
