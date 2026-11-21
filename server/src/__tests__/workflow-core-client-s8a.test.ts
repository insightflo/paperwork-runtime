import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { forwardReachable } from "../services/workflow/resume/graph.js";
import {
  normalizeWorkflowStepContract,
  normalizeWorkflowStepMachineChecks,
} from "../services/workflow/step-contract.js";
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import {
  forwardReachableWithNodeFallback,
  normalizeWorkflowStepContractWithNodeFallback,
  normalizeWorkflowStepMachineChecksWithNodeFallback,
} from "../services/workflow/workflow-core-client-s8a.js";

/**
 * [목적] Stage 8A Node 브리지(workflow-core-client-s8a)의 양 팔 검증.
 *   - Node fallback 팔: WORKFLOW_CORE_RUST=0 / bin 미설정 → TS 구현 결과 그대로(무음).
 *   - 실 Rust bin 팔: PAPERCLIP_WORKFLOW_CORE_BIN=release bin → TS 와 동일 결과.
 *   - canned bin: 서브커맨드별 고정 응답으로 Rust 팔 실행을 증명.
 *   - missing/malformed/wrong-shape bin → warn-once 후 TS fallback.
 *   입력별 전수 패리티(coercion·순서·edge case)는 workflow-core-rust-parity-s8a.test.ts 담당.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

let dir: string;
let cannedBin: string;
let wrongShapeBin: string;
let garbageBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

const CANNED_SCRIPT = `cat >/dev/null
case "$1" in
  forward-reachable) echo '{"reachable":["rust-arm"]}' ;;
  normalize-step-contract) echo '{"contract":{"preconditions":["rust-arm"]}}' ;;
  normalize-step-machine-checks) echo '{"machineChecks":[{"kind":"file_exists","path":"rust-arm"}]}' ;;
esac`;

beforeAll(async () => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s8a-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  wrongShapeBin = await writeBin("wrong-shape", 'cat >/dev/null; echo "{}"');
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("WORKFLOW_CORE_RUST", ""); // 게이트 열림(unset 과 동급)
  vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", ""); // 기본: bin 미설정
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetWorkflowCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const GRAPH = [
  { id: "a", dependencies: [], conditionalDependencies: [] },
  { id: "b", dependencies: ["a"], conditionalDependencies: [{ stepId: "a" }] },
  { id: "c", dependencies: ["b"], conditionalDependencies: [] },
] as never;
const CONTRACT_VALUE = {
  preconditions: ["  a  ", " "],
  machineChecks: [{ kind: "file_exists", path: " p " }, { kind: "nope" }],
};
const CHECKS_VALUE = [
  { kind: "file_exists", path: "p" },
  { kind: "file_glob", dir: "d", glob: "g", minCount: 3 },
  { kind: "nope" },
];

/** [서브커맨드, 브리지 호출, TS 직접 호출] — 같은 입력을 양 팔에 먹인다. */
const CASES: [string, () => Promise<unknown>, () => unknown][] = [
  ["forward-reachable",
    () => forwardReachableWithNodeFallback(GRAPH, "a"),
    () => forwardReachable(GRAPH, "a")],
  ["normalize-step-contract",
    () => normalizeWorkflowStepContractWithNodeFallback(CONTRACT_VALUE),
    () => normalizeWorkflowStepContract(CONTRACT_VALUE)],
  ["normalize-step-machine-checks",
    () => normalizeWorkflowStepMachineChecksWithNodeFallback(CHECKS_VALUE),
    () => normalizeWorkflowStepMachineChecks(CHECKS_VALUE)],
];

/** canned 응답 해석 결과 — CASES 와 같은 순서. 전부 TS 결과와 달라 Rust 팔 실행을 증명한다. */
const CANNED: unknown[] = [
  ["rust-arm"],
  { preconditions: ["rust-arm"] },
  [{ kind: "file_exists", path: "rust-arm" }],
];

describe("workflow-core-client-s8a bridges", () => {
  it("Node arm (WORKFLOW_CORE_RUST=0) returns TS results without spawning or warning", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin); // 스폰되면 rust-arm marker — Node 팔 증명
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("bin unset also uses Node silently on all three", async () => {
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS implementations on all three subcommands", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned Rust output is returned verbatim (Rust 팔 실행 증명)", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
    for (const [index, [name, run]] of CASES.entries()) {
      expect(await run(), name).toEqual(CANNED[index]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("missing binary falls back to TS and warns once per subcommand", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", path.join(dir, "does-not-exist"));
    const [, run, ts] = CASES[0];
    expect(await run()).toEqual(ts());
    expect(await run()).toEqual(ts());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("forward-reachable"));
  });

  it("non-JSON stdout falls back with a contract warning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", garbageBin);
    expect(await CASES[1][1]()).toEqual(CASES[1][2]());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workflow_core_bad_json"));
  });

  it("wrong-shape stdout falls back per subcommand with a contract warning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).toHaveBeenCalledTimes(CASES.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_shape"));
  });

  it("null contract/checks results pass through both arms identically", async () => {
    for (const bin of ["", rustBin]) {
      warn.mockClear();
      resetWorkflowCoreFallbackWarningsForTests();
      vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", bin);
      expect(await normalizeWorkflowStepContractWithNodeFallback(5)).toBeNull();
      expect(await normalizeWorkflowStepMachineChecksWithNodeFallback(5)).toBeUndefined();
    }
  });

  it("semantic errors reject identically on both arms (Rust exit 1 → TS 재판정)", async () => {
    const missingDeps = [{ id: "a" }] as never; // for..of TypeError
    const dupIds = [
      { id: "a", dependencies: [], conditionalDependencies: [] },
      { id: "a", dependencies: [], conditionalDependencies: [] },
    ] as never;
    const cycled = [
      { id: "a", dependencies: ["b"], conditionalDependencies: [] },
      { id: "b", dependencies: ["a"], conditionalDependencies: [] },
    ] as never;
    for (const nodes of [missingDeps, dupIds, cycled]) {
      await expect(forwardReachableWithNodeFallback(nodes, "a")).rejects.toThrow();
    }
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    for (const nodes of [missingDeps, dupIds, cycled]) {
      await expect(forwardReachableWithNodeFallback(nodes, "a")).rejects.toThrow();
    }
  });
});
