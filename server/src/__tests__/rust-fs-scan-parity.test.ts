import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { countSessionFileMessages } from "@paperclipai/adapter-utils";
import { buildContextSafeFileViews, evaluateFileViewFreshness } from "../services/context-safe-file-views.js";
import { evaluateStepMachineChecks } from "../services/workflow/step-machine-checks.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/fs-scan/target/release/paperclip-fs-scan");
const origBin = process.env.PAPERCLIP_FS_SCAN_BIN;
const origMinBytes = process.env.PAPERCLIP_FS_SCAN_MIN_JSONL_BYTES;
const tempDirs: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "fs-scan-parity-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(): void {
  if (origBin === undefined) delete process.env.PAPERCLIP_FS_SCAN_BIN;
  else process.env.PAPERCLIP_FS_SCAN_BIN = origBin;
  if (origMinBytes === undefined) delete process.env.PAPERCLIP_FS_SCAN_MIN_JSONL_BYTES;
  else process.env.PAPERCLIP_FS_SCAN_MIN_JSONL_BYTES = origMinBytes;
}

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin, ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/fs-scan/Cargo.toml")], {
    encoding: "utf8",
  });
}, 120_000);

afterEach(() => {
  restoreEnv();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(restoreEnv);

describe("paperclip-fs-scan Rust parity", () => {
  it("matches countSessionFileMessages across tricky lines and falls back cleanly on missing bin", async () => {
    const dir = makeTemp();
    const file = path.join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", role: "user" }),
        '{"type":"other","type":"message"}',
        '{"type":"message","type":"other"}',
        '{"type":"message"} trailing',
        "not-json{",
        "123",
        '"message"',
        "null",
        '[{"type":"message"}]',
        JSON.stringify({ nested: { type: "message" } }),
        JSON.stringify({ type: "message", role: "assistant" }),
        JSON.stringify({ type: "message", role: "user" }),
      ].join("\n"),
      "utf8",
    );

    delete process.env.PAPERCLIP_FS_SCAN_BIN;
    const jsAll = await countSessionFileMessages(file);
    const jsStop = await countSessionFileMessages(file, { stopAfter: 2 });
    const jsMissing = await countSessionFileMessages(path.join(dir, "missing.jsonl"));
    const jsNonJsonl = await countSessionFileMessages("ses_abc123");

    process.env.PAPERCLIP_FS_SCAN_BIN = rustBin;
    process.env.PAPERCLIP_FS_SCAN_MIN_JSONL_BYTES = "0";
    expect(await countSessionFileMessages(file)).toBe(jsAll);
    expect(jsAll).toBe(4);
    expect(await countSessionFileMessages(file, { stopAfter: 2 })).toBe(jsStop);
    expect(jsStop).toBe(3);
    expect(await countSessionFileMessages(path.join(dir, "missing.jsonl"))).toBe(jsMissing);
    expect(await countSessionFileMessages("ses_abc123")).toBe(jsNonJsonl);

    process.env.PAPERCLIP_FS_SCAN_BIN = "/nonexistent/paperclip-fs-scan";
    expect(await countSessionFileMessages(file)).toBe(jsAll);
  });

  it("matches evaluateStepMachineChecks across globs, sizes, sha256, escapes, and fallback", async () => {
    const workspace = makeTemp();
    const assets = path.join(workspace, "assets");
    mkdirSync(path.join(assets, "nested"), { recursive: true });
    const binPath = path.join(assets, "payload.bin");
    const bigBuf = Buffer.alloc(8 * 1024 * 1024, 0x41);
    writeFileSync(binPath, bigBuf);
    writeFileSync(path.join(assets, "a.png"), "png-a");
    writeFileSync(path.join(assets, "nested", "b.png"), "png-b");
    const outside = path.join(makeTemp(), "outside.png");
    writeFileSync(outside, "outside");
    symlinkSync(outside, path.join(assets, "link.png"));

    const expectedSha = createHash("sha256").update(bigBuf).digest("hex");
    const checks = [
      { kind: "file_exists", path: binPath },
      { kind: "file_exists", path: assets },
      { kind: "file_exists", path: "{$steps.missing.workProductPath}" },
      { kind: "file_exists", path: "../outside.png" },
      { kind: "file_glob", dir: assets, glob: "**/*.png", minCount: 2 },
      { kind: "file_glob", dir: assets, glob: "*.png", minCount: 2 },
      { kind: "min_size_bytes", path: binPath, minBytes: bigBuf.length },
      { kind: "min_size_bytes", path: binPath, minBytes: bigBuf.length + 1 },
      { kind: "content_sha256", path: binPath, sha256: expectedSha.toUpperCase() },
      { kind: "content_sha256", path: binPath, sha256: "0".repeat(64) },
    ];
    const resolvePath = (token: string) => (token.includes("{$steps.") ? null : token);

    delete process.env.PAPERCLIP_FS_SCAN_BIN;
    const jsRes = await evaluateStepMachineChecks({ checks, resolvePath, workspaceCwd: workspace });

    process.env.PAPERCLIP_FS_SCAN_BIN = rustBin;
    const rsRes = await evaluateStepMachineChecks({ checks, resolvePath, workspaceCwd: workspace });
    expect(rsRes).toEqual(jsRes);

    process.env.PAPERCLIP_FS_SCAN_BIN = "/nonexistent/paperclip-fs-scan";
    expect(await evaluateStepMachineChecks({ checks, resolvePath, workspaceCwd: workspace })).toEqual(jsRes);
  });

  it("matches buildContextSafeFileViews and evaluateFileViewFreshness across all statuses", async () => {
    const workspace = makeTemp();
    mkdirSync(path.join(workspace, "docs"), { recursive: true });
    writeFileSync(path.join(workspace, "docs/current.md"), "same");
    writeFileSync(path.join(workspace, "docs/stale.md"), "v1");
    writeFileSync(path.join(workspace, "docs/created.md"), "new");
    writeFileSync(path.join(workspace, "docs/huge.bin"), Buffer.alloc(5 * 1024 * 1024, 0x7a));

    const wakeText = "Check docs/current.md docs/stale.md docs/missing.md docs/huge.bin";
    delete process.env.PAPERCLIP_FS_SCAN_BIN;
    const jsViews = await buildContextSafeFileViews({ text: wakeText, workspaceCwd: workspace, workspaceId: "ws-1" });
    process.env.PAPERCLIP_FS_SCAN_BIN = rustBin;
    const rsViews = await buildContextSafeFileViews({ text: wakeText, workspaceCwd: workspace, workspaceId: "ws-1" });
    expect(rsViews).toEqual(jsViews);

    writeFileSync(path.join(workspace, "docs/stale.md"), "v2");
    const viewList = [
      ...jsViews,
      { workspaceId: "ws-1", relativePath: "docs/created.md", source: "wake_comment", exists: false, contentHash: null },
      { workspaceId: "ws-1", relativePath: "../escape.md", source: "wake_comment", exists: true, contentHash: "a".repeat(64) },
    ];
    delete process.env.PAPERCLIP_FS_SCAN_BIN;
    const jsFresh = await evaluateFileViewFreshness({ views: viewList, workspaceCwd: workspace });
    process.env.PAPERCLIP_FS_SCAN_BIN = rustBin;
    const rsFresh = await evaluateFileViewFreshness({ views: viewList, workspaceCwd: workspace });
    expect(rsFresh).toEqual(jsFresh);
  });

  it("benchmarks 25 MB JSONL session message counting (JS readline vs Rust fs-scan)", async () => {
    const dir = makeTemp();
    const file = path.join(dir, "bench-25mb.jsonl");
    const filler = `${JSON.stringify({ type: "note", payload: "x".repeat(1_000) })}\n`;
    const msg = `${JSON.stringify({ type: "message", role: "assistant", payload: "y".repeat(500) })}\n`;
    const lines: string[] = [];
    for (let i = 0; i < 24_000; i += 1) {
      lines.push(i % 250 === 0 ? msg : filler);
    }
    writeFileSync(file, lines.join(""), "utf8");

    delete process.env.PAPERCLIP_FS_SCAN_BIN;
    const t0 = performance.now();
    const jsCount = await countSessionFileMessages(file);
    const jsMs = performance.now() - t0;

    process.env.PAPERCLIP_FS_SCAN_BIN = rustBin;
    process.env.PAPERCLIP_FS_SCAN_MIN_JSONL_BYTES = "0";
    const t1 = performance.now();
    const rsCount = await countSessionFileMessages(file);
    const rsMs = performance.now() - t1;

    expect(rsCount).toBe(jsCount);
    expect(rsCount).toBe(96);
    console.info(
      `[benchmark] fs-scan 25MB session JSONL: js_ms=${jsMs.toFixed(2)} rust_ms=${rsMs.toFixed(2)} speedup=${(jsMs / Math.max(rsMs, 0.01)).toFixed(2)}x`,
    );
    expect(rsMs).toBeLessThan(jsMs);
  }, 60_000);
});
