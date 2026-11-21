import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  hasDependencyDeclaration,
  readStepDeclaredDependencyUnitIds,
  readUnitId,
} from "../services/missions/revision-plan-declaration-targets.js";

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
  "read-unit-id": (p: Record<string, unknown>) => readUnitId(p.unit as Record<string, unknown>),
  "has-dependency-declaration": (p: Record<string, unknown>) =>
    hasDependencyDeclaration(p.unit as Record<string, unknown>),
  "read-step-declared-dependency-unit-ids": (p: Record<string, unknown>) => [
    ...readStepDeclaredDependencyUnitIds(
      p.decision as Record<string, unknown>,
      p.declaredUnits as Record<string, unknown>[],
    ),
  ],
} as const;
type Sub = keyof typeof callTs;
const parity = (sub: Sub, payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[sub](payload as Record<string, unknown>)), rust(sub, payload), exact);

const cases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "read-unit-id", name: "trims id incl FEFF/NBSP boundaries", payload: { unit: { id: "\uFEFF a \u00A0" } } },
  { sub: "read-unit-id", name: "missing id, blank and non-string ids read null", payload: { unit: { id: "  " } } },
  { sub: "read-unit-id", name: "numeric id reads null", payload: { unit: { id: 5 } } },
  { sub: "read-unit-id", name: "non-object units read null", payload: { unit: ["x", "y"] } },
  { sub: "read-unit-id", name: "string unit reads null", payload: { unit: "ab" } },
  { sub: "read-unit-id", name: "null unit throws V8 text", payload: { unit: null }, exact: true },
  { sub: "read-unit-id", name: "missing unit throws V8 text", payload: {}, exact: true },
  { sub: "has-dependency-declaration", name: "own dep key counts even when value is null", payload: { unit: { dependsOn: null } } },
  { sub: "has-dependency-declaration", name: "each dep key counts", payload: { unit: { after: [] } } },
  { sub: "has-dependency-declaration", name: "non-dep keys do not count", payload: { unit: { id: "a", units: ["a"] } } },
  { sub: "has-dependency-declaration", name: "non-object receivers read false", payload: { unit: "dependencies" } },
  { sub: "has-dependency-declaration", name: "array receiver reads false", payload: { unit: ["dependencies"] } },
  { sub: "has-dependency-declaration", name: "null receiver throws V8 text", payload: { unit: null }, exact: true },
  { sub: "has-dependency-declaration", name: "missing receiver throws V8 text", payload: {}, exact: true },
];

const D = "read-step-declared-dependency-unit-ids";
const mainCases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: D, name: "canonical ids and sole-owner alias resolve, deduped first-hit", payload: {
    declaredUnits: [{ id: "a", unitId: "al" }, { id: "b" }],
    decision: { steps: [{ units: ["b", "al", "a", "ghost"], dependencies: [] }] } } },
  { sub: D, name: "ambiguous alias dropped", payload: {
    declaredUnits: [{ id: "x", unitId: "dup" }, { id: "y", unitId: "dup" }, { id: "w" }],
    decision: { steps: [{ units: ["dup", "w"], dependsOn: [] }] } } },
  { sub: D, name: "canonical id wins over another unit's alias", payload: {
    declaredUnits: [{ id: "m", unitId: "clash" }, { id: "clash" }],
    decision: { steps: [{ units: ["clash"], after: null }] } } },
  { sub: D, name: "sourceRef alias resolves to sole owner", payload: {
    declaredUnits: [{ id: "a", sourceRef: { issueId: "src-1" } }],
    decision: { steps: [{ units: ["src-1"], dependencies: [] }] } } },
  { sub: D, name: "shared sourceRef alias is ambiguous", payload: {
    declaredUnits: [{ id: "a", sourceRef: { id: "src" } }, { id: "b", sourceRef: { id: "src" } }],
    decision: { steps: [{ units: ["src"], dependsOn: [] }] } } },
  { sub: D, name: "empty units array falls through to target keys in fixed order", payload: {
    declaredUnits: [{ id: "u" }, { id: "e" }, { id: "s" }, { id: "z" }],
    decision: { steps: [{ units: [], id: "z", selectedExecutionUnitId: "s", executionUnitId: "e", unitId: "u", after: [] }] } } },
  { sub: D, name: "same target across keys dedupes", payload: {
    declaredUnits: [{ id: "u" }],
    decision: { steps: [{ unitId: "u", id: "u", executionUnitId: "u", dependencies: [] }] } } },
  { sub: D, name: "malformed units yields no targets and blocks fallback", payload: {
    declaredUnits: [{ id: "a" }],
    decision: { steps: [{ units: "a", unitId: "a", dependsOn: [] }] } } },
  { sub: D, name: "units entry non-string or blank rejects whole declaration", payload: {
    declaredUnits: [{ id: "a" }],
    decision: { steps: [{ units: ["a", 5], dependsOn: [] }, { units: ["a", " "], dependsOn: [] }] } } },
  { sub: D, name: "steps without dep keys and non-object steps are skipped", payload: {
    declaredUnits: [{ id: "a" }],
    decision: { steps: [null, "x", 5, ["a"], { units: ["a"] }, { id: "a" }, { units: ["a"], after: null }] } } },
  { sub: D, name: "first-hit order across multiple steps", payload: {
    declaredUnits: [{ id: "a" }, { id: "b" }],
    decision: { steps: [{ units: ["b"], after: [] }, { unitId: "a", dependsOn: [] }, { units: ["b", "a"], dependencies: [] }] } } },
  { sub: D, name: "non-array steps yields empty", payload: {
    declaredUnits: [{ id: "a" }], decision: { steps: {} } } },
  { sub: D, name: "missing steps yields empty", payload: {
    declaredUnits: [{ id: "a" }], decision: {} } },
  { sub: D, name: "non-object decision reads undefined steps", payload: {
    declaredUnits: [{ id: "a" }], decision: 5 } },
  { sub: D, name: "units lacking valid id are skipped; string declaredUnits iterates chars", payload: {
    declaredUnits: "ab", decision: { steps: [{ units: ["a"], dependsOn: [] }] } } },
  { sub: D, name: "non-string and array unit entries are skipped", payload: {
    declaredUnits: [{ id: 5 }, "x", [{ id: "a" }], { id: "a" }],
    decision: { steps: [{ units: ["a"], dependsOn: [] }] } } },
  { sub: D, name: "null declared unit throws V8 text", payload: {
    declaredUnits: [null], decision: { steps: [] } }, exact: true },
  { sub: D, name: "non-iterable declaredUnits throws V8 text", payload: {
    declaredUnits: 5, decision: { steps: [] } }, exact: true },
  { sub: D, name: "object declaredUnits throws V8 text", payload: {
    declaredUnits: {}, decision: { steps: [] } }, exact: true },
  { sub: D, name: "missing declaredUnits throws V8 text", payload: {
    decision: { steps: [] } }, exact: true },
  { sub: D, name: "null decision throws V8 steps text", payload: {
    declaredUnits: [], decision: null }, exact: true },
  { sub: D, name: "missing decision throws V8 steps text", payload: {
    declaredUnits: [] }, exact: true },
  { sub: D, name: "declaredUnits iteration error precedes decision read", payload: {
    declaredUnits: {}, decision: null }, exact: true },
];

describe("revision-plan-declaration-targets: TS vs paperclip-mission-core", () => {
  for (const c of [...cases, ...mainCases]) {
    it(`parity ${c.sub}: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});
