import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalFileRunLogStore, type RunLogHandle } from "../services/run-log-store.js";
import {
  createLocalFileWorkspaceOperationLogStore,
  type WorkspaceOperationLogHandle,
} from "../services/workspace-operation-log-store.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/run-log/target/release/paperclip-run-log");
const origBin = process.env.PAPERCLIP_RUN_LOG_BIN;
const tempDirs: string[] = [];
type AnyStore = ReturnType<typeof createLocalFileRunLogStore>
  | ReturnType<typeof createLocalFileWorkspaceOperationLogStore>;

const ev = (chunk: string) => ({ stream: "stdout" as const, chunk, ts: "2026-01-01T00:00:00.000Z" });

function makeTemp(): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "run-log-parity-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(): void {
  if (origBin === undefined) delete process.env.PAPERCLIP_RUN_LOG_BIN;
  else process.env.PAPERCLIP_RUN_LOG_BIN = origBin;
}

async function pageAll(
  store: AnyStore,
  handle: RunLogHandle | WorkspaceOperationLogHandle,
  limitBytes: number,
): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const res = await store.read(handle, { offset, limitBytes });
    parts.push(res.content);
    if (res.nextOffset === undefined) return parts.join("");
    offset = res.nextOffset;
  }
  throw new Error("pagination did not terminate");
}

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/run-log/Cargo.toml")],
    { encoding: "utf8" },
  );
}, 240_000);

afterEach(() => {
  restoreEnv();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(restoreEnv);

describe("paperclip-run-log Rust parity", () => {
  it("live .ndjson pagination parity (TS vs Rust) for both log stores", async () => {
    const dir = makeTemp();
    const runStore = createLocalFileRunLogStore(dir);
    const wsStore = createLocalFileWorkspaceOperationLogStore(dir);
    const runHandle = await runStore.begin({ companyId: "c1", agentId: "a1", runId: "r1" });
    const wsHandle = await wsStore.begin({ companyId: "c1", operationId: "op1" });
    for (const chunk of ["line 🚀 emoji\n", `second ${"x".repeat(300)}\n`, "", "tail\n"]) {
      await runStore.append(runHandle, ev(chunk));
      await wsStore.append(wsHandle, ev(chunk));
    }
    const rawPath = path.join(dir, runHandle.logRef);
    const size = statSync(rawPath).size;
    // identical wire format → identical file bytes for both stores
    expect(statSync(path.join(dir, wsHandle.logRef)).size).toBe(size);

    const cases: Array<{ offset?: number; limitBytes?: number }> = [
      { offset: 0, limitBytes: 17 },
      { offset: 5, limitBytes: 2 },   // leading bytes of 🚀 → identical � on both
      { offset: 6, limitBytes: 2 },   // interior continuation bytes of 🚀
      { offset: size, limitBytes: 64 },
      { offset: size + 9, limitBytes: 64 },
      { offset: 0, limitBytes: 0 },   // clamps to 1
      { offset: 0, limitBytes: -5 },  // clamps to 1
      { offset: 0, limitBytes: 1.7 }, // truncates to 1
      { offset: -3, limitBytes: 10 }, // clamps to 0
      {},
    ];
    for (const opts of cases) {
      delete process.env.PAPERCLIP_RUN_LOG_BIN;
      const tsRun = await runStore.read(runHandle, opts);
      const tsWs = await wsStore.read(wsHandle, opts);
      process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
      expect(await runStore.read(runHandle, opts)).toEqual(tsRun);
      expect(await wsStore.read(wsHandle, opts)).toEqual(tsWs);
    }
    delete process.env.PAPERCLIP_RUN_LOG_BIN;
    const tsAll = await pageAll(runStore, runHandle, 1000);
    process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
    expect(await pageAll(runStore, runHandle, 1000)).toBe(tsAll);
    expect(tsAll).toBe(readFileSync(rawPath, "utf8"));

    // tiny files: 0-byte and 1-byte logs agree on both paths
    const empty = await runStore.begin({ companyId: "c1", agentId: "a1", runId: "r2" });
    const oneByte = await runStore.begin({ companyId: "c1", agentId: "a1", runId: "r3" });
    await runStore.append(oneByte, ev("x"));
    for (const h of [empty, oneByte]) {
      delete process.env.PAPERCLIP_RUN_LOG_BIN;
      const tsRes = await runStore.read(h, {});
      process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
      expect(await runStore.read(h, {})).toEqual(tsRes);
    }
  }, 60_000);

  it("finalize via Rust compresses to .gz with identical bytes/sha256 and exact transcript", async () => {
    const dir = makeTemp();
    const store = createLocalFileRunLogStore(dir);
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "big" });
    const absPath = path.join(dir, handle.logRef);
    const line = `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", stream: "stdout", chunk: "compress-me ".repeat(40) })}\n`;
    const raw = line.repeat(Math.ceil((4 * 1024 * 1024) / line.length));
    writeFileSync(absPath, raw, "utf8");
    const expectedSha = createHash("sha256").update(raw).digest("hex");

    process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
    const t0 = performance.now();
    const summary = await store.finalize(handle);
    const rustMs = performance.now() - t0;

    expect(summary).toEqual({ bytes: Buffer.byteLength(raw), sha256: expectedSha, compressed: true });
    expect(existsSync(absPath)).toBe(false);
    const gzPath = `${absPath}.gz`;
    expect(statSync(gzPath).size).toBeLessThan(Buffer.byteLength(raw) * 0.2);
    // idempotent: a second finalize over the existing .gz reports the same stats
    expect(await store.finalize(handle)).toEqual(summary);
    // full pagination through the compressed log reproduces the exact transcript
    expect(await pageAll(store, handle, 256_000)).toBe(raw);
    console.info(
      `[benchmark] run-log 4MB finalize + gzip vs baseline: rust_ms=${rustMs.toFixed(2)} ` +
      `gz_bytes=${statSync(gzPath).size} raw_bytes=${Buffer.byteLength(raw)}`,
    );
  }, 120_000);

  it("rolls back to pure Node .gz streaming reads when the Rust bin disappears", async () => {
    const dir = makeTemp();
    const store = createLocalFileRunLogStore(dir);
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "roll" });
    for (const chunk of ["alpha\n", "bravo 🚀 chunk\n", `gamma ${"z".repeat(200_000)}\n`, "omega\n"]) {
      await store.append(handle, ev(chunk));
    }
    const raw = readFileSync(path.join(dir, handle.logRef), "utf8");
    process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
    expect((await store.finalize(handle)).compressed).toBe(true);

    const windows = [
      { offset: 0, limitBytes: 777 },
      { offset: 777, limitBytes: 150_001 },
      { offset: 227_778, limitBytes: 999_999 },
    ];
    const oracle: unknown[] = [];
    for (const w of windows) oracle.push(await store.read(handle, w));

    delete process.env.PAPERCLIP_RUN_LOG_BIN; // Rust gone → Node streaming .gz fallback
    for (const [i, w] of windows.entries()) {
      expect(await store.read(handle, w)).toEqual(oracle[i]);
    }
    expect(await pageAll(store, handle, 128_000)).toBe(raw);
  }, 60_000);

  it("append() after finalize never resurrects a ghost .ndjson (both stores)", async () => {
    const dir = makeTemp();
    const store = createLocalFileRunLogStore(dir);
    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "ghost" });
    await store.append(handle, ev("recorded\n"));
    const absPath = path.join(dir, handle.logRef);
    process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
    await store.finalize(handle);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.append(handle, ev("late chunk\n"));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(existsSync(absPath)).toBe(false);
    expect(await pageAll(store, handle, 256_000)).not.toContain("late chunk");

    const wsStore = createLocalFileWorkspaceOperationLogStore(dir);
    const wsHandle = await wsStore.begin({ companyId: "c1", operationId: "ghost-op" });
    await wsStore.append(wsHandle, ev("recorded\n"));
    await wsStore.finalize(wsHandle);
    const wsAbs = path.join(dir, wsHandle.logRef);
    await wsStore.append(wsHandle, ev("late\n"));
    expect(existsSync(wsAbs)).toBe(false);
    expect((await wsStore.read(wsHandle, {})).content).not.toContain("late");
  }, 60_000);

  it("maps missing logs to 404 and falls back safely on an invalid bin", async () => {
    const dir = makeTemp();
    const store = createLocalFileRunLogStore(dir);
    const missing = { store: "local_file" as const, logRef: "c1/a1/missing.ndjson" };
    process.env.PAPERCLIP_RUN_LOG_BIN = rustBin;
    await expect(store.read(missing)).rejects.toMatchObject({ status: 404 });
    await expect(store.finalize(missing)).rejects.toMatchObject({ status: 404 });
    delete process.env.PAPERCLIP_RUN_LOG_BIN;
    await expect(store.read(missing)).rejects.toMatchObject({ status: 404 });

    const handle = await store.begin({ companyId: "c1", agentId: "a1", runId: "ok" });
    await store.append(handle, ev("alive\n"));
    process.env.PAPERCLIP_RUN_LOG_BIN = "/nonexistent/paperclip-run-log"; // spawn ENOENT → TS fallback
    expect((await store.read(handle, {})).content).toContain("alive");
    expect((await store.finalize(handle)).compressed).toBe(false);
    process.env.PAPERCLIP_RUN_LOG_BIN = "relative/not-absolute"; // ignored → pure TS
    expect((await store.read(handle, {})).content).toContain("alive");
  }, 60_000);
});
