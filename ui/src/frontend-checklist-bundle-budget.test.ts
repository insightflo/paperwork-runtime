import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Front-End-Checklist (thedaviddias) — Performance & Bundle Budget automated guard.
// `scripts/check-bundle-budget.mjs`가 ui/dist/assets 산출물의 단일 청크 예산을 강제하는지
// 임시 fixture 디렉터리로 검증한다. 예산: 단일 JS 청크 < 512kB(524,288 bytes),
// 단일 CSS 청크 < 250kB(256,000 bytes). 위반·dist 누락 시 exit 1, 통과 시 exit 0.

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/check-bundle-budget.mjs",
);

const JS_BUDGET = 512 * 1024;
const CSS_BUDGET = 550 * 1024;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(dist?: string): RunResult {
  const args = [SCRIPT_PATH];
  if (dist !== undefined) args.push("--dist", dist);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function output(result: RunResult): string {
  return result.stdout + result.stderr;
}

const tempRoots: string[] = [];

/** 임시 fixture 루트를 만들고 테스트 끝에 정리한다. */
function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-budget-fixture-"));
  tempRoots.push(root);
  return root;
}

/** fixture 루트 안에 ui/dist 와 동일한 구조의 assets 디렉터리를 만든다. */
function makeAssetsDir(root: string): string {
  const distDir = path.join(root, "dist");
  const assetsDir = path.join(distDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  return assetsDir;
}

/** 지정한 바이트 크기의 더미 에셋 파일을 쓴다. */
function writeAsset(assetsDir: string, name: string, size: number): void {
  writeFileSync(path.join(assetsDir, name), Buffer.alloc(size, 0x61));
}

function fixtureWithSizes(
  files: Array<{ name: string; size: number }>,
): { root: string; assetsDir: string } {
  const root = makeTempRoot();
  const assetsDir = makeAssetsDir(root);
  for (const file of files) writeAsset(assetsDir, file.name, file.size);
  return { root, assetsDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("frontend-checklist bundle budget guard", () => {
  it("passes (exit 0) when every js and css chunk is under budget", () => {
    const { assetsDir } = fixtureWithSizes([
      { name: "app-abc123.js", size: JS_BUDGET - 1 },
      { name: "index-def456.css", size: CSS_BUDGET - 1 },
    ]);

    const result = runScript(assetsDir.replace(`${path.sep}assets`, ""));

    expect(result.status).toBe(0);
    expect(output(result)).toMatch(/PASS/i);
  });

  it("fails (exit 1) when a single js chunk exceeds the 512kB budget", () => {
    const { root } = fixtureWithSizes([
      { name: "vendor-big-123.js", size: JS_BUDGET + 1024 },
      { name: "app-small-456.js", size: 1024 },
    ]);

    const result = runScript(path.join(root, "dist"));

    expect(result.status).toBe(1);
    const text = output(result);
    expect(text).toContain("vendor-big-123.js");
    expect(text).toMatch(/512/i);
  });

  it("fails (exit 1) when a single css chunk exceeds the 250kB budget", () => {
    const { root } = fixtureWithSizes([
      { name: "index-huge-789.css", size: CSS_BUDGET + 1024 },
    ]);

    const result = runScript(path.join(root, "dist"));

    expect(result.status).toBe(1);
    const text = output(result);
    expect(text).toContain("index-huge-789.css");
    expect(text).toMatch(/550/i);
  });

  it("treats a chunk exactly at the limit as a violation (strict <)", () => {
    const { root } = fixtureWithSizes([
      { name: "app-exact-999.js", size: JS_BUDGET },
    ]);

    const result = runScript(path.join(root, "dist"));

    expect(result.status).toBe(1);
    expect(output(result)).toContain("app-exact-999.js");
  });

  it("fails with an actionable message when the dist directory is missing", () => {
    const root = makeTempRoot();
    const missingDist = path.join(root, "no-such-dist");

    const result = runScript(missingDist);

    expect(result.status).toBe(1);
    const text = output(result);
    expect(text).toMatch(/dist/i);
    expect(text).toMatch(/build/i); // 빌드 우선 안내가 있어야 한다
  });

  it("fails when the assets directory exists but contains no js or css files", () => {
    const root = makeTempRoot();
    makeAssetsDir(root); // 비어 있는 assets

    const result = runScript(path.join(root, "dist"));

    expect(result.status).toBe(1);
    expect(output(result)).toMatch(/asset/i);
  });

  it("prints the top 5 largest assets", () => {
    const { root } = fixtureWithSizes([
      { name: "a-largest-1.js", size: 50 * 1024 },
      { name: "b-second-2.js", size: 40 * 1024 },
      { name: "c-third-3.js", size: 30 * 1024 },
      { name: "d-fourth-4.js", size: 20 * 1024 },
      { name: "e-fifth-5.js", size: 10 * 1024 },
      { name: "f-sixth-6.js", size: 5 * 1024 },
    ]);

    const result = runScript(path.join(root, "dist"));
    const text = output(result);

    expect(text).toContain("a-largest-1.js");
    expect(text).toContain("b-second-2.js");
    expect(text).toContain("c-third-3.js");
    expect(text).toContain("d-fourth-4.js");
    expect(text).toContain("e-fifth-5.js");
    expect(text).not.toContain("f-sixth-6.js");
  });
});
