import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  isMissionPlanUnitMaterialized,
  normalizeMissionPlanDependencyGraph,
  remapCanonicalDependenciesToStepIds,
} from "../services/missions/mission-plan-dependency-graph.js";

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
const normalize = normalizeMissionPlanDependencyGraph as (units: unknown, draftSteps?: unknown) => unknown;
const materialized = isMissionPlanUnitMaterialized as (unit: unknown) => unknown;
const remap = remapCanonicalDependenciesToStepIds as (units: unknown, stepIds: unknown) => unknown;

function ts(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function rustRaw(subcommand: string, stdin: string): Outcome {
  const res = spawnSync(rustBin, [subcommand], { input: stdin, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
const rust = (subcommand: string, payload: unknown) => rustRaw(subcommand, JSON.stringify(payload));

function unwrap(o: Outcome): unknown {
  if (o.threw) throw new Error(`expected ok, got error: ${o.error}`);
  return o.value;
}

function expectParity(t: Outcome, r: Outcome, exactError = false): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw && !r.threw) {
    expect(r.value).toEqual(t.value);
    return;
  }
  if (t.threw && r.threw && exactError) {
    expect(r.error).toBe(t.error);
  }
}

const U = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `[U] ${id}`, ...extra });

const normalizeCases: Array<{ name: string; units: unknown; draftSteps?: unknown; exactError?: boolean }> = [
  {
    name: "merges alias/dep forms and normalizes draft steps (full graph equality)",
    units: [
      U("a", { unitId: "legacy-a", sourceRef: { id: "src-a" } }),
      U("b", { dependsOn: ["legacy-a"] }),
      U("c", { after: ["b"], dependencies: ["a", "a"] }),
      U("d"),
      U("e", { kind: "oversight", dependencies: ["d"] }),
    ],
    draftSteps: [
      { unitId: "d", dependencies: ["c"] },
      { units: [], unitId: "b", dependsOn: ["a"] },
      { units: ["e"], dependsOn: ["c"] },
      "plain step",
      { id: "note", title: "no dep keys" },
      7,
      ["x", "y"],
    ],
  },
  {
    name: "ordered diagnostics: policy on units+steps, then missing, then duplicate ids",
    units: [{ deliveryVerification: {}, dependsOn: [] }, U("dup"), U("dup"), {}],
    draftSteps: [{ capAcceptance: null }],
  },
  {
    name: "invalid shapes on unit deps and draft targets each emit their own diagnostic",
    units: [U("a", { dependencies: "x" }), U("b", { dependsOn: [1, "c"] }), U("c", { after: null })],
    draftSteps: [{ units: "nope", dependsOn: ["a"] }, { unitId: 5, after: ["a"] }],
  },
  {
    name: "ambiguous + unresolved refs report in declaration order",
    units: [
      U("a", { sourceRef: { id: "s" } }),
      U("b", { sourceRef: { id: "s" } }),
      U("c", { dependencies: ["s", "ghost", "a"] }),
    ],
  },
  {
    name: "canonical ids win over conflicting provenance aliases",
    units: [
      U("a", { sourceRef: { id: "x" } }),
      U("b", { sourceRef: { id: "x" } }),
      U("x", { dependencies: ["a"] }),
      U("c", { dependencies: ["x"] }),
    ],
  },
  {
    name: "self dependency plus an independent 3-cycle report together",
    units: [
      U("a", { dependencies: ["c"] }),
      U("b", { dependencies: ["a"] }),
      U("c", { dependencies: ["b"] }),
      U("d", { dependencies: ["d"] }),
    ],
  },
  {
    name: "4-cycle renders the full rotated path in order",
    units: [
      U("a", { dependencies: ["b"] }),
      U("b", { dependencies: ["c"] }),
      U("c", { dependencies: ["d"] }),
      U("d", { dependencies: ["a"] }),
    ],
  },
  {
    name: "materialized unit may not depend on filtered oversight",
    units: [U("action", { dependencies: ["gate"] }), U("gate", { kind: "oversight" })],
  },
  {
    name: "filtered metadata edges back into materialized work are allowed",
    units: [
      U("w"),
      U("ov", { kind: "oversight", dependencies: ["w"] }),
      U("cc", { sourceRef: { type: "external_company_mission", id: "r1" }, dependencies: ["w", "ov"] }),
    ],
  },
  {
    name: "draft declaration with no target ref",
    units: [U("a"), U("b")],
    draftSteps: [{ dependsOn: ["a"] }],
  },
  {
    name: "blank-string dep entries are invalid; empty dep arrays pass",
    units: [U("a", { dependencies: ["  ", "b"] }), U("b", { dependencies: [] })],
  },
  { name: "null units collection throws", units: null, draftSteps: [] },
  { name: "string units collection throws", units: "x" },
  { name: "null unit entry throws the TS TypeError text", units: [null], exactError: true },
  { name: "null draft step entry throws the TS TypeError text", units: [U("a")], draftSteps: [null], exactError: true },
  { name: "explicit null draftSteps is not the missing-arg default", units: [U("a")], draftSteps: null },
  { name: "non-object unit entries report missing_unit_id, not a throw", units: [42, "str", [1]], draftSteps: [] },
];

const materializedCases: Array<{ name: string; unit: unknown; exactError?: boolean }> = [
  { name: "plain unit materializes", unit: U("w") },
  { name: "oversight type + escalation trigger is filtered", unit: U("o", { type: "oversight", triggerOn: "escalation" }) },
  { name: "oversight type without the escalation trigger materializes", unit: U("o", { type: "oversight" }) },
  { name: "oversight kind filters only when type is absent", unit: U("o", { kind: "oversight" }) },
  { name: "oversight kind is ignored when type is present", unit: U("o", { type: "tool", kind: "oversight" }) },
  { name: "kind matching trims and lowercases", unit: U("o", { kind: "  OVERSIGHT " }) },
  { name: "structural tool units materialize", unit: U("s", { type: "tool", qaType: "structural" }) },
  {
    name: "structural beats oversight detection",
    unit: U("s", { type: "tool", qaType: "structural", kind: "oversight", triggerOn: "escalation" }),
  },
  { name: "cross-company kind filters", unit: U("x", { kind: "cross_company_mission_request" }) },
  { name: "cross-company sourceRef.type filters", unit: U("x", { sourceRef: { type: "external_company_mission" } }) },
  { name: "non-object sourceRef is ignored", unit: U("x", { sourceRef: "cross_company_mission" }) },
  { name: "escalation comparison is case-sensitive", unit: U("o", { type: "oversight", triggerOn: "Escalation" }) },
  { name: "primitive unit materializes", unit: 42 },
  { name: "string unit materializes", unit: "abc" },
  { name: "null throws the TS TypeError text", unit: null, exactError: true },
  { name: "missing unit key throws", unit: undefined },
];

const remapCases: Array<{ name: string; units: unknown; stepIds: unknown; exactError?: boolean }> = [
  {
    name: "chains remap to generated step ids",
    units: [{ id: "a", dependencies: [] }, { id: "b", dependencies: ["a"] }, { id: "c", dependencies: ["b"] }],
    stepIds: ["s1", "s2", "s3"],
  },
  { name: "length mismatch throws", units: [{ id: "a" }], stepIds: [], exactError: true },
  { name: "unmapped dependency throws its name", units: [{ id: "a", dependencies: ["ghost"] }], stepIds: ["s1"], exactError: true },
  { name: "falsy step id (empty string) throws", units: [{ id: "a", dependencies: ["b"] }, { id: "b" }], stepIds: ["s1", ""], exactError: true },
  { name: "null step id throws", units: [{ id: "a", dependencies: ["b"] }, { id: "b" }], stepIds: ["s1", null], exactError: true },
  {
    name: "duplicate unit id keeps the last step id",
    units: [{ id: "a" }, { id: "b", dependencies: ["a"] }, { id: "a" }],
    stepIds: ["s1", "s2", "s3"],
  },
  { name: "null unit throws the TS TypeError text", units: [null], stepIds: ["s1"], exactError: true },
  { name: "non-array units collection throws", units: "x", stepIds: [] },
  {
    name: "non-string deps are dropped by readStringArray (no diagnostic)",
    units: [{ id: "a", dependencies: [null, "b", 3] }, { id: "b" }],
    stepIds: ["s1", "s2"],
  },
];

describe("normalize-dependency-graph: TS vs paperclip-mission-core", () => {
  for (const c of normalizeCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => normalize(c.units, c.draftSteps)),
        rust("normalize-dependency-graph", { units: c.units, draftSteps: c.draftSteps }),
        c.exactError,
      );
    });
  }

  it("normalize output is a fixed point on both runtimes", () => {
    const first = {
      units: [U("a", { unitId: "legacy-a" }), U("b", { dependsOn: ["legacy-a"] })],
      draftSteps: [{ unitId: "b", dependencies: ["a"] }, "free"],
    };
    const r1 = rust("normalize-dependency-graph", first);
    expectParity(ts(() => normalize(first.units, first.draftSteps)), r1);
    const g = (unwrap(r1) as { graph: { units: unknown; draftSteps: unknown } }).graph;
    const r2 = rust("normalize-dependency-graph", { units: g.units, draftSteps: g.draftSteps });
    expectParity(ts(() => normalize(g.units, g.draftSteps)), r2);
    expect(unwrap(r2)).toEqual(unwrap(r1));
  });
});

describe("is-unit-materialized: TS vs paperclip-mission-core", () => {
  for (const c of materializedCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => materialized(c.unit)),
        rust("is-unit-materialized", { unit: c.unit }),
        c.exactError,
      );
    });
  }
});

describe("remap-to-step-ids: TS vs paperclip-mission-core", () => {
  for (const c of remapCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => remap(c.units, c.stepIds)),
        rust("remap-to-step-ids", { units: c.units, stepIds: c.stepIds }),
        c.exactError,
      );
    });
  }
});

describe("paperclip-mission-core CLI contract", () => {
  it("fails closed on unknown subcommand and malformed/oversized/empty stdin", () => {
    for (const out of [
      rustRaw("bogus-subcommand", "{}"),
      rustRaw("normalize-dependency-graph", "{not json"),
      rustRaw("normalize-dependency-graph", ""),
      rustRaw("normalize-dependency-graph", " ".repeat(4 * 1024 * 1024 + 8)),
    ]) {
      expect(out.threw).toBe(true);
    }
  });
});
