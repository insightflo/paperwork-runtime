import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fillStructuralValidatorToolArgs,
  isDeclaredStructuralUnit,
  isPartialStructuralDeclaration,
  isStructuralGateStep,
  rewriteStepToolArgs,
  rewriteToolArgsStepReferences,
  validateStructuralTopology,
  validateStructuralUnit,
} from "../services/missions/structural-materialization.js";
import { validateDeclaredStructuralPlan } from "../services/missions/structural-plan-validation.js";

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

// Plain JSON objects model the real Map<string,string> input; other shapes pass
// through raw so both sides hit the same V8 receiver-error path.
const asMap = (m: unknown) =>
  m !== null && typeof m === "object" && !Array.isArray(m)
    ? new Map(Object.entries(m as Record<string, unknown>))
    : m;
type P = Record<string, unknown>;
const callTs = {
  "is-structural-gate-step": (p: P) => isStructuralGateStep(p.step as never),
  "is-declared-structural-unit": (p: P) => isDeclaredStructuralUnit(p.unit as never),
  "is-partial-structural-declaration": (p: P) => isPartialStructuralDeclaration(p.unit as never),
  "validate-structural-unit": (p: P) =>
    validateStructuralUnit(p.unit as never, p.title as never, p.index as never),
  "rewrite-tool-args-step-references": (p: P) =>
    rewriteToolArgsStepReferences(p.toolArgs, asMap(p.map) as never),
  "fill-structural-validator-tool-args": (p: P) => fillStructuralValidatorToolArgs(p.steps as never),
  "rewrite-step-tool-args": (p: P) => {
    const steps = structuredClone(p.steps);
    rewriteStepToolArgs(steps as never, asMap(p.map) as never);
    return steps;
  },
  "validate-structural-topology": (p: P) => validateStructuralTopology(p.steps as never),
  "validate-declared-structural-plan": (p: P) =>
    validateDeclaredStructuralPlan(p.units as never, p.draftSteps as never),
} as const;
type Sub = keyof typeof callTs;
const parity = (sub: Sub, payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[sub](payload as P)), rust(sub, payload), exact);

// Structural gate fixtures: declared (type+qaType) vs gate-step (also 1 tool, no agentId).
const gate = (id: string, deps: unknown = ["p"], extra: P = {}) =>
  ({ id, type: "tool", qaType: "structural", toolNames: ["v"], dependencies: deps, ...extra });

const cases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "is-structural-gate-step", name: "declared gate with one tool is a gate", payload: { step: gate("g") } },
  { sub: "is-structural-gate-step", name: "agentId disqualifies the gate", payload: { step: gate("g", ["p"], { agentId: "a" }) } },
  { sub: "is-structural-gate-step", name: "blank agentId still a gate", payload: { step: gate("g", ["p"], { agentId: "  " }) } },
  { sub: "is-structural-gate-step", name: "two toolNames is not a gate", payload: { step: gate("g", ["p"], { toolNames: ["a", "b"] }) } },
  { sub: "is-structural-gate-step", name: "non-string toolNames entries filtered", payload: { step: gate("g", ["p"], { toolNames: ["v", 7, " "] }) } },
  { sub: "is-structural-gate-step", name: "type/qaType trim + lowercase", payload: { step: { type: " TOOL ", qaType: "Structural", toolNames: ["v"] } } },
  { sub: "is-structural-gate-step", name: "singular toolName is not counted", payload: { step: { type: "tool", qaType: "structural", toolName: "v" } } },
  { sub: "is-structural-gate-step", name: "null step is not a gate", payload: { step: null } },
  { sub: "is-structural-gate-step", name: "missing step is not a gate", payload: {} },
  { sub: "is-structural-gate-step", name: "primitive step is not a gate", payload: { step: 7 } },
  { sub: "is-declared-structural-unit", name: "tool+structural is declared", payload: { unit: { type: "tool", qaType: "structural" } } },
  { sub: "is-declared-structural-unit", name: "case-insensitive declared", payload: { unit: { type: "TOOL", qaType: "STRUCTURAL" } } },
  { sub: "is-declared-structural-unit", name: "other qaType not declared", payload: { unit: { type: "tool", qaType: "plan" } } },
  { sub: "is-declared-structural-unit", name: "primitive unit not declared", payload: { unit: "x" } },
  { sub: "is-declared-structural-unit", name: "null unit throws type read", payload: { unit: null }, exact: true },
  { sub: "is-declared-structural-unit", name: "missing unit throws undefined type read", payload: {}, exact: true },
  { sub: "is-partial-structural-declaration", name: "structural qaType without type is partial", payload: { unit: { qaType: "structural" } } },
  { sub: "is-partial-structural-declaration", name: "non-tool type is partial", payload: { unit: { type: "action", qaType: "structural" } } },
  { sub: "is-partial-structural-declaration", name: "tool+structural is not partial", payload: { unit: { type: "tool", qaType: "structural" } } },
  { sub: "is-partial-structural-declaration", name: "empty unit is not partial", payload: { unit: {} } },
  { sub: "is-partial-structural-declaration", name: "null unit throws qaType read", payload: { unit: null }, exact: true },
  { sub: "validate-structural-unit", name: "valid structural unit passes", payload: { unit: gate("g"), title: "T", index: 0 } },
  { sub: "validate-structural-unit", name: "partial throws exact text", payload: { unit: { qaType: "structural", id: "u" }, title: "Build", index: 2 }, exact: true },
  { sub: "validate-structural-unit", name: "index fills missing id", payload: { unit: { qaType: "structural" }, title: "T", index: 3 }, exact: true },
  { sub: "validate-structural-unit", name: "missing index renders undefined", payload: { unit: { qaType: "structural" }, title: "T" }, exact: true },
  { sub: "validate-structural-unit", name: "string index interpolates", payload: { unit: { qaType: "structural" }, title: "T", index: "7" }, exact: true },
  { sub: "validate-structural-unit", name: "delegate_to_company rejected", payload: { unit: gate("g", ["p"], { toolNames: ["delegate_to_company"] }), title: "T", index: 0 }, exact: true },
  { sub: "validate-structural-unit", name: "zero tool names fails exact", payload: { unit: { type: "tool", qaType: "structural", id: "g" }, title: "T", index: 0 }, exact: true },
  { sub: "validate-structural-unit", name: "two tool names fails exact", payload: { unit: gate("g", ["p"], { toolNames: ["a", "b"] }), title: "T", index: 0 }, exact: true },
  { sub: "validate-structural-unit", name: "duplicate toolNames dedupe to one", payload: { unit: gate("g", ["p"], { toolNames: ["a", "a"] }), title: "T", index: 0 } },
  { sub: "validate-structural-unit", name: "untrimmed delegate misses exact match", payload: { unit: gate("g", ["p"], { toolNames: [" delegate_to_company "] }), title: "T", index: 0 } },
  { sub: "validate-structural-unit", name: "toolName and tools dedupe across sources", payload: { unit: { type: "tool", qaType: "structural", toolName: "v", tools: ["v"] }, title: "T", index: 0 } },
  { sub: "validate-structural-unit", name: "untrimmed tools entry defeats dedupe", payload: { unit: { type: "tool", qaType: "structural", toolName: "v", tools: [" v "] }, title: "T", index: 0 } },
  { sub: "validate-structural-unit", name: "non-structural unit skipped", payload: { unit: { type: "action" }, title: "T", index: 0 } },
  { sub: "validate-structural-unit", name: "primitive unit skipped", payload: { unit: 7, title: "T", index: 0 } },
  { sub: "rewrite-tool-args-step-references", name: "rewrites a nested object field", payload: { toolArgs: { out: "{$steps.u1.workProductPath}/x" }, map: { u1: "s1" } } },
  { sub: "rewrite-tool-args-step-references", name: "all three fields rewrite", payload: { toolArgs: ["{$steps.a.workProductPath}", "{$steps.b.workProductDir}", "{$steps.c.siblingAssetsDir}"], map: { a: "1", b: "2", c: "3" } } },
  { sub: "rewrite-tool-args-step-references", name: "greedy refId swallows dots", payload: { toolArgs: "{$steps.a.b.workProductDir}", map: { "a.b": "s9" } } },
  { sub: "rewrite-tool-args-step-references", name: "unknown field token kept", payload: { toolArgs: "{$steps.u.name}", map: { u: "s" } } },
  { sub: "rewrite-tool-args-step-references", name: "empty refId token kept", payload: { toolArgs: "{$steps..workProductPath}", map: { u: "s" } } },
  { sub: "rewrite-tool-args-step-references", name: "unterminated token kept", payload: { toolArgs: "{$steps.u.workProductPath", map: { u: "s" } } },
  { sub: "rewrite-tool-args-step-references", name: "unmapped ref kept", payload: { toolArgs: "{$steps.u.workProductPath}", map: {} } },
  { sub: "rewrite-tool-args-step-references", name: "empty-string mapping is falsy", payload: { toolArgs: "{$steps.u.workProductPath}", map: { u: "" } } },
  { sub: "rewrite-tool-args-step-references", name: "numeric mapping stringifies", payload: { toolArgs: "{$steps.u.workProductPath}", map: { u: 5 } } },
  { sub: "rewrite-tool-args-step-references", name: "null mapping is falsy", payload: { toolArgs: "{$steps.u.workProductPath}", map: { u: null } } },
  { sub: "rewrite-tool-args-step-references", name: "non-string leaves pass through", payload: { toolArgs: { a: 5, b: null, c: [true] }, map: { u: "s" } } },
  { sub: "rewrite-tool-args-step-references", name: "deeply nested rewrite", payload: { toolArgs: { a: [{ b: "{$steps.u.siblingAssetsDir}" }] }, map: { u: "s" } } },
  { sub: "rewrite-tool-args-step-references", name: "adjacent tokens rewrite", payload: { toolArgs: "{$steps.a.workProductDir}{$steps.b.workProductPath}", map: { a: "x", b: "y" } } },
  { sub: "rewrite-tool-args-step-references", name: "trailing brace survives", payload: { toolArgs: "{$steps.u.workProductPath}}", map: { u: "s" } } },
  { sub: "rewrite-tool-args-step-references", name: "null map without token is fine", payload: { toolArgs: "plain", map: null } },
  { sub: "rewrite-tool-args-step-references", name: "null map throws on token hit", payload: { toolArgs: "{$steps.u.workProductPath}", map: null }, exact: true },
  { sub: "rewrite-tool-args-step-references", name: "missing map throws on token hit", payload: { toolArgs: "{$steps.u.workProductPath}" }, exact: true },
  { sub: "rewrite-tool-args-step-references", name: "numeric map get not a function", payload: { toolArgs: "{$steps.u.workProductPath}", map: 5 }, exact: true },
  { sub: "rewrite-tool-args-step-references", name: "array map get not a function", payload: { toolArgs: "{$steps.u.workProductPath}", map: ["u"] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "declared toolArgs passes", payload: { steps: [{ id: "s", type: "tool", qaType: "structural", toolArgs: { a: 1 } }] } },
  { sub: "fill-structural-validator-tool-args", name: "missing toolArgs throws exact", payload: { steps: [{ id: "s", name: "N", type: "tool", qaType: "structural" }] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "empty object toolArgs throws", payload: { steps: [{ id: "s", type: "tool", qaType: "structural", toolArgs: {} }] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "empty array toolArgs throws", payload: { steps: [{ id: "s", type: "tool", qaType: "structural", toolArgs: [] }] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "non-empty array toolArgs passes", payload: { steps: [{ id: "s", type: "tool", qaType: "structural", toolArgs: [0] }] } },
  { sub: "fill-structural-validator-tool-args", name: "string toolArgs throws", payload: { steps: [{ id: "s", type: "tool", qaType: "structural", toolArgs: "x" }] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "missing name and id render undefined", payload: { steps: [{ type: "tool", qaType: "structural" }] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "null name falls back to id", payload: { steps: [{ id: "s", name: null, type: "tool", qaType: "structural" }] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "non-structural steps skipped", payload: { steps: [{ type: "action" }, { type: "tool", qaType: "plan" }] } },
  { sub: "fill-structural-validator-tool-args", name: "null steps throws length read", payload: { steps: null }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "missing steps throws length read", payload: {}, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "null element throws type read", payload: { steps: [null] }, exact: true },
  { sub: "fill-structural-validator-tool-args", name: "string steps iterate chars without error", payload: { steps: "ab" } },
  { sub: "fill-structural-validator-tool-args", name: "object length domain iterates indices", payload: { steps: { length: 1, 0: { id: "s", type: "tool", qaType: "structural", toolArgs: { a: 1 } } } } },
  { sub: "rewrite-step-tool-args", name: "rewrites only steps carrying toolArgs", payload: { steps: [{ id: "s1", toolArgs: "{$steps.u.workProductPath}" }, { id: "s2" }], map: { u: "s1" } } },
  { sub: "rewrite-step-tool-args", name: "empty map returns null steps untouched", payload: { steps: null, map: {} } },
  { sub: "rewrite-step-tool-args", name: "empty map returns missing steps untouched", payload: { map: {} } },
  { sub: "rewrite-step-tool-args", name: "null steps with real map throws", payload: { steps: null, map: { u: "x" } }, exact: true },
  { sub: "rewrite-step-tool-args", name: "missing steps with real map throws", payload: { map: { u: "x" } }, exact: true },
  { sub: "rewrite-step-tool-args", name: "null map throws size read", payload: { steps: [], map: null }, exact: true },
  { sub: "rewrite-step-tool-args", name: "missing map throws size read", payload: { steps: [] }, exact: true },
  { sub: "rewrite-step-tool-args", name: "numeric map throws get on token hit", payload: { steps: [{ toolArgs: "{$steps.u.workProductPath}" }], map: 5 }, exact: true },
  { sub: "rewrite-step-tool-args", name: "numeric map without tokens is a no-op", payload: { steps: [{ id: "s" }], map: 5 } },
  { sub: "rewrite-step-tool-args", name: "null element throws toolArgs read", payload: { steps: [null], map: { u: "x" } }, exact: true },
  { sub: "rewrite-step-tool-args", name: "present null toolArgs respreads step", payload: { steps: [{ id: "s", toolArgs: null }], map: { u: "x" } } },
  { sub: "rewrite-step-tool-args", name: "object length domain mutates indexed step", payload: { steps: { length: 1, 0: { toolArgs: "{$steps.u.workProductDir}" } }, map: { u: "s" } } },
  { sub: "rewrite-step-tool-args", name: "primitive steps pass through", payload: { steps: 7, map: { u: "s" } } },
  { sub: "validate-structural-topology", name: "producer gate qa chain passes", payload: { steps: [{ id: "p", dependencies: [] }, gate("g"), { id: "q", type: "qa", dependencies: ["p", "g"] }] } },
  { sub: "validate-structural-topology", name: "no gates is a pass", payload: { steps: [{ id: "a" }, { id: "b", type: "qa", dependencies: ["a"] }] } },
  { sub: "validate-structural-topology", name: "gate without producer throws exact", payload: { steps: [{ id: "p" }, gate("g", [])] }, exact: true },
  { sub: "validate-structural-topology", name: "gate with two producers throws exact", payload: { steps: [{ id: "p" }, { id: "p2" }, gate("g", ["p", "p2"])] }, exact: true },
  { sub: "validate-structural-topology", name: "gate on gate counts zero producers", payload: { steps: [{ id: "p" }, gate("g1", ["g2"]), gate("g2", ["p"])] }, exact: true },
  { sub: "validate-structural-topology", name: "gate dep missing from map counts zero", payload: { steps: [{ id: "p" }, gate("g", ["ghost"])] }, exact: true },
  { sub: "validate-structural-topology", name: "qa missing gate dependency throws exact", payload: { steps: [{ id: "p" }, gate("g"), { id: "q", type: "qa", dependencies: ["p"] }] }, exact: true },
  { sub: "validate-structural-topology", name: "qa dep on gate omits producer throws exact", payload: { steps: [{ id: "p" }, gate("g"), { id: "q", type: "qa", dependencies: ["g"] }] }, exact: true },
  { sub: "validate-structural-topology", name: "qaType contract marks qa-like", payload: { steps: [{ id: "p" }, gate("g"), { id: "q", qaType: "plan", dependencies: ["p"] }] }, exact: true },
  { sub: "validate-structural-topology", name: "non-qa reviewer ignored", payload: { steps: [{ id: "p" }, gate("g"), { id: "r", type: "action", dependencies: ["p"] }] } },
  { sub: "validate-structural-topology", name: "two missing gates join with comma", payload: { steps: [{ id: "p" }, gate("g1"), gate("g2"), { id: "q", type: "qa", dependencies: ["p"] }] }, exact: true },
  { sub: "validate-structural-topology", name: "numeric ids resolve through the map", payload: { steps: [{ id: 7 }, gate("g", [7])] } },
  { sub: "validate-structural-topology", name: "string dependencies iterate and substring-match", payload: { steps: [{ id: "p" }, gate("g"), { id: "q", type: "qa", dependencies: "pg" }] } },
  { sub: "validate-structural-topology", name: "qa without dependencies throws iterable error", payload: { steps: [{ id: "p" }, gate("g"), { id: "q", type: "qa" }] }, exact: true },
  { sub: "validate-structural-topology", name: "gate without dependencies throws map read", payload: { steps: [{ id: "p" }, { id: "g", type: "tool", qaType: "structural", toolNames: ["v"] }] }, exact: true },
  { sub: "validate-structural-topology", name: "null steps throws map read", payload: { steps: null }, exact: true },
  { sub: "validate-structural-topology", name: "missing steps throws map read", payload: {}, exact: true },
  { sub: "validate-structural-topology", name: "primitive steps throws map not a function", payload: { steps: 5 }, exact: true },
  { sub: "validate-structural-topology", name: "null element throws id read", payload: { steps: [{ id: "p" }, null] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "valid declared plan returns no errors", payload: { units: [{ id: "p" }, gate("g")] } },
  { sub: "validate-declared-structural-plan", name: "no structural intent returns early", payload: { units: [{ id: "a" }], draftSteps: 5 } },
  { sub: "validate-declared-structural-plan", name: "gate without producer errors exact", payload: { units: [{ id: "p" }, gate("g", [])] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "gate with two producers errors exact", payload: { units: [{ id: "p" }, { id: "p2" }, gate("g", ["p", "p2"])] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "gate on gate counts zero producers", payload: { units: [{ id: "p" }, gate("g1", ["g2"]), gate("g2", ["p"])] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "partial unit requires tool type", payload: { units: [{ id: "u", qaType: "structural" }, { id: "p" }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "zero tool names and zero producers", payload: { units: [{ id: "g", type: "tool", qaType: "structural" }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "delegate_to_company rejected", payload: { units: [{ id: "p" }, gate("g", ["p"], { toolNames: ["delegate_to_company"] })] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "qa missing gate dep errors exact", payload: { units: [{ id: "p" }, gate("g"), { id: "q", qaType: "plan", dependencies: ["p"] }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "qa dep on gate omits producer errors exact", payload: { units: [{ id: "p" }, gate("g"), { id: "q", type: "qa", dependencies: ["g"] }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "unitId labels a unit missing id", payload: { units: [{ unitId: "lg", type: "tool", qaType: "structural" }, { id: "p" }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "unresolved draft dep reports before producer count", payload: { units: [{ id: "g", type: "tool", qaType: "structural", toolName: "v" }, { id: "p" }], draftSteps: [{ unitId: "g", dependencies: ["ghost"] }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "draft step can supply the gate producer", payload: { units: [{ id: "p" }, { id: "g", type: "tool", qaType: "structural", toolName: "v" }], draftSteps: [{ unitId: "g", dependencies: ["p"] }] } },
  { sub: "validate-declared-structural-plan", name: "oversight producer is filtered", payload: { units: [{ id: "o", kind: "oversight" }, { id: "g", type: "tool", qaType: "structural", toolName: "v", dependencies: ["o"] }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "string unit reads empty id", payload: { units: ["x", { id: "g", type: "tool", qaType: "structural", toolName: "v", dependencies: [] }] }, exact: true },
  { sub: "validate-declared-structural-plan", name: "null draftSteps throws map read", payload: { units: [{ id: "g", type: "tool", qaType: "structural", toolName: "v" }], draftSteps: null }, exact: true },
  { sub: "validate-declared-structural-plan", name: "object draftSteps throws spread map error", payload: { units: [{ id: "g", type: "tool", qaType: "structural", toolName: "v" }], draftSteps: {} }, exact: true },
  { sub: "validate-declared-structural-plan", name: "string draftSteps throws spread map error", payload: { units: [{ id: "g", type: "tool", qaType: "structural", toolName: "v" }], draftSteps: "ab" }, exact: true },
  { sub: "validate-declared-structural-plan", name: "null units throws filter read", payload: { units: null }, exact: true },
  { sub: "validate-declared-structural-plan", name: "missing units throws filter read", payload: {}, exact: true },
  { sub: "validate-declared-structural-plan", name: "primitive units throws filter not a function", payload: { units: 5 }, exact: true },
  { sub: "validate-declared-structural-plan", name: "null unit throws qaType read", payload: { units: [null] }, exact: true },
];

describe("structural-materialization + topology: TS vs paperclip-mission-core", () => {
  for (const c of cases) {
    it(`parity ${c.sub}: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});
