import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE,
  EVIDENCE_CHAIN_FORMAT,
  EVIDENCE_EXPLANATION_QUALITY_MARKER,
  MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
  STRUCTURAL_GATE_ALREADY_RUN_MARKER,
  VERIFICATION_BEFORE_COMPLETION_MARKER,
  buildVerificationBeforeCompletionCriteria,
  extractMissionQualityContract,
  renderAdaptiveQualityProfileLines,
  renderEvidenceExplanationQaLines,
  renderEvidenceExplanationWritingLines,
  renderMissionQualityContractSection,
  renderMissionQualityReviewLines,
  renderStructuralGateAlreadyRunLines,
  renderVerificationBeforeCompletionGateLines,
} from "../services/missions/mission-quality-contract.js";

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
const extract = extractMissionQualityContract as (input: unknown) => unknown;
const renderSection = renderMissionQualityContractSection as (contract: unknown) => unknown;
const gateLines = renderVerificationBeforeCompletionGateLines as (options?: unknown) => unknown;

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

const extractCases: Array<{ name: string; input: unknown; exactError?: boolean }> = [
  {
    name: "all four signals build the fully populated contract",
    input: {
      missionGoal: "  Write a beginner deep-research guide  ",
      qualitySignals: { beginnerFacing: true, actionableReport: true, deepResearch: true, publishHtml: true },
    },
  },
  { name: "beginnerFacing alone adds one hard-stop rule", input: { missionGoal: "g", qualitySignals: { beginnerFacing: true } } },
  { name: "actionableReport alone sets use case without hard stops", input: { missionGoal: "g", qualitySignals: { actionableReport: true } } },
  { name: "deepResearch alone adds its rule and deliverable", input: { missionGoal: "g", qualitySignals: { deepResearch: true } } },
  { name: "publishHtml alone only clears underspecified", input: { missionGoal: "g", qualitySignals: { publishHtml: true } } },
  { name: "missing signals -> underspecified with clarify note", input: { missionGoal: "vague goal" } },
  { name: "whitespace-only goal falls back to trimmed title", input: { missionGoal: "   ", missionTitle: "  Title X  " } },
  { name: "empty goal and empty title use the placeholder", input: { missionGoal: "", missionTitle: "  " } },
  { name: "JS trim removes BOM and NBSP around the goal", input: { missionGoal: "﻿ goal ﻿" } },
  { name: "non-boolean-true signal values stay false", input: { missionGoal: "g", qualitySignals: { beginnerFacing: 1, actionableReport: "true", deepResearch: [], publishHtml: {} } } },
  { name: "non-object qualitySignals is ignored", input: { missionGoal: "g", qualitySignals: "beginnerFacing" } },
  { name: "null qualitySignals is ignored", input: { missionGoal: "g", qualitySignals: null } },
  { name: "array input reads no props and stays underspecified", input: [1, 2] },
  { name: "missionDescription is accepted but unused", input: { missionGoal: "g", missionDescription: "extra context" } },
  { name: "null input throws the TS TypeError text", input: null, exactError: true },
  { name: "numeric missionGoal throws the TS TypeError text", input: { missionGoal: 5 }, exactError: true },
  { name: "object missionGoal throws the TS TypeError text", input: { missionGoal: {} }, exactError: true },
  { name: "non-string title throws only on the empty-goal path", input: { missionGoal: "", missionTitle: 7 }, exactError: true },
  { name: "non-string title is never read when goal is non-empty", input: { missionGoal: "g", missionTitle: 7 } },
];

const contractOf = (over: Record<string, unknown> = {}) => ({
  purpose: "p", targetUser: "t", useCase: "u", mustDeliver: [], failureCriteria: [],
  evaluationAxes: ["a1", "a2"], clarifyNote: null, hardStopRules: [], ...over,
});

const sectionCases: Array<{ name: string; contract: unknown; exactError?: boolean }> = [
  {
    name: "full contract renders every block in order",
    contract: contractOf({ mustDeliver: ["m1", "m2"], failureCriteria: ["f1"], clarifyNote: "note", hardStopRules: ["h1"] }),
  },
  {
    name: "non-string scalars interpolate via JS ToString",
    contract: contractOf({ purpose: 5, targetUser: true, useCase: [1, 2], mustDeliver: [null, { a: 1 }, [2, 3]] }),
  },
  {
    name: "absent scalar fields interpolate as 'undefined'",
    contract: { mustDeliver: [], failureCriteria: [], evaluationAxes: [], hardStopRules: [] },
  },
  { name: "empty-array clarifyNote is truthy and renders blank", contract: contractOf({ clarifyNote: [] }) },
  { name: "numeric clarifyNote interpolates", contract: contractOf({ clarifyNote: 5 }) },
  { name: "string mustDeliver iterates code points", contract: contractOf({ mustDeliver: "abc" }) },
  { name: "empty hardStopRules and mustDeliver skip their blocks", contract: contractOf() },
  { name: "missing mustDeliver throws the undefined-length TypeError", contract: { purpose: "p", targetUser: "t", useCase: "u", failureCriteria: [], evaluationAxes: [], hardStopRules: [] }, exactError: true },
  { name: "null mustDeliver throws the null-length TypeError", contract: contractOf({ mustDeliver: null }), exactError: true },
  { name: "object with truthy length is not iterable", contract: contractOf({ mustDeliver: { length: 2 } }), exactError: true },
  { name: "object with string length coerces then fails to iterate", contract: contractOf({ mustDeliver: { length: "2" } }), exactError: true },
  { name: "object with falsy length skips the block", contract: contractOf({ mustDeliver: { length: 0 } }) },
  { name: "missing evaluationAxes throws join-of-undefined", contract: { purpose: "p", targetUser: "t", useCase: "u", mustDeliver: [], failureCriteria: [], hardStopRules: [] }, exactError: true },
  { name: "null evaluationAxes throws join-of-null", contract: contractOf({ evaluationAxes: null }), exactError: true },
  { name: "string evaluationAxes throws join-not-a-function", contract: contractOf({ evaluationAxes: "x" }), exactError: true },
  { name: "axes join stringifies members with JS rules", contract: contractOf({ evaluationAxes: ["a", null, 2, [1, 2], { k: 1 }] }) },
  { name: "undefined contract throws the TypeError text", contract: undefined, exactError: true },
  { name: "null contract throws the TypeError text", contract: null, exactError: true },
  { name: "string contract reaches the mustDeliver length throw", contract: "x", exactError: true },
];

const gateCases: Array<{ name: string; options: unknown; exactError?: boolean }> = [
  { name: "empty options picks the full claim line", options: {} },
  { name: "intermediateQa true picks the scoped claim line", options: { intermediateQa: true } },
  { name: "truthy non-boolean picks the scoped claim line", options: { intermediateQa: "x" } },
  { name: "falsy values pick the full claim line", options: { intermediateQa: 0 } },
  { name: "array options read no intermediateQa", options: [] },
  { name: "missing options applies the default", options: undefined },
  { name: "null options throws the TS TypeError text", options: null, exactError: true },
];

const staticCases: Array<{ sub: string; fn: () => unknown }> = [
  { sub: "render-adaptive-quality-profile", fn: renderAdaptiveQualityProfileLines },
  { sub: "render-quality-review-lines", fn: renderMissionQualityReviewLines },
  { sub: "render-evidence-writing-lines", fn: renderEvidenceExplanationWritingLines },
  { sub: "render-evidence-qa-lines", fn: renderEvidenceExplanationQaLines },
  { sub: "render-structural-gate-lines", fn: renderStructuralGateAlreadyRunLines },
  { sub: "verification-criteria", fn: buildVerificationBeforeCompletionCriteria },
];

describe("extract-quality-contract: TS vs paperclip-mission-core", () => {
  for (const c of extractCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(ts(() => extract(c.input)), rust("extract-quality-contract", c.input), c.exactError);
    });
  }
});

describe("render-quality-contract-section: TS vs paperclip-mission-core", () => {
  for (const c of sectionCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => renderSection(c.contract)),
        rust("render-quality-contract-section", { contract: c.contract }),
        c.exactError,
      );
    });
  }

  it("extract -> render-section round trips agree on both runtimes", () => {
    const input = { missionGoal: "Goal", qualitySignals: { beginnerFacing: true, deepResearch: true } };
    const tsContract = unwrap(ts(() => extract(input)));
    const rustContract = unwrap(rust("extract-quality-contract", input));
    expectParity(
      ts(() => renderSection(tsContract)),
      rust("render-quality-contract-section", { contract: rustContract }),
    );
  });
});

describe("render-verification-gate-lines: TS vs paperclip-mission-core", () => {
  for (const c of gateCases) {
    it(`parity: ${c.name}`, () => {
      expectParity(
        ts(() => gateLines(c.options)),
        rust("render-verification-gate-lines", { options: c.options }),
        c.exactError,
      );
    });
  }
});

describe("static quality-contract renderers: TS vs paperclip-mission-core", () => {
  for (const c of staticCases) {
    it(`parity: ${c.sub}`, () => {
      expectParity(ts(() => c.fn()), rust(c.sub, {}));
    });
  }

  it("quality-contract-constants matches every exported string constant", () => {
    expectParity(
      ts(() => ({
        EVIDENCE_CHAIN_FORMAT,
        EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE,
        MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
        EVIDENCE_EXPLANATION_QUALITY_MARKER,
        VERIFICATION_BEFORE_COMPLETION_MARKER,
        STRUCTURAL_GATE_ALREADY_RUN_MARKER,
      })),
      rust("quality-contract-constants", {}),
    );
  });
});

describe("quality-contract CLI contract", () => {
  it("fails closed on malformed stdin for input-taking subcommands", () => {
    for (const out of [
      rustRaw("extract-quality-contract", "{not json"),
      rustRaw("extract-quality-contract", ""),
      rustRaw("render-quality-contract-section", "{not json"),
      rustRaw("render-verification-gate-lines", "{not json"),
    ]) {
      expect(out.threw).toBe(true);
    }
  });
});
