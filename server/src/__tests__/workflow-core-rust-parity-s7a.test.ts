import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
}, 120_000);

function rust(sub: string, payload: unknown): unknown {
  const stdout = execFileSync(rustBin, [sub], { input: JSON.stringify(payload), encoding: "utf8" });
  return JSON.parse(stdout);
}
function parity(sub: string, payload: unknown, ts: () => unknown) {
  expect(rust(sub, payload)).toEqual(ts());
}
function parityThrow(sub: string, payload: unknown, ts: () => unknown) {
  expect(ts).toThrow();
  expect(() => rust(sub, payload)).toThrow();
}

const refsOf = (value: unknown) => ({ references: [...collectArtifactReferences(value)] });
// Rust JSON 출력은 undefined dep id 를 null 로 낸다 — Set 원본 값만 동일하게 정규화.
const ancOf = (currentStepId: unknown, steps: unknown) => ({
  ancestors: [...(collectAncestorStepIds(currentStepId as string, steps as never) as Set<unknown>)]
    .map((v) => (v === undefined ? null : v)),
});
const toolErrs = (steps: unknown) => ({ errors: findWorkflowToolReferenceErrors(steps as never) });
const tokenOf = (value: unknown) => ({ token: readStructuralGateProducerToken(value) });
const sameOf = (l: unknown, r: unknown) =>
  ({ same: sameStructuralGateProducerToken(l as never, r as never) });
const gateOf = (step: unknown) => ({ isGate: isStructuralGateStep(step as never) });
const topoOf = (steps: unknown) => ({ errors: getStructuralTopologyErrors(steps as never) });
const GATE = (id: string, dependencies: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, type: "tool", qaType: "structural", toolNames: ["check"], dependencies, ...extra });

describe("paperclip-workflow-core Rust parity (s7a: artifact refs + structural gate)", () => {
  it("artifact-references: token scan order, dedup, nesting, non-strings", () => {
    const values: unknown[] = [
      { t: "{$steps.a.workProductPath} {$steps.b.siblingAssetsDir} {$steps.a.workProductDir}" },
      { nested: [{ x: "{$steps.z.workProductPath}" }, ["{$steps.y.workProductDir}", 5, null, true]] },
      "{$steps.s.workProductPath} {$steps..workProductDir} {$steps.s.bad} {$steps.a.workProductPath",
      "{$steps.a_b-1.workProductPath}", "no tokens", 5, true, null, [], {},
      { "2": "{$steps.b.workProductPath}", "10": "{$steps.t.workProductDir}", a: "{$steps.c.workProductPath}" },
      { deep: { deeper: ["x{$steps.d.siblingAssetsDir}y"] }, arr: [[["{$steps.e.workProductDir}"]]] },
      undefined,
    ];
    for (const value of values) parity("artifact-references", { value }, () => refsOf(value));
    // raw JSON 으로만 전달 가능한 own-key 순서 — array-index 키가 삽입 위치와 무관하게 숫자 오름차 선행.
    const raw = `{"value":{"b":"{$steps.b.workProductPath}","1":"{$steps.i.workProductDir}","a":"{$steps.a.siblingAssetsDir}","01":"{$steps.z.workProductPath}","10":"{$steps.t.workProductDir}"}}`;
    const parsed = JSON.parse(raw) as { value: unknown };
    const out = JSON.parse(execFileSync(rustBin, ["artifact-references"], { input: raw, encoding: "utf8" }));
    expect(out).toEqual({ references: [...collectArtifactReferences(parsed.value)] });
  });

  it("ancestor-step-ids: DFS discovery order, fallback fields, id coercion", () => {
    const steps = [
      { id: "a" },
      { id: "b", dependencies: ["a"] },
      { id: "c", dependencies: ["b"], conditionalDependencies: [{ stepId: "x", isBackEdge: true }, { stepId: "a" }] },
      { id: "x", dependsOn: ["b", "a"] },
      { id: "d", dependencies: ["c", "x"] },
      { id: 5, dependencies: ["a"] },
      { dependencies: ["b"] }, // id undefined — 마지막 undefined-key step 인 9 에 덮인다
      9,
      { id: "self", dependencies: ["self"] },
    ];
    for (const cur of ["d", 5, "5", "a", "self", "ghost", undefined])
      parity("ancestor-step-ids", { currentStepId: cur, steps }, () => ancOf(cur, steps));
    // dependencies:"ab" 는 문자 단위 spread, 원시 conditional edge 는 stepId=undefined dep.
    const weird = [
      { id: "s", dependencies: "ab", conditionalDependencies: [7, { stepId: "b" }] },
      { id: "a" },
      { id: "b", dependencies: ["s"] },
      { id: "n", dependencies: null, dependsOn: ["a"] },
    ];
    parity("ancestor-step-ids", { currentStepId: "s", steps: weird }, () => ancOf("s", weird));
    parity("ancestor-step-ids", { currentStepId: "n", steps: weird }, () => ancOf("n", weird));
    const dup = [{ id: "dup", dependencies: ["x"] }, { id: "dup" }, { id: "x" }];
    parity("ancestor-step-ids", { currentStepId: "dup", steps: dup }, () => ancOf("dup", dup));
    const bad: unknown[] = [
      [{ id: "s", dependencies: 5 }],
      [{ id: "s", dependencies: {} }],
      [{ id: "s", dependencies: null, dependsOn: true }],
      [{ id: "s", conditionalDependencies: [null] }],
      [{ id: "s", conditionalDependencies: "ab" }],
      [{ id: "s", conditionalDependencies: {} }],
      [null],
    ];
    for (const stepsBad of bad)
      parityThrow("ancestor-step-ids", { currentStepId: "s", steps: stepsBad }, () => ancOf("s", stepsBad));
    parityThrow("ancestor-step-ids", { currentStepId: "s", steps: {} }, () => ancOf("s", {}));
    parityThrow("ancestor-step-ids", { currentStepId: "s" }, () => ancOf("s", undefined));
  });

  it("tool-reference-errors: reason precedence, ordering, id coercion", () => {
    const steps = [
      { id: "prod" },
      { id: "mid", dependencies: ["prod"], toolArgs: { in: "{$steps.prod.workProductPath}" } },
      {
        id: "leaf",
        toolArgs: "{$steps.ghost.workProductDir} {$steps.mid.siblingAssetsDir} {$steps.leaf.workProductPath} {$steps.prod.workProductPath}",
      },
      { id: 7, toolArgs: "{$steps.prod.workProductPath}" },
      { toolArgs: "{$steps.prod.workProductPath}" },
      { id: "quiet", dependencies: ["leaf"] },
      { id: "empty", toolArgs: 5 },
    ];
    parity("tool-reference-errors", { steps }, () => toolErrs(steps));
    const depCrash = [
      { id: "a", dependencies: ["b"], toolArgs: "{$steps.b.workProductPath}" },
      { id: "b", dependencies: 5 },
    ];
    parityThrow("tool-reference-errors", { steps: depCrash }, () => toolErrs(depCrash));
    for (const stepsBad of [[null], {}, "xy"])
      parityThrow("tool-reference-errors", { steps: stepsBad }, () => toolErrs(stepsBad));
    parityThrow("tool-reference-errors", {}, () => toolErrs(undefined));
  });

  it("gate-producer-token: field coercion and integer boundary", () => {
    const values: unknown[] = [
      { producerStepId: " p ", iterationIndex: 2, completedAt: " t " },
      { producerStepId: "p", iterationIndex: 1e300, completedAt: "t", extra: 1 },
      { producerStepId: "p", iterationIndex: -3, completedAt: "t" },
      { producerStepId: "p", iterationIndex: 2.5, completedAt: "t" },
      { producerStepId: "p", iterationIndex: "2", completedAt: "t" },
      { producerStepId: "p", iterationIndex: true, completedAt: "t" },
      { producerStepId: "p", iterationIndex: null, completedAt: "t" },
      { producerStepId: "p", completedAt: "t" },
      { producerStepId: "", iterationIndex: 1, completedAt: "t" },
      { producerStepId: "  ", iterationIndex: 1, completedAt: "t" },
      { producerStepId: 5, iterationIndex: 1, completedAt: "t" },
      { producerStepId: "p", iterationIndex: 1, completedAt: "" },
      { producerStepId: "p", iterationIndex: 1, completedAt: "  " },
      { producerStepId: "p", iterationIndex: 1, completedAt: 9 },
      null, "x", 5, [1], {}, undefined,
    ];
    for (const value of values) parity("gate-producer-token", { value }, () => tokenOf(value));
  });

  it("same-producer-token: null/undefined boundary and === field semantics", () => {
    const t = { producerStepId: "p", iterationIndex: 1, completedAt: "t" };
    const cases: { left?: unknown; right?: unknown }[] = [
      { left: t, right: { ...t } },
      { left: t, right: { ...t, iterationIndex: 1.0, extra: 1 } },
      { left: t, right: { ...t, iterationIndex: "1" } },
      { left: t, right: { ...t, completedAt: "T" } },
      { left: t, right: null },
      { left: null }, // right 부재 — TS 는 left!==null 검사에서 단락 → false (미접근)
      { left: 5, right: "x" }, // 원시형은 세 필드 전부 undefined → === 통과
      { left: {}, right: [] },
      { left: t, right: {} },
    ];
    for (const c of cases) parity("same-producer-token", c, () => sameOf(c.left, c.right));
    for (const c of [{ left: t }, { right: t }, {}])
      parityThrow("same-producer-token", c, () => sameOf(c.left, c.right));
  });

  it("is-structural-gate: type/qaType/agentId/toolNames contract", () => {
    const steps: unknown[] = [
      { type: "tool", qaType: "structural", toolNames: ["x"] },
      { type: " TOOL ", qaType: " Structural ", agentId: "  ", toolNames: ["x", 5, " "] },
      { type: "tool", qaType: "structural", toolNames: ["x"], agentId: 0 },
      { type: "tool", qaType: "structural", toolNames: ["x"], agentId: "bot" },
      { type: "tool", qaType: "structural", toolNames: ["x", "y"] },
      { type: "tool", qaType: "structural", toolNames: [] },
      { type: "tool", qaType: "structural", toolNames: "x" },
      { type: "tool", qaType: "structural" },
      { type: "tool", qaType: "structuralx", toolNames: ["x"] },
      { type: "tools", qaType: "structural", toolNames: ["x"] },
      { type: "tool", qaType: "structural", toolNames: [0] },
      { type: 5, qaType: "structural", toolNames: ["x"] },
      "x", 5, null, [], undefined,
    ];
    for (const step of steps) parity("is-structural-gate", { step }, () => gateOf(step));
  });

  it("structural-topology-errors: wiring rules, message shape, ordering", () => {
    const ok = [
      { id: "p" },
      GATE("g", ["p"]),
      { id: "q", type: "qa", dependencies: ["g", "p"] },
      { id: "x", type: "action" }, // qa 아님 → dependencies 부재여도 skip
    ];
    parity("structural-topology-errors", { steps: ok }, () => topoOf(ok));
    const noGates = [{ id: "q", type: "qa" }]; // gate 없음 → early return, deps 미검사
    parity("structural-topology-errors", { steps: noGates }, () => topoOf(noGates));
    const mixed = [
      { id: "p1" }, { id: "p2" },
      GATE("g1", ["p1"]), GATE("g2", ["p1"]), GATE("g0", []), GATE("gx", ["ghost", "p2", "g1"]),
      { id: "q", type: "validator", dependencies: ["g1", "p1"] },
      { id: "q2", qaType: "plan", dependencies: ["g2"] },
      { id: "q3", type: "qa", dependencies: "gx" }, // 문자열 deps — for..of 문자 순회
      { id: "q4", type: "qa", dependencies: ["p2", "g1", "g2"] },
    ];
    parity("structural-topology-errors", { steps: mixed }, () => topoOf(mixed));
    const bad: unknown[] = [
      [{ id: "p" }, GATE("g", "p")], // gate deps 문자열 → .map TypeError
      [{ id: "p" }, GATE("g", null)],
      [{ id: "p" }, GATE("g", ["p"]), { id: "q", type: "qa" }], // qa deps 부재 → not iterable
      [{ id: "p" }, GATE("g", ["p"]), { id: "q", type: "qa", dependencies: 5 }],
      [{ id: "p" }, GATE("g", ["p"]), { id: "q", type: "qa", dependencies: {} }],
      [null],
      "xy",
    ];
    for (const stepsBad of bad)
      parityThrow("structural-topology-errors", { steps: stepsBad }, () => topoOf(stepsBad));
    parityThrow("structural-topology-errors", {}, () => topoOf(undefined));
  });
});
