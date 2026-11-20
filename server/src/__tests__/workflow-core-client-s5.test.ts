import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  classifyStepActivation,
  type EdgeBearingStep,
  type PredFacts,
  type StepActivation,
} from "../services/workflow/control-flow/edge-condition.js";
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import { activateStepsWithNodeFallback } from "../services/workflow/workflow-core-client-s5.js";

/**
 * [목적] Stage 5 Node 브리지(workflow-core-client-s5)의 양 팔 검증.
 *   - Node fallback 팔: WORKFLOW_CORE_RUST=0 → TS classifyStepActivation 배치 결과 그대로.
 *   - 실 Rust bin 팔: PAPERCLIP_WORKFLOW_CORE_BIN=release bin → 동일 Map.
 *   - 계약 위반(shape/stepId echo 불일치·helper 부재)은 TS 로 fallback + warn-once —
 *     fake bin 이 의도적으로 다른 페이로드를 주는 것으로 어느 팔이 응답했는지 구분한다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

let dir: string;
let wrongShapeBin: string;
let badItemBin: string;
let missingBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

beforeAll(async () => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s5-"));
  wrongShapeBin = await writeBin("wrong-shape", 'cat >/dev/null; echo "{}"');
  // 개수는 맞지만 stepId echo 가 어긋난 8개 — bad_item 판정(bad_shape 와 warn 키가 다르다).
  badItemBin = await writeBin("bad-item",
    'cat >/dev/null; echo \'{"activations":['
    + '{"stepId":"WRONG","runnable":true,"skippable":false,"waiting":false},'.repeat(7)
    + '{"stepId":"WRONG","runnable":true,"skippable":false,"waiting":false}]}\'');
  missingBin = path.join(dir, "does-not-exist");
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

// ── batch activation fixtures ─────────────────────────────────────
// entry(no edges) / ok(completed pred) / wait(pending pred) / skip(failed pred, success edge)
// rescue(failure edge 재발화) / backedge(back-edge 는 forward gate 제외)
// drwait(completed+dispatchReady=false → waiting) / closed(failed+dr=false+채널 closed → skippable)

const steps: EdgeBearingStep[] = [
  { id: "entry", dependencies: [] },
  { id: "ok", dependencies: ["a"] },
  { id: "wait", dependencies: ["b"] },
  { id: "skip", dependencies: ["c"] },
  { id: "rescue", conditionalDependencies: [{ stepId: "c", when: "failure" }] },
  {
    id: "backedge",
    dependencies: ["a"],
    conditionalDependencies: [{ stepId: "d", when: "qa_request_changes", isBackEdge: true }],
  },
  { id: "drwait", dependencies: ["e"] },
  { id: "closed", dependencies: ["f"] },
];

const preds = new Map<string, PredFacts>([
  ["a", { status: "completed", isQaGate: false, verdict: null }],
  ["b", { status: "pending", isQaGate: false, verdict: null }],
  ["c", { status: "failed", isQaGate: false, verdict: null }],
  ["d", { status: "pending", isQaGate: true, verdict: null }],
  ["e", { status: "completed", isQaGate: false, verdict: null, dispatchReady: false }],
  ["f", {
    status: "failed", isQaGate: false, verdict: null,
    dispatchReady: false, failureRecoveryChannel: "closed",
  }],
]);

function expectedMap(): Map<string, StepActivation> {
  return new Map(steps.map((step) => [step.id, classifyStepActivation(step, preds)]));
}

describe("activateStepsWithNodeFallback", () => {
  it("Node arm (WORKFLOW_CORE_RUST=0) returns the TS batch map without spawning", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin); // 스폰되면 계약 위반 — Node 팔 증명
    expect(await activateStepsWithNodeFallback(steps, preds)).toEqual(expectedMap());
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm returns the same activations as the TS classifier", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    const rustArm = await activateStepsWithNodeFallback(steps, preds);
    expect(rustArm).toEqual(expectedMap());
    expect([...rustArm.values()].map((a) => [a.runnable, a.skippable, a.waiting])).toEqual([
      [true, false, false], // entry
      [true, false, false], // ok
      [false, false, true], // wait
      [false, true, false], // skip
      [true, false, false], // rescue
      [true, false, false], // backedge
      [false, false, true], // drwait
      [false, true, false], // closed
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("Rust and Node arms are identical for a qa_request_changes back-edge verdict set", async () => {
    const qaPreds = new Map<string, PredFacts>(preds);
    qaPreds.set("d", { status: "failed", isQaGate: true, verdict: "request_changes", verdictChecked: true });
    const backEdgeStep: EdgeBearingStep[] = [{
      id: "rework",
      conditionalDependencies: [{ stepId: "d", when: "qa_request_changes" }],
    }];
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    const rustArm = await activateStepsWithNodeFallback(backEdgeStep, qaPreds);
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    const nodeArm = await activateStepsWithNodeFallback(backEdgeStep, qaPreds);
    expect(rustArm).toEqual(nodeArm);
    expect(rustArm.get("rework")).toEqual({ runnable: true, skippable: false, waiting: false });
  });

  it("empty batch returns an empty map without spawning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    expect(await activateStepsWithNodeFallback([], preds)).toEqual(new Map());
    expect(warn).not.toHaveBeenCalled();
  });

  it("contract violations fall back to the TS map and warn once", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", wrongShapeBin);
    expect(await activateStepsWithNodeFallback(steps, preds)).toEqual(expectedMap());
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", badItemBin);
    expect(await activateStepsWithNodeFallback(steps, preds)).toEqual(expectedMap());
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("activate"));
  });

  it("unavailable helper falls back to the TS map and warns once", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", missingBin);
    const first = await activateStepsWithNodeFallback(steps, preds);
    const second = await activateStepsWithNodeFallback(steps, preds);
    expect(second).toEqual(first);
    expect(first).toEqual(expectedMap());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("activate"));
  });
});
