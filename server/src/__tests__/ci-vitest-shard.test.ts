/**
 * [F2 2026-11-24] scripts/ci-vitest-shard.mjs — LPT sharder + manifest gate, end-to-end.
 *
 * 왜: `vitest --shard` 는 파일 수 기준이라 60-182s 스위트 몇 개가 한 샤드를 고정시켰고,
 *   샤드 하나가 조용히 빠져도 (또는 필터가 인접 파일을 끌어들여도) CI 는 녹색이었다.
 *   이 테스트는 (a) 실제 repo 탐색 목록으로 0 omitted/0 duplicated/불균형<5% 파티션을 고정하고,
 *   (b) Vitest 자체 선택이 배정과 정확히 일치함을 증명하고, (c) spawn 실패 경로(E2BIG/SIGKILL/
 *   non-zero)와 (d) 게이트가 검증할 매니페스트 계약 위반 전부를 회귀시험한다.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertExactSelection, DEFAULT_SLOW_WEIGHTS, discoverTestFiles, extractExecutedFilesFromJsonReport,
  listShard, partitionTestFiles, resolveSpawnExitCode, runShard, verifyShardManifests,
} from "../../../scripts/ci-vitest-shard.mjs";

const repoRoot = realpathSync(join(import.meta.dirname, "../../.."));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "ci-shard-")));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const SERIAL_SUITES = [
  "server/src/__tests__/heartbeat-c5-public-activation.test.ts",
  "server/src/__tests__/qa-remediation-admission-root.test.ts",
  "server/src/__tests__/mission-owner-authority-flow.integration.test.ts",
  "server/src/__tests__/mission-owner-delegate-fix.integration.test.ts",
  "server/src/__tests__/plugin-runtime-drain.test.ts",
];
const weightOf = (f: string) => (DEFAULT_SLOW_WEIGHTS as Record<string, number>)[f] ?? 1;
const files2 = ["x/a.test.ts", "x/b.test.ts"];

describe("real repo discovery + LPT partition", () => {
  const prev = process.env.PAPERCLIP_CI_EXCLUDE_SERIAL_SUITES;
  process.env.PAPERCLIP_CI_EXCLUDE_SERIAL_SUITES = "1";
  afterAll(() => {
    if (prev === undefined) delete process.env.PAPERCLIP_CI_EXCLUDE_SERIAL_SUITES;
    else process.env.PAPERCLIP_CI_EXCLUDE_SERIAL_SUITES = prev;
  });
  const allFiles = discoverTestFiles(repoRoot);
  const shards = partitionTestFiles(allFiles, 3, DEFAULT_SLOW_WEIGHTS);
  it("discovers the real suite once, excluding exactly the 5 serial suites", () => {
    expect(allFiles.length).toBeGreaterThan(1000);
    for (const s of SERIAL_SUITES) expect(allFiles).not.toContain(s);
    expect(allFiles).toContain("server/src/__tests__/ci-vitest-shard.test.ts");
    expect(new Set(allFiles).size).toBe(allFiles.length);
  });
  it("partitions with 0 omitted, 0 duplicated, all shards non-empty, imbalance < 5%", () => {
    const flat = shards.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(new Set(flat)).toEqual(new Set(allFiles));
    const loads = shards.map((s) => s.reduce((a, f) => a + weightOf(f), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / 3;
    for (const l of loads) expect(l).toBeGreaterThan(0);
    expect((Math.max(...loads) - Math.min(...loads)) / mean).toBeLessThan(0.05);
  });
  it("vitest itself selects exactly the assigned files for every shard", { timeout: 120_000 }, () => {
    for (const shard of shards) expect(discoverTestFiles(repoRoot, shard)).toEqual(shard);
  });
});

describe("partitionTestFiles", () => {
  const weights = { "a.test.ts": 50, "b.test.ts": 40, "c.test.ts": 30, "d.test.ts": 20 };
  it("is deterministic for shuffled input and uses LPT (weight desc, path asc, lowest-index ties)", () => {
    const want = [["a.test.ts"], ["b.test.ts"], ["c.test.ts", "d.test.ts"]];
    expect(partitionTestFiles(["d.test.ts", "b.test.ts", "a.test.ts", "c.test.ts"], 3, weights)).toEqual(want);
    expect(partitionTestFiles(["a.test.ts", "c.test.ts", "d.test.ts", "b.test.ts"], 3, weights)).toEqual(want);
  });
  it("assigns everything to one shard when totalShards=1 and sorts each shard lexicographically", () => {
    expect(partitionTestFiles(["b", "a", "c"], 1)).toEqual([["a", "b", "c"]]);
  });
  it("rejects invalid shard counts", () => {
    expect(() => partitionTestFiles(["a"], 0)).toThrow(/totalShards/);
    expect(() => partitionTestFiles(["a"], 1.5)).toThrow(/totalShards/);
  });
  it("leaves later shards empty when files < shards", () => {
    expect(partitionTestFiles(files2, 3)).toEqual([["x/a.test.ts"], ["x/b.test.ts"], []]);
  });
});

describe("assertExactSelection + extractExecutedFilesFromJsonReport", () => {
  it("passes identical sets, rejects substring bleed (extra) and missing files", () => {
    const want = ["a/x.test.ts", "a/y.test.ts"];
    expect(() => assertExactSelection(want, ["a/y.test.ts", "a/x.test.ts"])).not.toThrow();
    expect(() => assertExactSelection(want, [...want, "a/x.test.ts.bak"])).toThrow(/extra/);
    expect(() => assertExactSelection(want, ["a/x.test.ts"])).toThrow(/missing/);
  });
  it("normalizes absolute testResults[].name paths and rejects malformed reports", () => {
    const p = join(sandbox, "report.json");
    writeFileSync(p, JSON.stringify({ testResults: [{ name: join(repoRoot, "server/x.test.ts") }, { name: "server/y.test.ts" }] }));
    expect(extractExecutedFilesFromJsonReport(p, repoRoot)).toEqual(["server/x.test.ts", "server/y.test.ts"]);
    writeFileSync(p, "{}");
    expect(() => extractExecutedFilesFromJsonReport(p, repoRoot)).toThrow(/testResults|invalid/);
    writeFileSync(p, JSON.stringify({ testResults: [{ name: 5 }] }));
    expect(() => extractExecutedFilesFromJsonReport(p, repoRoot)).toThrow(/invalid/);
    expect(() => extractExecutedFilesFromJsonReport(join(sandbox, "nope.json"), repoRoot)).toThrow(/unreadable/);
  });
  it("rejects duplicate executed files instead of silently collapsing them", () => {
    const p = join(sandbox, "dup-report.json");
    writeFileSync(p, JSON.stringify({ testResults: [{ name: "a.test.ts" }, { name: "a.test.ts" }] }));
    expect(() => extractExecutedFilesFromJsonReport(p, repoRoot)).toThrow(/duplicate/);
    expect(() => assertExactSelection(["a.test.ts"], ["a.test.ts", "a.test.ts"])).toThrow(/duplicate/);
  });
});

describe("spawn failure paths", () => {
  const e2big = { status: null, error: Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }) };
  const killed = { status: null, signal: "SIGKILL" };
  const exited = { status: 137 };
  it("resolveSpawnExitCode returns 0 only on a clean exit and non-zero otherwise", () => {
    expect(resolveSpawnExitCode({ status: 0 } as never, "x")).toBe(0);
    expect(resolveSpawnExitCode({ status: 0, signal: "SIGKILL" } as never, "x")).not.toBe(0);
    expect(resolveSpawnExitCode(e2big as never, "x")).toBe(1);
    expect(resolveSpawnExitCode(killed as never, "x")).toBe(1);
    expect(resolveSpawnExitCode(exited as never, "x")).toBe(137);
  });
  it("discovery throws on E2BIG / SIGKILL / non-zero status", () => {
    for (const res of [e2big, killed, exited]) {
      expect(() => discoverTestFiles(repoRoot, [], (() => res) as never)).toThrow(/vitest list failed/);
    }
  });
  it("execution propagates E2BIG / SIGKILL / non-zero status as errors", () => {
    const discover = (_r: string, sel?: string[]) => sel ?? files2;
    for (const res of [e2big, killed, exited]) {
      expect(() => runShard({ repoRoot, shardIndex: 1, totalShards: 1, commitSha: "s", discover, spawn: (() => res) as never }))
        .toThrow(/vitest run failed/);
    }
  });
});

describe("vitest list --json discovery", () => {
  it("parses the [{file, projectName}] JSON directly and keeps custom test filenames", () => {
    const spawn = (() => ({ status: 0, stdout: JSON.stringify([
      { file: join(repoRoot, "server/x/custom-suite.ts"), projectName: "@paperclipai/server" },
      { file: join(repoRoot, "server/y/spaced name.spec.tsx"), projectName: "@paperclipai/server" },
    ]) })) as never;
    expect(discoverTestFiles(repoRoot, [], spawn)).toEqual(["server/x/custom-suite.ts", "server/y/spaced name.spec.tsx"]);
  });
  it("passes --json as the final arg so file filters are never eaten as output paths", () => {
    let args: string[] = [];
    const spawn = ((_c: string, a: string[]) => ((args = a), { status: 0, stdout: "[]" })) as never;
    expect(discoverTestFiles(repoRoot, ["f.test.ts"], spawn)).toEqual([]);
    expect(args.at(-1)).toBe("--json");
  });
});

describe("runShard guards and manifest", () => {
  const discover = (_r: string, sel?: string[]) => sel ?? files2;
  it("throws (never silently passes) when unfiltered discovery returns 0 files", () => {
    expect(() => runShard({ repoRoot, shardIndex: 1, totalShards: 3, commitSha: "s", discover: () => [] })).toThrow(/0 test files/);
  });
  it("skips execute and still writes a manifest for a non-empty discovery with an empty shard", () => {
    const out = join(sandbox, "empty-shard.json");
    let ran = false;
    const code = runShard({ repoRoot, shardIndex: 3, totalShards: 3, manifestOut: out, commitSha: "s", discover, execute: () => ((ran = true), []) });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    const m = JSON.parse(readFileSync(out, "utf8"));
    expect(m).toMatchObject({ schemaVersion: 1, commitSha: "s", shardIndex: 3, totalShards: 3, discoveredFiles: files2, executedFiles: [] });
  });
  it.each([[0], [4]])("rejects invalid shard index %i/3", (shardIndex) => {
    expect(() => runShard({ repoRoot, shardIndex, totalShards: 3, commitSha: "s", discover })).toThrow(/invalid shard/);
  });
  it("rejects substring filter bleed before execute runs", () => {
    let ran = false;
    const bleed = (_r: string, sel?: string[]) => (sel ? [...sel, "x/a.test.ts.bak"] : files2);
    expect(() => runShard({ repoRoot, shardIndex: 1, totalShards: 1, commitSha: "s", discover: bleed, execute: () => ((ran = true), []) }))
      .toThrow(/extra/);
    expect(ran).toBe(false);
  });
  const jsonSpawn = (names: string[]) => ((_c: string, args: string[]) => {
    const out = args.find((a: string) => a.startsWith("--outputFile="))!.slice("--outputFile=".length);
    writeFileSync(out, JSON.stringify({ testResults: names.map((n) => ({ name: join(repoRoot, n) })) }));
    return { status: 0 };
  }) as never;
  it("runs end to end: selects, executes, cross-checks report, writes manifest", () => {
    const out = join(sandbox, "ok-shard.json");
    const code = runShard({ repoRoot, shardIndex: 1, totalShards: 1, manifestOut: out, commitSha: "s", discover, spawn: jsonSpawn(files2) });
    expect(code).toBe(0);
    const m = JSON.parse(readFileSync(out, "utf8"));
    expect(m).toMatchObject({ schemaVersion: 1, commitSha: "s", shardIndex: 1, totalShards: 1, discoveredFiles: files2 });
    expect(m.executedFiles).toEqual(files2);
  });
  it("rejects when the executed report drifts from the assigned files", () => {
    expect(() => runShard({ repoRoot, shardIndex: 1, totalShards: 1, commitSha: "s", discover, spawn: jsonSpawn([files2[0], "x/z.test.ts"]) }))
      .toThrow(/extra.*missing|missing.*extra/s);
  });
});

describe("listShard", () => {
  it("fails non-zero on empty unfiltered discovery (same contract as runShard)", () => {
    expect(() => listShard({ repoRoot, shardIndex: 1, totalShards: 3, discover: () => [] })).toThrow(/0 test files/);
    expect(() => runShard({ repoRoot, shardIndex: 1, totalShards: 3, commitSha: "s", discover: () => [] })).toThrow(/0 test files/);
  });
  it("returns the assigned shard slice deterministically", () => {
    expect(listShard({ repoRoot, shardIndex: 1, totalShards: 3, discover: () => files2 })).toEqual(["x/a.test.ts"]);
  });
});

describe("verifyShardManifests gate contract", () => {
  const mf = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, commitSha: "sha", shardIndex: 1, totalShards: 3,
    discoveredFiles: ["a.test.ts", "b.test.ts"], executedFiles: [] as string[], ...over,
  });
  const valid = () => [
    mf({ shardIndex: 1, executedFiles: ["a.test.ts"] }),
    mf({ shardIndex: 2, executedFiles: ["b.test.ts"] }),
    mf({ shardIndex: 3 }),
  ];
  it("accepts a valid schemaVersion:1 three-shard set, incl. an empty shard", () => {
    expect(() => verifyShardManifests(valid(), { expectedSha: "sha", expectedShards: 3 })).not.toThrow();
    expect(() => verifyShardManifests(valid())).not.toThrow();
  });
  it.each([
    ["empty set", []],
    ["schemaVersion != 1", [mf({ schemaVersion: 2 })]],
    ["non-integer shardIndex", [mf({ shardIndex: "1" })]],
    ["shardIndex > totalShards", [mf({ shardIndex: 4 })]],
    ["non-array discoveredFiles", [mf({ discoveredFiles: "a" })]],
    ["empty-string entry in executedFiles", [mf({ executedFiles: ["a.test.ts", ""] })]],
    ["missing shard 2", [valid()[0], valid()[2]]],
    ["rogue 1/1 manifest among 3", [...valid(), mf({ shardIndex: 1, totalShards: 1, executedFiles: [] })]],
    ["lone 1/1 set when 3 expected", [mf({ shardIndex: 1, totalShards: 1, executedFiles: ["a.test.ts", "b.test.ts"] })]],
    ["empty discoveredFiles", [mf({ discoveredFiles: [] }), mf({ shardIndex: 2, discoveredFiles: [] }), mf({ shardIndex: 3, discoveredFiles: [] })]],
    ["cross-shard duplicate", [mf({ shardIndex: 1, executedFiles: ["a.test.ts", "b.test.ts"] }), valid()[1], valid()[2]]],
    ["duplicate inside discoveredFiles", [mf({ shardIndex: 1, discoveredFiles: ["a.test.ts", "a.test.ts"] }), valid()[1], valid()[2]]],
    ["duplicate inside executedFiles", [mf({ shardIndex: 1, executedFiles: ["a.test.ts", "a.test.ts"] }), valid()[1], valid()[2]]],
    ["newline-injected discoveredFiles", [mf({ shardIndex: 1, executedFiles: ["a.test.ts"] }), mf({ shardIndex: 2, discoveredFiles: ["a.test.ts\nb.test.ts"], executedFiles: ["b.test.ts"] }), mf({ shardIndex: 3 })]],
    ["omitted file", [valid()[0], mf({ shardIndex: 2 }), valid()[2]]],
    ["unexpected executed file", [valid()[0], mf({ shardIndex: 2, executedFiles: ["b.test.ts", "z.test.ts"] }), valid()[2]]],
    ["commitSha mismatch", [valid()[0], { ...valid()[1], commitSha: "other" }, valid()[2]]],
    ["commitSha != expectedSha", valid()],
    ["discoveredFiles mismatch", [valid()[0], { ...valid()[1], discoveredFiles: ["a.test.ts", "c.test.ts"] }, valid()[2]]],
  ])("throws on %s", (_name, manifests) => {
    const opts = _name === "commitSha != expectedSha" ? { expectedSha: "different", expectedShards: 3 } : { expectedShards: 3 };
    expect(() => verifyShardManifests(manifests as never, opts)).toThrow();
  });
});
