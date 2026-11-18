import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureArtifactRoot, digest, readArtifactBytes, readArtifactDigest } from "../services/workflow/artifact-files.js";
import { createArtifactDirectory, writeArtifactFile } from "../services/workflow/artifact-writer.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/artifact-io/target/release/paperclip-artifact-io");
const origBin = process.env.PAPERCLIP_ARTIFACT_IO_BIN;
const tempDirs: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "artifact-io-parity-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin, ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/artifact-io/Cargo.toml")], {
    encoding: "utf8",
  });
}, 120_000);

afterEach(() => {
  if (origBin === undefined) delete process.env.PAPERCLIP_ARTIFACT_IO_BIN;
  else process.env.PAPERCLIP_ARTIFACT_IO_BIN = origBin;
  for (const dir of tempDirs.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+w", dir]);
    } catch {
      // ignore chmod failures during cleanup
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (origBin === undefined) delete process.env.PAPERCLIP_ARTIFACT_IO_BIN;
  else process.env.PAPERCLIP_ARTIFACT_IO_BIN = origBin;
});

describe("paperclip-artifact-io Rust parity", () => {
  it("writes and reads binary files, readonly dirs, and exclusive targets identically", async () => {
    process.env.PAPERCLIP_ARTIFACT_IO_BIN = rustBin;
    const base = makeTemp();
    const rootDir = path.join(base, "base");
    mkdirSync(rootDir);
    const root = await captureArtifactRoot(rootDir);
    const payload = Buffer.from([0, 1, 128, 255, 10]);

    const targetRoot = await createArtifactDirectory(
      root,
      "runs/qa/attempt-1",
      [
        { relative: "input/content.bin", bytes: payload },
        { relative: "result.json", bytes: Buffer.from('{"ok":true}') },
      ],
      ["input", "."],
    );

    expect(targetRoot.path).toBe(path.join(rootDir, "runs/qa/attempt-1"));
    expect(statSync(path.join(targetRoot.path, "input")).mode & 0o777).toBe(0o500);
    expect(statSync(targetRoot.path).mode & 0o777).toBe(0o500);

    const readBack = await readArtifactBytes(targetRoot, "input/content.bin", 1024);
    expect(readBack).toEqual(payload);
    expect(await readArtifactDigest(path.join(targetRoot.path, "result.json"))).toBe(digest('{"ok":true}'));

    chmodSync(targetRoot.path, 0o700);
    await writeArtifactFile(targetRoot, "result.json", Buffer.from('{"ok":true}'));
    await expect(writeArtifactFile(targetRoot, "result.json", Buffer.from("mutated"))).rejects.toThrow("artifact_file_conflict");
    await expect(createArtifactDirectory(root, "runs/qa/attempt-1", [], [])).rejects.toThrow();
  });

  it("rejects leaf/parent symlinks, fifo, oversize, root swap, and traversal identically", async () => {
    process.env.PAPERCLIP_ARTIFACT_IO_BIN = rustBin;
    const base = makeTemp();
    const rootDir = path.join(base, "root");
    const outsideDir = path.join(base, "outside");
    mkdirSync(rootDir);
    mkdirSync(outsideDir);
    writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(rootDir, "leaf-link"));
    symlinkSync(outsideDir, path.join(rootDir, "dir-link"));
    execFileSync("mkfifo", [path.join(rootDir, "pipe.fifo")]);
    writeFileSync(path.join(rootDir, "big.txt"), "123456");

    const root = await captureArtifactRoot(rootDir);
    for (const rel of ["leaf-link", "dir-link/secret.txt", "pipe.fifo", "../outside/secret.txt"]) {
      await expect(readArtifactBytes(root, rel, 64)).rejects.toThrow();
    }
    await expect(readArtifactBytes(root, "big.txt", 5)).rejects.toThrow();

    renameSync(rootDir, `${rootDir}-old`);
    mkdirSync(rootDir);
    writeFileSync(path.join(rootDir, "big.txt"), "ok");
    await expect(readArtifactBytes(root, "big.txt", 64)).rejects.toThrow("artifact_root_replaced");
    await expect(createArtifactDirectory(root, "attempt-2", [], [])).rejects.toThrow("artifact_root_replaced");
    expect(readdirSync(outsideDir)).toEqual(["secret.txt"]);
  });

  it("rejects malformed PAPERCLIP_ARTIFACT_IO_BIN fail-closed", async () => {
    process.env.PAPERCLIP_ARTIFACT_IO_BIN = "relative/binary";
    const base = makeTemp();
    const root = await captureArtifactRoot(base);
    writeFileSync(path.join(base, "a.txt"), "hi");
    await expect(readArtifactBytes(root, "a.txt", 64)).rejects.toThrow("artifact_io_bin_invalid");
  });

  it("benchmarks nested directory write+read latency (JS node -e vs Rust artifact-io)", async () => {
    const base = makeTemp();
    const jsRootDir = path.join(base, "js");
    const rsRootDir = path.join(base, "rs");
    mkdirSync(jsRootDir);
    mkdirSync(rsRootDir);
    const jsRoot = await captureArtifactRoot(jsRootDir);
    const rsRoot = await captureArtifactRoot(rsRootDir);
    const sample = Buffer.from('{"status":"verified","bytes":123}');
    const runs = 10;

    delete process.env.PAPERCLIP_ARTIFACT_IO_BIN;
    const t0 = performance.now();
    for (let i = 0; i < runs; i += 1) {
      const target = await createArtifactDirectory(jsRoot, `a/b/c/attempt-${i}`, [{ relative: "r/out.json", bytes: sample }], []);
      await readArtifactBytes(target, "r/out.json", 4096);
    }
    const jsMeanMs = (performance.now() - t0) / runs;

    process.env.PAPERCLIP_ARTIFACT_IO_BIN = rustBin;
    const t1 = performance.now();
    for (let i = 0; i < runs; i += 1) {
      const target = await createArtifactDirectory(rsRoot, `a/b/c/attempt-${i}`, [{ relative: "r/out.json", bytes: sample }], []);
      await readArtifactBytes(target, "r/out.json", 4096);
    }
    const rustMeanMs = (performance.now() - t1) / runs;

    console.info(
      `[benchmark] artifact-io 4-level write+read: js_mean_ms=${jsMeanMs.toFixed(2)} rust_mean_ms=${rustMeanMs.toFixed(2)} speedup=${(jsMeanMs / Math.max(rustMeanMs, 0.01)).toFixed(2)}x`,
    );
    expect(rustMeanMs).toBeLessThan(jsMeanMs);
  }, 60_000);
});
