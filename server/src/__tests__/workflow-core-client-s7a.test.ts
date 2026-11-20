import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  collectAncestorStepIds,
  collectArtifactReferences,
  findWorkflowToolReferenceErrors,
} from "../services/workflow/step-artifact-references.js";
import {
  isStructuralGateStep,
  readStructuralGateProducerToken,
  sameStructuralGateProducerToken,
} from "../services/workflow/control-flow/structural-gate.js";
import { getStructuralTopologyErrors } from "../services/workflow/control-flow/structural-topology.js";
import { checkStepEligibility } from "../services/workflow/resume/eligibility.js";
import { sortWorkflowStepsByPriority } from "../services/workflow/dag-step-priority.js";
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import {
  collectAncestorStepIdsWithNodeFallback,
  collectArtifactReferencesWithNodeFallback,
  checkStepEligibilityWithNodeFallback,
  findWorkflowToolReferenceErrorsWithNodeFallback,
  getStructuralTopologyErrorsWithNodeFallback,
  isStructuralGateStepWithNodeFallback,
  readStructuralGateProducerTokenWithNodeFallback,
  sameStructuralGateProducerTokenWithNodeFallback,
  sortWorkflowStepsByPriorityWithNodeFallback,
} from "../services/workflow/workflow-core-client-s7a.js";

/**
 * [목적] Stage 7A/7C Node 브리지(workflow-core-client-s7a)의 양 팔 검증.
 *   - Node fallback 팔: WORKFLOW_CORE_RUST=0 / bin 미설정 → TS 구현 결과 그대로(무음).
 *   - 실 Rust bin 팔: PAPERCLIP_WORKFLOW_CORE_BIN=release bin → TS 와 동일 결과.
 *   - canned bin: 서브커맨드별 고정 응답으로 Rust 팔 실행을 증명.
 *   - missing/malformed/wrong-shape bin → warn-once 후 TS fallback.
 *   입력별 전수 패리티(coercion·순서·edge case)는 workflow-core-rust-parity-s7a.test.ts 담당.
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
  artifact-references) echo '{"references":["rust-arm"]}' ;;
  ancestor-step-ids) echo '{"ancestors":["rust-arm"]}' ;;
  tool-reference-errors) echo '{"errors":[{"stepId":"s","referencedStepId":"rust-arm","reason":"not_ancestor"}]}' ;;
  gate-producer-token) echo '{"token":{"producerStepId":"rust-arm","iterationIndex":7,"completedAt":"c"}}' ;;
  same-producer-token) echo '{"same":false}' ;;
  is-structural-gate) echo '{"isGate":false}' ;;
  structural-topology-errors) echo '{"errors":["rust-arm"]}' ;;
  check-step-eligibility) echo '{"blocker":"active_work"}' ;;
  sort-steps-by-priority) echo '{"steps":[{"id":"c"},{"id":"a","executionControls":{"priority":"low"}},{"id":"b","executionControls":{"priority":"critical"}}]}' ;;
esac`;

beforeAll(async () => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s7a-"));
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

const TOKEN = { producerStepId: "p", iterationIndex: 2, completedAt: "t" };
const REF_VALUE = { t: "{$steps.a.workProductPath} {$steps.b.siblingAssetsDir}" };
const GATE_STEP = { id: "g", type: "tool", qaType: "structural", toolNames: ["check"] };
const STEPS = [
  { id: "a" },
  { id: "b", dependencies: ["a"], toolArgs: { in: "{$steps.a.workProductPath}" } },
  { id: "c", dependencies: ["b"], toolArgs: "{$steps.ghost.workProductDir} {$steps.c.workProductPath}" },
];
const TOPO = [
  { id: "p" },
  { id: "g", type: "tool", qaType: "structural", toolNames: ["check"], dependencies: ["p"] },
  { id: "q", type: "qa", dependencies: ["g", "p"] },
];
const HISTORY = {
  stepId: "s1", status: "pending", issueId: "i-1", startedAt: null, executionGeneration: 0,
  hasAttempt: false, hasQueue: false, hasOwner: false, hasExternalResult: false,
  effect: "none", kind: "agent",
} as never;
const PRIORITY_STEPS = [
  { id: "a", executionControls: { priority: "low" } },
  { id: "b", executionControls: { priority: "critical" } },
  { id: "c" },
] as never;

/** [서브커맨드, 브리지 호출, TS 직접 호출] — 같은 입력을 양 팔에 먹인다. */
const CASES: [string, () => Promise<unknown>, () => unknown][] = [
  ["artifact-references",
    () => collectArtifactReferencesWithNodeFallback(REF_VALUE),
    () => collectArtifactReferences(REF_VALUE)],
  ["ancestor-step-ids",
    () => collectAncestorStepIdsWithNodeFallback("c", STEPS),
    () => collectAncestorStepIds("c", STEPS)],
  ["tool-reference-errors",
    () => findWorkflowToolReferenceErrorsWithNodeFallback(STEPS),
    () => findWorkflowToolReferenceErrors(STEPS)],
  ["gate-producer-token",
    () => readStructuralGateProducerTokenWithNodeFallback({ ...TOKEN, extra: 1 }),
    () => readStructuralGateProducerToken({ ...TOKEN, extra: 1 })],
  ["same-producer-token",
    () => sameStructuralGateProducerTokenWithNodeFallback(TOKEN, { ...TOKEN }),
    () => sameStructuralGateProducerToken(TOKEN, { ...TOKEN })],
  ["is-structural-gate",
    () => isStructuralGateStepWithNodeFallback(GATE_STEP),
    () => isStructuralGateStep(GATE_STEP)],
  ["structural-topology-errors",
    () => getStructuralTopologyErrorsWithNodeFallback(TOPO),
    () => getStructuralTopologyErrors(TOPO)],
  ["check-step-eligibility",
    () => checkStepEligibilityWithNodeFallback(HISTORY),
    () => checkStepEligibility(HISTORY)],
  ["sort-steps-by-priority",
    () => sortWorkflowStepsByPriorityWithNodeFallback(PRIORITY_STEPS),
    () => sortWorkflowStepsByPriority(PRIORITY_STEPS)],
];

/** canned 응답 해석 결과 — CASES 와 같은 순서. 전부 TS 결과와 달라 Rust 팔 실행을 증명한다. */
const CANNED: unknown[] = [
  new Set(["rust-arm"]),
  new Set(["rust-arm"]),
  [{ stepId: "s", referencedStepId: "rust-arm", reason: "not_ancestor" }],
  { producerStepId: "rust-arm", iterationIndex: 7, completedAt: "c" },
  false,
  false,
  ["rust-arm"],
  "active_work",
  [PRIORITY_STEPS[2], PRIORITY_STEPS[0], PRIORITY_STEPS[1]],
];

describe("workflow-core-client-s7a bridges", () => {
  it("Node arm (WORKFLOW_CORE_RUST=0) returns TS results without spawning or warning", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin); // 스폰되면 rust-arm marker — Node 팔 증명
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("bin unset also uses Node silently on all nine", async () => {
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS implementations on all nine subcommands", async () => {
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("artifact-references"));
  });

  it("non-JSON stdout falls back with a contract warning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", garbageBin);
    expect(await CASES[2][1]()).toEqual(CASES[2][2]());
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

  it("semantic errors reject identically on both arms (Rust exit 1 → TS 재판정)", async () => {
    const badSteps = [{ id: "s", dependencies: 5 }] as never;
    await expect(collectAncestorStepIdsWithNodeFallback("s", badSteps)).rejects.toThrow();
    await expect(checkStepEligibilityWithNodeFallback(null as never)).rejects.toThrow();
    await expect(sortWorkflowStepsByPriorityWithNodeFallback(5 as never)).rejects.toThrow();
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    await expect(collectAncestorStepIdsWithNodeFallback("s", badSteps)).rejects.toThrow();
    await expect(checkStepEligibilityWithNodeFallback(null as never)).rejects.toThrow();
    await expect(sortWorkflowStepsByPriorityWithNodeFallback(5 as never)).rejects.toThrow();
  });

  it("sort-steps-by-priority remaps Rust items back to the original step objects", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin);
    const sorted = await sortWorkflowStepsByPriorityWithNodeFallback(PRIORITY_STEPS);
    expect(sorted[0]).toBe(PRIORITY_STEPS[2]); // JSON 왕복 후에도 호출자 객체 identity 유지
  });
});
