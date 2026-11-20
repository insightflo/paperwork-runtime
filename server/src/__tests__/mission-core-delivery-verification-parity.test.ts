import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  appendDeliveryVerificationCriteria,
  buildDeliveryVerificationCriteria,
  hasExistingDeliveryReadbackStep,
  hasSelectedArtifactRole,
  isDeliveryReadbackStep,
  isDeliveryRelevantStep,
  strengthenDeliveryReadbackSteps,
  synthesizeDeliveryVerificationGateStep,
} from "../services/workflow/delivery-verification-gate.js";
import {
  buildMissionPlanUnitStepContract,
  renderMissionPlanQaUnitContractLines,
  renderMissionPlanUnitContractLines,
} from "../services/missions/mission-plan-unit-contract.js";

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
function rustRaw(subcommand: string, stdin: string): Outcome {
  const res = spawnSync(rustBin, [subcommand], {
    input: stdin, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
const rust = (subcommand: string, payload: unknown) => rustRaw(subcommand, JSON.stringify(payload));
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

// Rust dispatch: absent `tools` -> [] but a present null stays null; non-string `role` -> "".
type P = Record<string, unknown>;
const rd = (p: unknown, k: string) => (p !== null && typeof p === "object" ? (p as P)[k] : undefined);
const toolsOf = (p: unknown) => (p !== null && typeof p === "object" && "tools" in p ? (p as P).tools : []);
const roleOf = (p: unknown) => (typeof rd(p, "role") === "string" ? rd(p, "role") : "");
const callTs = {
  "delivery-has-artifact-role": (p: P) =>
    hasSelectedArtifactRole(rd(p, "step") as never, toolsOf(p) as never, roleOf(p) as never),
  "delivery-is-relevant-step": (p: P) => isDeliveryRelevantStep(rd(p, "step") as never, toolsOf(p) as never),
  "delivery-is-readback-step": (p: P) => isDeliveryReadbackStep(rd(p, "step") as never, toolsOf(p) as never),
  "delivery-has-existing-readback": (p: P) =>
    hasExistingDeliveryReadbackStep(rd(p, "steps") as never, toolsOf(p) as never),
  "delivery-append-criteria": (p: P) => appendDeliveryVerificationCriteria(rd(p, "description") as never),
  "delivery-strengthen-readback-steps": (p: P) =>
    strengthenDeliveryReadbackSteps(rd(p, "steps") as never, toolsOf(p) as never),
  "delivery-synthesize-gate-step": (p: P) => synthesizeDeliveryVerificationGateStep(rd(p, "input") as never),
  "delivery-build-criteria": () => buildDeliveryVerificationCriteria(),
  "plan-unit-contract-lines": (p: P) => renderMissionPlanUnitContractLines(rd(p, "unit") as never),
  "plan-unit-step-contract": (p: P) => buildMissionPlanUnitStepContract(rd(p, "unit") as never),
  "plan-qa-unit-contract-lines": (p: P) => renderMissionPlanQaUnitContractLines(rd(p, "units") as never),
} as const;
type Sub = keyof typeof callTs;
const parity = (sub: Sub, payload: unknown, exact = false) =>
  expectParity(ts(() => callTs[sub](payload as P)), rust(sub, payload), exact);

const contract = (role: string, extra: P = {}) => ({
  role, resultFileName: "result.json", resultSchemaVersion: "v1", resultAdapter: "generic",
  inputParams: {}, deploymentFiles: ["out/index.html"], inputEnvelopeVersion: "v1", ...extra,
});
const pubContract = contract("publication", { publication: {
  identity: { param: "pubId" }, publishedAt: { resultPointer: "/publishedAt", dateParam: "pubDate" },
  bindings: [{ resultPointer: "/date", parameter: "pubDate" }] } });
const verifyContract = contract("publication-verify");
const qaContract = contract("qa");
const legacyPubContract = (fields: P, publishedAtPointer: string, dateBindingPointer: string) =>
  contract("publication", {
    resultAdapter: "legacy-publication",
    publication: {
      identity: { param: "pubId" },
      publishedAt: { resultPointer: publishedAtPointer, dateParam: "pubDate", suffix: "T00:00:00Z" },
      bindings: [{ resultPointer: dateBindingPointer, parameter: "pubDate" }],
      legacyMapping: { fields, contentMode: "raw", htmlMode: "raw",
        contentDigest: "/contentDigest", htmlDigest: "/htmlDigest", qaDigest: "/qaDigest",
        assets: "/assets", ancillary: "/ancillary" } },
  });
const tool = (name: string, artifactContract: unknown) => ({ name, adapterConfig: { artifactContract } });

const deliveryStep = { id: "d", deliveryVerification: "required" };
const readbackStep = (deps: unknown = ["d"], extra: P = {}) =>
  ({ id: "r", qaType: "delivery", dependencies: deps, ...extra });

const cases: Array<{ sub: Sub; name: string; payload: unknown; exact?: boolean }> = [
  { sub: "delivery-has-artifact-role", name: "named tool with matching publication contract", payload: { step: { toolNames: ["p"] }, tools: [tool("p", pubContract)], role: "publication" } },
  { sub: "delivery-has-artifact-role", name: "publication contract rejects verify role", payload: { step: { toolNames: ["p"] }, tools: [tool("p", pubContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "verify contract matches verify role", payload: { step: { toolNames: ["v"] }, tools: [tool("v", verifyContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "contract with bad role fails parse", payload: { step: { toolNames: ["t"] }, tools: [tool("t", { ...qaContract, role: "nope" })], role: "qa" } },
  { sub: "delivery-has-artifact-role", name: "strict contract rejects unknown key", payload: { step: { toolNames: ["t"] }, tools: [tool("t", { ...qaContract, surprise: 1 })], role: "qa" } },
  { sub: "delivery-has-artifact-role", name: "publication without refine tail fails parse", payload: { step: { toolNames: ["p"] }, tools: [tool("p", contract("publication"))], role: "publication" } },
  { sub: "delivery-has-artifact-role", name: "unmatched name skips adapterConfig read", payload: { step: { toolNames: ["nope"] }, tools: [{ name: "p" }], role: "x" } },
  { sub: "delivery-has-artifact-role", name: "step.tools used when toolNames absent", payload: { step: { tools: ["v"] }, tools: [tool("v", verifyContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "null toolNames defers to step.tools", payload: { step: { toolNames: null, tools: ["v"] }, tools: [tool("v", verifyContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "singular toolName is the last fallback", payload: { step: { toolName: "v" }, tools: [tool("v", verifyContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "falsy toolName yields empty names", payload: { step: { toolName: 0 }, tools: [tool("v", verifyContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "non-array names throws includes-not-function", payload: { step: { toolNames: false }, tools: [tool("v", verifyContract)], role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "string names use substring includes", payload: { step: { toolNames: "p" }, tools: [tool("p", pubContract)], role: "publication" } },
  { sub: "delivery-has-artifact-role", name: "null tools throws some read", payload: { step: { toolNames: ["v"] }, tools: null, role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "numeric tools throws some-not-function", payload: { step: { toolNames: ["v"] }, tools: 7, role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "empty tools short-circuits names check", payload: { step: { toolNames: false }, tools: [], role: "x" } },
  { sub: "delivery-has-artifact-role", name: "null step throws toolNames read", payload: { step: null, tools: [], role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "missing step throws undefined toolNames read", payload: { tools: [], role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "primitive step reads no names", payload: { step: 5, tools: [tool("v", verifyContract)], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "null tool element throws name read", payload: { step: { toolNames: ["v"] }, tools: [null], role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "missing adapterConfig throws contract read", payload: { step: { toolNames: ["v"] }, tools: [{ name: "v" }], role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "null adapterConfig throws contract read", payload: { step: { toolNames: ["v"] }, tools: [{ name: "v", adapterConfig: null }], role: "x" }, exact: true },
  { sub: "delivery-has-artifact-role", name: "primitive adapterConfig parses false", payload: { step: { toolNames: ["v"] }, tools: [{ name: "v", adapterConfig: 5 }], role: "x" } },
  { sub: "delivery-has-artifact-role", name: "first match skips later null tool", payload: { step: { toolNames: ["v"] }, tools: [tool("v", verifyContract), null], role: "publication-verify" } },
  { sub: "delivery-has-artifact-role", name: "missing role never equals contract role", payload: { step: { toolNames: ["v"] }, tools: [tool("v", verifyContract)] } },
  { sub: "delivery-is-relevant-step", name: "required marker wins without tools", payload: { step: { deliveryVerification: "required" }, tools: null } },
  { sub: "delivery-is-relevant-step", name: "other marker without pub tool is false", payload: { step: { deliveryVerification: "optional" } } },
  { sub: "delivery-is-relevant-step", name: "publication tool makes step relevant", payload: { step: { toolNames: ["p"] }, tools: [tool("p", pubContract)] } },
  { sub: "delivery-is-relevant-step", name: "verify tool alone is not relevant", payload: { step: { toolNames: ["v"] }, tools: [tool("v", verifyContract)] } },
  { sub: "delivery-is-relevant-step", name: "null step throws deliveryVerification read", payload: { step: null }, exact: true },
  { sub: "delivery-is-readback-step", name: "qaType delivery is readback", payload: { step: { qaType: "delivery" } } },
  { sub: "delivery-is-readback-step", name: "deliveryRole publication-verify is readback", payload: { step: { deliveryRole: "publication-verify" } } },
  { sub: "delivery-is-readback-step", name: "verify tool makes step readback", payload: { step: { toolNames: ["v"] }, tools: [tool("v", verifyContract)] } },
  { sub: "delivery-is-readback-step", name: "plain step is not readback", payload: { step: { id: "s" } } },
  { sub: "delivery-is-readback-step", name: "null step throws qaType read", payload: { step: null }, exact: true },
  { sub: "delivery-has-existing-readback", name: "direct downstream readback is found", payload: { steps: [deliveryStep, readbackStep()] } },
  { sub: "delivery-has-existing-readback", name: "unrelated readback is not found", payload: { steps: [deliveryStep, readbackStep([])] } },
  { sub: "delivery-has-existing-readback", name: "transitive chain reaches delivery", payload: { steps: [deliveryStep, { id: "m", dependencies: ["d"] }, readbackStep(["m"])] } },
  { sub: "delivery-has-existing-readback", name: "dependency cycle terminates without hit", payload: { steps: [readbackStep(["x"]), { id: "x", dependencies: ["r"] }] } },
  { sub: "delivery-has-existing-readback", name: "verify-role tool step counts as readback", payload: { steps: [{ id: "d", toolNames: ["p"] }, { id: "r", toolNames: ["v"], dependencies: ["d"] }], tools: [tool("p", pubContract), tool("v", verifyContract)] } },
  { sub: "delivery-has-existing-readback", name: "duplicate step id last write wins", payload: { steps: [deliveryStep, { id: "x", dependencies: [] }, { id: "x", dependencies: ["d"] }, readbackStep(["x"])] } },
  { sub: "delivery-has-existing-readback", name: "numeric ids resolve via SameValueZero", payload: { steps: [{ id: 7, deliveryVerification: "required" }, readbackStep([7])] } },
  { sub: "delivery-has-existing-readback", name: "string dependencies iterate characters", payload: { steps: [deliveryStep, { id: "g", deliveryVerification: "required" }, readbackStep("gd")] } },
  { sub: "delivery-has-existing-readback", name: "non-iterable dependencies throw spread error", payload: { steps: [deliveryStep, readbackStep({})] }, exact: true },
  { sub: "delivery-has-existing-readback", name: "non-iterable nested deps throw push error", payload: { steps: [deliveryStep, { id: "x", dependencies: 5 }, readbackStep(["x"])] }, exact: true },
  { sub: "delivery-has-existing-readback", name: "missing steps throws undefined filter", payload: {}, exact: true },
  { sub: "delivery-has-existing-readback", name: "null steps throws null filter", payload: { steps: null }, exact: true },
  { sub: "delivery-has-existing-readback", name: "primitive steps throws filter-not-function", payload: { steps: 5 }, exact: true },
  { sub: "delivery-has-existing-readback", name: "null element throws deliveryVerification", payload: { steps: [null] }, exact: true },
  { sub: "delivery-append-criteria", name: "missing description returns criteria", payload: {} },
  { sub: "delivery-append-criteria", name: "null description returns criteria", payload: { description: null } },
  { sub: "delivery-append-criteria", name: "BOM-whitespace description returns criteria", payload: { description: " ﻿ " } },
  { sub: "delivery-append-criteria", name: "existing marker returns trimmed text", payload: { description: "  see Delivery Verification: block  " } },
  { sub: "delivery-append-criteria", name: "plain description appends criteria", payload: { description: "check the deployment" } },
  { sub: "delivery-append-criteria", name: "numeric description throws trim error", payload: { description: 5 }, exact: true },
  { sub: "delivery-append-criteria", name: "array description throws trim error", payload: { description: [] }, exact: true },
  { sub: "delivery-strengthen-readback-steps", name: "downstream readback gains criteria", payload: { steps: [deliveryStep, readbackStep(["d"], { description: "verify it" }), { id: "o" }] } },
  { sub: "delivery-strengthen-readback-steps", name: "marked readback stays unchanged", payload: { steps: [deliveryStep, readbackStep(["d"], { description: "Delivery Verification: done" })] } },
  { sub: "delivery-strengthen-readback-steps", name: "non-downstream readback untouched", payload: { steps: [deliveryStep, readbackStep([], { description: "x" })] } },
  { sub: "delivery-strengthen-readback-steps", name: "missing description gains criteria", payload: { steps: [deliveryStep, readbackStep()] } },
  { sub: "delivery-strengthen-readback-steps", name: "empty steps stays empty", payload: { steps: [] } },
  { sub: "delivery-strengthen-readback-steps", name: "missing steps throws filter read", payload: {}, exact: true },
  { sub: "delivery-strengthen-readback-steps", name: "numeric description throws trim error", payload: { steps: [deliveryStep, readbackStep(["d"], { description: 5 })] }, exact: true },
  { sub: "delivery-synthesize-gate-step", name: "full input renders the gate step", payload: { input: { agentId: "qa-bot", dependencyStepIds: ["d1", "d2"], definitionName: "deploy" } } },
  { sub: "delivery-synthesize-gate-step", name: "missing fields drop undefined keys", payload: { input: {} } },
  { sub: "delivery-synthesize-gate-step", name: "null input throws agentId read", payload: { input: null }, exact: true },
  { sub: "delivery-synthesize-gate-step", name: "missing input throws agentId read", payload: {}, exact: true },
  { sub: "delivery-synthesize-gate-step", name: "primitive input skips both reads", payload: { input: 5 } },
  { sub: "delivery-build-criteria", name: "static criteria text", payload: {} },
  { sub: "plan-unit-contract-lines", name: "all three string fields render", payload: { unit: { expectedOutput: "out", acceptanceCriteria: "crit", evidenceRequired: "ev" } } },
  { sub: "plan-unit-contract-lines", name: "string arrays join with semicolons", payload: { unit: { expectedOutput: ["a", " b ", "", "c"] } } },
  { sub: "plan-unit-contract-lines", name: "mixed array stringifies as JSON", payload: { unit: { expectedOutput: ["a", 1, null] } } },
  { sub: "plan-unit-contract-lines", name: "integer keys order numerically first", payload: { unit: { expectedOutput: { "2": "b", "1": "a", x: 1 } } } },
  { sub: "plan-unit-contract-lines", name: "empty containers render nothing", payload: { unit: { expectedOutput: [], acceptanceCriteria: {}, evidenceRequired: "  " } } },
  { sub: "plan-unit-contract-lines", name: "numbers and booleans stringify", payload: { unit: { expectedOutput: 5, acceptanceCriteria: false } } },
  { sub: "plan-unit-contract-lines", name: "null unit throws expectedOutput read", payload: { unit: null }, exact: true },
  { sub: "plan-unit-contract-lines", name: "missing unit throws expectedOutput read", payload: {}, exact: true },
  { sub: "plan-unit-contract-lines", name: "primitive unit reads no fields", payload: { unit: 5 } },
  { sub: "plan-unit-step-contract", name: "explicit sections become the contract", payload: { unit: { preconditions: [" pre "], postconditions: " post ", undefinedBehaviors: ["u"] } } },
  { sub: "plan-unit-step-contract", name: "missing postconditions derive from fields", payload: { unit: { expectedOutput: "o", acceptanceCriteria: ["c"] } } },
  { sub: "plan-unit-step-contract", name: "empty postconditions array derives too", payload: { unit: { postconditions: [], expectedOutput: "o" } } },
  { sub: "plan-unit-step-contract", name: "non-list postconditions derive too", payload: { unit: { postconditions: 7, expectedOutput: "o" } } },
  { sub: "plan-unit-step-contract", name: "all-empty unit normalizes to null", payload: { unit: { preconditions: [], expectedOutput: "" } } },
  { sub: "plan-unit-step-contract", name: "null unit throws preconditions read", payload: { unit: null }, exact: true },
  { sub: "plan-unit-step-contract", name: "missing unit throws preconditions read", payload: {}, exact: true },
  { sub: "plan-qa-unit-contract-lines", name: "contracted units render under header", payload: { units: [{ title: "U1", unit: { expectedOutput: "o" } }, { title: "U2", unit: {} }] } },
  { sub: "plan-qa-unit-contract-lines", name: "empty array renders nothing", payload: { units: [] } },
  { sub: "plan-qa-unit-contract-lines", name: "non-string titles interpolate", payload: { units: [{ title: [1, 2], unit: { expectedOutput: "o" } }, { title: null, unit: { expectedOutput: "o" } }] } },
  { sub: "plan-qa-unit-contract-lines", name: "missing title renders undefined", payload: { units: [{ unit: { expectedOutput: "o" } }] } },
  { sub: "plan-qa-unit-contract-lines", name: "null units throws flatMap read", payload: { units: null }, exact: true },
  { sub: "plan-qa-unit-contract-lines", name: "missing units throws flatMap read", payload: {}, exact: true },
  { sub: "plan-qa-unit-contract-lines", name: "primitive units throws flatMap-not-function", payload: { units: 5 }, exact: true },
  { sub: "plan-qa-unit-contract-lines", name: "null element throws destructure error", payload: { units: [null] }, exact: true },
  { sub: "plan-qa-unit-contract-lines", name: "primitive element reads unit as undefined", payload: { units: ["x"] }, exact: true },
  { sub: "delivery-has-artifact-role", name: "legacy-publication empty-string fields are falsy", payload: { step: { toolNames: ["p", "q"] }, tools: [tool("p", legacyPubContract({ date: "/date", publishedAt: "" }, "", "/date")), tool("q", legacyPubContract({ date: "", publishedAt: "/publishedAt" }, "/publishedAt", ""))], role: "publication" } },
  { sub: "plan-unit-contract-lines", name: "magnitudes >= 1e21 render exponential", payload: { unit: { expectedOutput: 1e21, acceptanceCriteria: 1.5e21 } } },
  { sub: "plan-unit-contract-lines", name: "trailing U+0085 NEL is not trimmed", payload: { unit: { expectedOutput: "kept\u0085" } } },
];

describe("delivery-verification-gate: TS vs paperclip-mission-core", () => {
  for (const c of cases.filter((c) => c.sub.startsWith("delivery-"))) {
    it(`parity: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});

describe("mission-plan-unit-contract: TS vs paperclip-mission-core", () => {
  for (const c of cases.filter((c) => c.sub.startsWith("plan-"))) {
    it(`parity: ${c.name}`, () => parity(c.sub, c.payload, c.exact));
  }
});

describe("delivery-verification CLI contract", () => {
  it("fails closed on malformed stdin for input-taking subcommands", () => {
    for (const out of [
      rustRaw("delivery-has-artifact-role", "{not json"),
      rustRaw("delivery-is-relevant-step", ""),
      rustRaw("delivery-strengthen-readback-steps", "{not json"),
      rustRaw("delivery-synthesize-gate-step", "{not json"),
      rustRaw("plan-qa-unit-contract-lines", "{not json"),
    ]) {
      expect(out.threw).toBe(true);
    }
  });
});
