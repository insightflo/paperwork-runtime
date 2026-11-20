import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assignReservedQaStepIds,
  buildCanonicalRevisionDelta,
  collectClosureConflicts,
  collectIdentityOnlyViolations,
  collectStepOverrideViolations,
  parseRevisionReusePlanRecord,
  projectReuseStepToUnit,
  resolveReuseClosure,
} from "../services/missions/revision-reuse-plan.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/mission-core/target/release/paperclip-mission-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/mission-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
function ts(fn: () => unknown): Outcome {
  try {
    const v = fn();
    return { threw: false, value: v === undefined ? null : v };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
function rust(subcommand: string, payload: unknown): Outcome {
  const res = spawnSync(rustBin, [subcommand], {
    input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
function expectParity(t: Outcome, r: Outcome, exactError = false): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw) {
    expect(r.value).toEqual(t.value);
  } else if (exactError) {
    expect(r.error).toBe(t.error);
  }
}

const callTs = {
  "parse-reuse-plan-record": (p: Record<string, unknown>) => parseRevisionReusePlanRecord(p.refs),
  "collect-identity-only-violations": (p: Record<string, unknown>) =>
    collectIdentityOnlyViolations(p.authoredUnits as Record<string, unknown>[], new Set(p.reuseUnitIds as string[])),
  "collect-closure-conflicts": (p: Record<string, unknown>) => collectClosureConflicts({
    closureUnitIds: p.closureUnitIds as string[],
    reuseRootUnitIds: new Set(p.reuseRootUnitIds as string[]),
    authoredUnits: p.authoredUnits as Record<string, unknown>[],
    deltaUnits: p.deltaUnits as { unitId: string; operation: string }[],
  }),
  "collect-step-override-violations": (p: Record<string, unknown>) =>
    collectStepOverrideViolations(p.decisionSteps, new Set(p.closureUnitIds as string[])),
  "resolve-reuse-closure": (p: Record<string, unknown>) =>
    resolveReuseClosure(p.sourceSteps as never[], p.roots as string[]),
  "project-reuse-step-to-unit": (p: Record<string, unknown>) => projectReuseStepToUnit(p.step as never),
  "assign-reserved-qa-step-ids": (p: Record<string, unknown>) => {
    const r = assignReservedQaStepIds(p as never);
    return r.ok
      ? { ok: true, qaStepIdByUnitId: Object.fromEntries(r.qaStepIdByUnitId), finalQaStepId: r.finalQaStepId }
      : r;
  },
  "build-canonical-revision-delta": (p: Record<string, unknown>) =>
    buildCanonicalRevisionDelta(p.rawDelta as Record<string, unknown>, p.closureUnitIds as string[]),
} as const;
type Sub = keyof typeof callTs;
const parity = (sub: Sub, payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[sub](payload as Record<string, unknown>)), rust(sub, payload), exact);

const S = "mission-revision-reuse.v1";
const rec = (o: Record<string, unknown>) => ({ refs: { revisionReusePlan: { schemaVersion: S, sourceWorkflowRunId: "run-1", roots: ["a"], closureUnitIds: ["a"], ...o } } });
const step = (id: unknown, extra: Record<string, unknown> = {}) => ({ id, name: `S ${id}`, agentId: "ag-1", ...extra });
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const delta = (units: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: UUID,
  base: { workflowDefinitionId: UUID, snapshotHash: "a".repeat(64) }, units, ...extra,
});

const cases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "parse-reuse-plan-record", name: "valid record", payload: rec({ roots: ["a", "b"], closureUnitIds: ["b", "a", "c"] }) },
  { sub: "parse-reuse-plan-record", name: "root outside closure rejected", payload: rec({ roots: ["a", "x"], closureUnitIds: ["a", "b"] }) },
  { sub: "parse-reuse-plan-record", name: "missing/non-object/wrong-version/empty-field shapes all null", payload: rec({ schemaVersion: "v2" }) },
  { sub: "parse-reuse-plan-record", name: "non-array roots and closure read null", payload: rec({ roots: "a" }) },
  { sub: "parse-reuse-plan-record", name: "non-string entries filtered; blank string dropped, whitespace kept", payload: rec({ roots: ["", " ", 7], closureUnitIds: [" "] }) },
  { sub: "parse-reuse-plan-record", name: "non-object refs and record read null", payload: { refs: [1, 2] } },
  { sub: "collect-identity-only-violations", name: "extra fields listed in JS own-key order", payload: { authoredUnits: [{ id: "a", sourceStepId: "a", z: 1, "10": 2, "2": 3 }], reuseUnitIds: ["a"] } },
  { sub: "collect-identity-only-violations", name: "id !== sourceStepId contract message", payload: { authoredUnits: [{ id: "a", sourceStepId: "b" }], reuseUnitIds: ["a"] } },
  { sub: "collect-identity-only-violations", name: "missing/non-string sourceStepId contract message", payload: { authoredUnits: [{ id: "a" }, { id: "b", sourceStepId: 5 }], reuseUnitIds: ["a", "b"] } },
  { sub: "collect-identity-only-violations", name: "non-reuse units and non-string ids skipped", payload: { authoredUnits: [{ id: "a", extra: 1 }, { id: 7 }, "x"], reuseUnitIds: ["b"] } },
  { sub: "collect-identity-only-violations", name: "over-200-char id fails contract", payload: { authoredUnits: [{ id: "a".repeat(201), sourceStepId: "a".repeat(201) }], reuseUnitIds: ["a".repeat(201)] } },
  { sub: "collect-identity-only-violations", name: "null unit throws TypeError text", payload: { authoredUnits: [null], reuseUnitIds: [] }, exact: true },
  { sub: "collect-identity-only-violations", name: "non-iterable authoredUnits throws", payload: { authoredUnits: 5, reuseUnitIds: [] }, exact: true },
  { sub: "collect-identity-only-violations", name: "non-iterable reuseUnitIds throws on the TS side too", payload: { authoredUnits: [], reuseUnitIds: 5 }, exact: true },
  { sub: "collect-closure-conflicts", name: "authored-only, delta-only and both claims ordered by closure", payload: { closureUnitIds: ["a", "b", "c"], reuseRootUnitIds: [], authoredUnits: [{ id: "a" }, { id: "c" }], deltaUnits: [{ unitId: "b", operation: "modify" }, { unitId: "c", operation: "add" }] } },
  { sub: "collect-closure-conflicts", name: "reuse roots exempt even when claimed", payload: { closureUnitIds: ["a", "b"], reuseRootUnitIds: ["a", "b"], authoredUnits: [{ id: "a" }], deltaUnits: [{ unitId: "a", operation: "reuse" }] } },
  { sub: "collect-closure-conflicts", name: "no claims no diagnostics", payload: { closureUnitIds: ["a"], reuseRootUnitIds: [], authoredUnits: [{ id: "z" }], deltaUnits: [] } },
  { sub: "collect-closure-conflicts", name: "strict === matching (5 vs \"5\")", payload: { closureUnitIds: [5, "5"], reuseRootUnitIds: [], authoredUnits: [{ id: 5 }], deltaUnits: [{ unitId: "5", operation: "modify" }] } },
  { sub: "collect-closure-conflicts", name: "null authored unit throws", payload: { closureUnitIds: ["a"], reuseRootUnitIds: [], authoredUnits: [null], deltaUnits: [] }, exact: true },
  { sub: "collect-closure-conflicts", name: "null delta unit throws", payload: { closureUnitIds: ["a"], reuseRootUnitIds: [], authoredUnits: [], deltaUnits: [null] }, exact: true },
  { sub: "collect-closure-conflicts", name: "non-array deltaUnits throws", payload: { closureUnitIds: ["a"], reuseRootUnitIds: [], authoredUnits: [], deltaUnits: 5 }, exact: true },
  { sub: "collect-closure-conflicts", name: "non-iterable closure throws", payload: { closureUnitIds: {}, reuseRootUnitIds: [], authoredUnits: [], deltaUnits: [] }, exact: true },
  { sub: "collect-closure-conflicts", name: "string closure iterates chars", payload: { closureUnitIds: "ab", reuseRootUnitIds: [], authoredUnits: [{ id: "a" }], deltaUnits: [] } },
  { sub: "collect-step-override-violations", name: "indexed diagnostics for matching unitId", payload: { decisionSteps: [{ unitId: "a" }, { unitId: "z" }, { id: "a" }], closureUnitIds: ["a"] } },
  { sub: "collect-step-override-violations", name: "null unitId falls back to id; empty string does not", payload: { decisionSteps: [{ unitId: null, id: "b" }, { unitId: "", id: "a" }], closureUnitIds: ["a", "b"] } },
  { sub: "collect-step-override-violations", name: "non-object and non-string-unitId entries skipped", payload: { decisionSteps: [null, 5, "x", [{}], { unitId: 5 }], closureUnitIds: ["a", "5"] } },
  { sub: "collect-step-override-violations", name: "non-array decisionSteps yields []", payload: { decisionSteps: "nope", closureUnitIds: ["a"] } },
];

const steps = [
  step("a"), step("b", { dependencies: ["a"] }),
  step("c", { dependencies: ["b", "a"] }),
  step("qa", { conditionalDependencies: [{ stepId: "c", when: "qa_request_changes", isBackEdge: true }] }),
];
const graphCases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "resolve-reuse-closure", name: "snapshot order with shared ancestors deduped", payload: { sourceSteps: steps, roots: ["c", "b"] } },
  { sub: "resolve-reuse-closure", name: "back-edge deps are not traversed", payload: { sourceSteps: steps, roots: ["qa"] } },
  { sub: "resolve-reuse-closure", name: "truthy non-boolean isBackEdge still skipped", payload: { sourceSteps: [step("a"), step("b", { conditionalDependencies: [{ stepId: "a", isBackEdge: "yes" }] })], roots: ["b"] } },
  { sub: "resolve-reuse-closure", name: "forward conditional edges followed; dangling dep ok", payload: { sourceSteps: [step("a"), step("b", { conditionalDependencies: [{ stepId: "a", when: "failure" }] }), step("c", { dependencies: ["b", "ghost"] })], roots: ["c"] } },
  { sub: "resolve-reuse-closure", name: "missing root invalid", payload: { sourceSteps: [step("a")], roots: ["x"] } },
  { sub: "resolve-reuse-closure", name: "object root invalid with [object Object]", payload: { sourceSteps: [step("a")], roots: [{ x: 1 }] } },
  { sub: "resolve-reuse-closure", name: "forward cycle reports node id", payload: { sourceSteps: [step("a", { dependencies: ["b"] }), step("b", { dependencies: ["a"] })], roots: ["a"] } },
  { sub: "resolve-reuse-closure", name: "numeric root matches numeric step id", payload: { sourceSteps: [step(5)], roots: [5] } },
  { sub: "resolve-reuse-closure", name: "string roots iterate chars", payload: { sourceSteps: [step("a")], roots: "a" } },
  { sub: "resolve-reuse-closure", name: "non-array sourceSteps throws", payload: { sourceSteps: {}, roots: [] }, exact: true },
  { sub: "resolve-reuse-closure", name: "null step throws TypeError text", payload: { sourceSteps: [null], roots: ["a"] }, exact: true },
  { sub: "resolve-reuse-closure", name: "non-iterable roots throws", payload: { sourceSteps: [step("a")], roots: 9 }, exact: true },
  { sub: "project-reuse-step-to-unit", name: "full step projection", payload: { step: step("s1", { name: "Research", dependencies: ["x"], conditionalDependencies: [{ stepId: "y", isBackEdge: true }, { stepId: "z" }], toolNames: ["t1", "t2"], toolArgs: { k: 1 }, workProductSelectors: [{ s: 1 }], knowledgeBaseIds: ["kb"], contract: { must: ["m"] }, type: "action" }) } },
  { sub: "project-reuse-step-to-unit", name: "blank agentId omitted; empty type kept; null toolArgs kept", payload: { step: step("a", { agentId: "   ", type: "", toolArgs: null }) } },
  { sub: "project-reuse-step-to-unit", name: "toolNames copied verbatim incl non-strings", payload: { step: step("a", { toolNames: ["t", 5, null] }) } },
  { sub: "project-reuse-step-to-unit", name: "missing id drops identity fields but keeps reason text", payload: { step: { name: "n", dependencies: [] } } },
  { sub: "project-reuse-step-to-unit", name: "non-object step projects bare unit", payload: { step: 7 } },
  { sub: "project-reuse-step-to-unit", name: "null step throws TypeError text", payload: { step: null }, exact: true },
  { sub: "assign-reserved-qa-step-ids", name: "qa unit claims id; remainder becomes final", payload: { reservedQaStepIds: ["q1", "q2"], authoredUnits: [{ id: "u", sourceStepId: "q1", type: "qa" }] } },
  { sub: "assign-reserved-qa-step-ids", name: "qaType contract qualifies; all claimed leaves null final", payload: { reservedQaStepIds: ["q1"], authoredUnits: [{ id: "u", sourceStepId: "q1", qaType: "delivery" }] } },
  { sub: "assign-reserved-qa-step-ids", name: "non-qa claimant rejected", payload: { reservedQaStepIds: ["q1"], authoredUnits: [{ id: "u", sourceStepId: "q1", type: "action" }] } },
  { sub: "assign-reserved-qa-step-ids", name: "duplicate claim collides", payload: { reservedQaStepIds: ["q1"], authoredUnits: [{ id: "a", sourceStepId: "q1", type: "qa" }, { id: "b", sourceStepId: "q1", qaType: "plan" }] } },
  { sub: "assign-reserved-qa-step-ids", name: "multiple unclaimed ids rejected", payload: { reservedQaStepIds: ["q1", "q2"], authoredUnits: [{ id: "u", sourceStepId: "other" }] } },
  { sub: "assign-reserved-qa-step-ids", name: "string reserved iterates chars; numeric reserved id unclaimed", payload: { reservedQaStepIds: "q5", authoredUnits: [{ id: "u", sourceStepId: "q" }] } },
  { sub: "assign-reserved-qa-step-ids", name: "non-iterable reserved throws", payload: { reservedQaStepIds: 5, authoredUnits: [] }, exact: true },
  { sub: "assign-reserved-qa-step-ids", name: "non-iterable authoredUnits throws", payload: { reservedQaStepIds: [], authoredUnits: {} }, exact: true },
];

const deltaCases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "build-canonical-revision-delta", name: "closure ancestors appended; existing kept", payload: { rawDelta: delta([{ unitId: "a", operation: "modify", instructions: "x" }]), closureUnitIds: ["a", "b", "c"] } },
  { sub: "build-canonical-revision-delta", name: "undeclared unit keys stripped on success", payload: { rawDelta: delta([{ unitId: "a", operation: "add", extra: "x", instructions: "i" }]), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "strict root rejects extra key → verbatim", payload: { rawDelta: delta([{ unitId: "a", operation: "add" }], { bogus: 1 }), closureUnitIds: ["b"] } },
  { sub: "build-canonical-revision-delta", name: "reuse unit carrying authored field → verbatim", payload: { rawDelta: delta([{ unitId: "a", operation: "reuse", sourceStepId: "a", instructions: "no" }]), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "reuse without/aliased sourceStepId → verbatim", payload: { rawDelta: delta([{ unitId: "a", operation: "reuse" }, { unitId: "b", operation: "reuse", sourceStepId: "c" }]), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "bad uuid and uppercase snapshot hash → verbatim", payload: { rawDelta: delta([{ unitId: "a", operation: "add" }], { sourceWorkflowRunId: "nope" }), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "uppercase snapshot hash → verbatim", payload: { rawDelta: delta([{ unitId: "a", operation: "add" }], { base: { workflowDefinitionId: UUID, snapshotHash: "A".repeat(64) } }), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "empty units array → verbatim", payload: { rawDelta: delta([], {}), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "requiredInputs sanitized; capabilityRequirements stay raw", payload: { rawDelta: delta([{ unitId: "a", operation: "add", requiredInputs: [{ fromUnitId: "b", selector: { x: 1 }, junk: 9 }] }], { capabilityRequirements: [{ unitId: "a", requiredOutcomeId: "o", toolName: "t", capability: "c", junk: 2 }] }), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "numeric closure id appended verbatim", payload: { rawDelta: delta([{ unitId: "a", operation: "reuse", sourceStepId: "a" }]), closureUnitIds: [5, "a"] } },
  { sub: "build-canonical-revision-delta", name: "collectionScope validated", payload: { rawDelta: delta([{ unitId: "a", operation: "add", collectionScope: "forever" }]), closureUnitIds: [] } },
  { sub: "build-canonical-revision-delta", name: "non-array closureUnitIds with valid delta throws", payload: { rawDelta: delta([{ unitId: "a", operation: "add" }]), closureUnitIds: 5 }, exact: true },
  { sub: "build-canonical-revision-delta", name: "null rawDelta passthrough", payload: { rawDelta: null, closureUnitIds: ["a"] } },
];

describe("revision-reuse-plan: TS vs paperclip-mission-core", () => {
  for (const c of [...cases, ...graphCases, ...deltaCases]) {
    it(`parity ${c.sub}: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});
