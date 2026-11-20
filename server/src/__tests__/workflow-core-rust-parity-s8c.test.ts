import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyRunInputDerivations,
  extractYoutubeVideoId,
  validateRunInputDeclarations,
} from "../services/workflow/run-input-derivations.js";
import {
  findWorkflowDefinitionStepWarnings,
  summarizeDefinitionStepWarnings,
  validateWorkflowDefinitionSteps,
} from "../services/workflow/definition-step-validation.js";

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
function rustErr(sub: string, payload: unknown): string {
  try {
    execFileSync(rustBin, [sub], { input: JSON.stringify(payload), encoding: "utf8" });
  } catch (e) {
    return String((e as { stderr?: unknown }).stderr ?? "").trim();
  }
  throw new Error("rust did not throw");
}
// JSON 도메인 정규화 — undefined 값 키 제거(Rust 측은 이미 직렬화된 텍스트).
const j = (v: unknown) => JSON.parse(JSON.stringify(v));
// TS·Rust 모두 성공이면 출력을, 실패면 error.message/stderr 텍스트를 그대로 비교한다.
function run(sub: string, payload: unknown, ts: () => unknown) {
  let expected: unknown;
  let tsMessage: string | undefined;
  try {
    expected = j(ts());
  } catch (e) {
    tsMessage = (e as Error).message;
  }
  if (tsMessage === undefined) expect(rust(sub, payload)).toEqual(expected);
  else expect(rustErr(sub, payload)).toBe(tsMessage);
}
function parityThrow(sub: string, payload: unknown, ts: () => unknown) {
  expect(ts).toThrow();
  expect(() => rust(sub, payload)).toThrow();
}

const yt = (value: unknown) => ({ videoId: extractYoutubeVideoId(value as string) });
const decl = (runInputs: unknown) => {
  validateRunInputDeclarations(runInputs as never);
  return { ok: true };
};
const deriv = (runInputs: unknown, metadata: unknown) =>
  applyRunInputDerivations(runInputs as never, metadata as never);
const def = (steps: unknown) => {
  validateWorkflowDefinitionSteps(steps as never);
  return { ok: true };
};
const warns = (steps: unknown) => ({ warnings: findWorkflowDefinitionStepWarnings(steps as never) });
const summ = (warnings: unknown) => ({ summary: summarizeDefinitionStepWarnings(warnings as never) });
const V = "ABCDEFGHIJK"; // 11자 — 뒤가 id-char 이면 매치 실패
const text = (extra: Record<string, unknown> = {}) => [{ key: "a", ...extra }];
const opt = (value: string, label = "x") => ({ value, label });
const drv = (key: string, extra: Record<string, unknown> = {}) =>
  [{ key, deriveFrom: { input: "u", extract: "youtubeVideoId" }, ...extra }];
const step = (id: unknown, extra: Record<string, unknown> = {}) => ({ id, ...extra });
const qa = (rules: Record<string, unknown>) => ({ qaConfig: { rules } });

describe("paperclip-workflow-core Rust parity (s8c: run-input derivations + definition steps)", () => {
  it("extract-youtube-video-id: pattern order, 11-char boundary, first-valid wins", () => {
    for (const value of [
      `https://youtu.be/${V}`, `youtu.be/${V}?si=x`, `xyoutu.be/${V}`, `youtu.be/${V}한`,
      `youtu.be/${V}L`, `youtu.be/1234567890!`, `youtu.be/short`, `youtu.be/x${V}`,
      `https://www.youtube.com/watch?v=${V}&si=1`, `a?v=${V}`, `x&y&v=${V}z`,
      `?v=short&v=${V}`, `?v=${V}L&v=12345678901`, `v=${V}`, `xv=${V}`, `?vv=${V}`, `?v=한${V}`,
      `https://youtube.com/shorts/${V}`, `youtube.com/shorts/${V}?f=1`, `shorts/${V}`,
      `youtu.be/${V} watch?v=ABCDEFGHIJ1`, `?v=ABCDEFGHIJ1 youtu.be/${V}`,
      "", "no tokens", 5, true, [V], { v: 1 },
    ]) run("extract-youtube-video-id", { value }, () => yt(value));
    for (const value of [null, undefined])
      parityThrow("extract-youtube-video-id", { value }, () => yt(value));
  });

  it("validate-run-input-declarations: falsy/length-0 early return, expected-array errors", () => {
    for (const runInputs of [undefined, null, false, 0, "", [], { length: 0 }, { length: -0 },
      5, true, "ab", {}, { length: 1 }, { length: "0" }])
      run("validate-run-input-declarations", { runInputs }, () => decl(runInputs));
  });

  it("validate-run-input-declarations: union branches, strict keys, superRefine order", () => {
    for (const runInputs of [
      [{ key: "a" }], text({ type: "text" }), text({ required: false, placeholder: "p", label: "L" }),
      [{ key: "a", type: "switch" }], [{ key: "a", type: "switch", default: true }],
      [{ key: "a", type: "radio", options: [opt("x")] }],
      [{ key: "a", type: "radio", options: [opt("x"), opt("y")], default: "y", required: false }],
      [{ key: "a", type: "checkbox", options: [opt("x")], default: ["x"] }],
      [{ key: "a-b" }], [{ key: "x".repeat(41) }], [{ key: "x".repeat(40) }],
      [{ key: "" }], [{ key: 5 }], [{ key: "a", bogus: 1 }], [{ key: "a", type: "bogus" }],
      text({ options: [] }), text({ default: "x" }), text({ type: "radio" }),
      [{ key: "a", type: "switch", default: "x" }], [{ key: "a", type: "switch", options: [opt("x")] }],
      [{ key: "a", type: "radio" }], [{ key: "a", type: "radio", options: [opt("")] }],
      [{ key: "a", type: "radio", options: [{ value: "x" }] }],
      [{ key: "a", type: "radio", options: [{ value: "x", label: "l", extra: 1 }] }],
      [{ key: "a", type: "radio", options: [opt("x"), opt("x")] }],
      [{ key: "a", type: "radio", options: [opt("x")], default: "z" }],
      [{ key: "a", type: "checkbox", options: [opt("x")], default: "x" }],
      [{ key: "a", type: "checkbox", options: [opt("x")], default: ["x", "x"] }],
      [{ key: "a", type: "checkbox", options: [opt("x")], default: ["z"] }],
      [{ key: "a", type: "checkbox", options: [opt("x")], deriveFrom: { input: "b", extract: "youtubeVideoId" } }],
      text({ deriveFrom: { input: "", extract: "youtubeVideoId" } }),
      text({ deriveFrom: { input: "b" } }), text({ deriveFrom: { input: "b", extract: "bogus" } }),
      text({ deriveFrom: { input: "b", extract: "youtubeVideoId", extra: 1 } }),
      [5, "x", true, [1], null, {}], Array.from({ length: 6 }, (_, i) => ({ key: `k${i}` })),
      [{ key: "a" }, { key: "a" }], [{ key: "a" }, { key: "a" }, { key: "b" }, { key: "b" }],
      [{ key: "a", type: "radio", options: [opt("x"), opt("x")] }, { key: "a" }],
      [{ key: "a" }, { key: "a" }, { bogus: true }],
      [{ key: "a", deriveFrom: { input: "b", extract: "youtubeVideoId" } }, { key: "b" }],
      [{ key: "a", deriveFrom: { input: "ghost", extract: "youtubeVideoId" } }],
      [{ key: "a", deriveFrom: { input: "ghost", extract: "youtubeVideoId" } },
        { key: "b", deriveFrom: { input: "ghost", extract: "youtubeVideoId" } }],
      [{ key: "a", deriveFrom: { input: "ghost", extract: "youtubeVideoId" } }, { key: "a" }],
    ]) run("validate-run-input-declarations", { runInputs }, () => decl(runInputs));
  });

  it("validate-definition-steps: policy gate, dup ids, tool references", () => {
    for (const steps of [
      undefined, null, false, 0, "", [], "ab", 5, { length: 0 }, [5, "x", true], [[1, 2]], [[]],
      [step("a")], [step("a"), step("b", { dependencies: ["a"] })],
      [step("a", { deliveryVerification: "required", capAcceptance: "blocked", extraPolicyKey: 9 })],
      [step("a", { deliveryVerification: "optional" })], [step("a", { capAcceptance: "x" })],
      [step("a", { deliveryVerification: null })],
      [step("a", qa({ provenance: { enabled: true } }))], [step("a", { qaConfig: {} })],
      [step("a", { qaConfig: { rules: null } })], [step("a", { qaConfig: { rules: {}, x: 1 } })],
      [step("a", qa({ bogus: {} }))], [step("a", qa({ provenance: { enabled: false } }))],
      [step("a", qa({ provenance: { enabled: true, extra: 1 } }))],
      [step("a", qa({ provenance: { params: {} } }))], [step("a", qa({ provenance: { params: { x: 1 } } }))],
      [step("a", qa({ "links-reachable": { enabled: false, params: {} } }))],
      [step("a", qa({ "links-reachable": { params: { x: 1 } } }))],
      [step("a", qa({ "min-source-links": { enabled: "yes" } }))],
      [step("a", qa({ "min-source-links": { params: { min: 2, pointers: ["/a"] } } }))],
      [step("a", qa({ "min-source-links": { params: { min: 2.5 } } }))],
      [step("a", qa({ "min-source-links": { params: { min: 10001 } } }))],
      [step("a", qa({ "min-source-links": { params: { pointers: ["/a"] } } }))],
      [step("a", qa({ "tag-count": { params: { min: 3, max: 5, pointer: "/x" } } }))],
      [step("a", qa({ "tag-count": { params: { min: 3, max: 2 } } }))],
      [step("a", qa({ "tag-count": { params: { min: "3" } } }))],
      [step("a", qa({ "required-fields": { params: { pointers: [] } } }))],
      [step("a", qa({ "required-fields": { params: { pointers: ["/a", "~x"] } } }))],
      [step("a", qa({ "required-fields": { params: { pointers: ["/~0", "/~1"] } } }))],
      [step("a", qa({ "no-template-remnants": { params: { patterns: ["x"] } } }))],
      [step("a", qa({ "no-template-remnants": { params: { patterns: [] } } }))],
      [step("a", qa({ "asset-existence": { params: {} } }))],
      [step("a"), step("b"), step("a")], [step("a"), step("b"), step("a"), step("b"), step("a")],
      [step("a", { toolArgs: "{$steps.ghost.workProductPath}" })],
      [step("a", { toolArgs: "{$steps.b.workProductDir}" }), step("b")],
      [step("a", { dependencies: ["b"], toolArgs: "{$steps.b.workProductPath} {$steps.ghost.workProductDir}" }),
        step("b"), step("c", { dependencies: ["b"], toolArgs: "{$steps.b.siblingAssetsDir}" })],
    ]) run("validate-definition-steps", { steps }, () => def(steps));
    parityThrow("validate-definition-steps", { steps: [null] }, () => def([null]));
    parityThrow("validate-definition-steps",
      { steps: [step("a", { dependencies: ["b"], toolArgs: "{$steps.b.workProductPath}" }), step("b", { dependencies: 5 })] },
      () => def([step("a", { dependencies: ["b"], toolArgs: "{$steps.b.workProductPath}" }), step("b", { dependencies: 5 })]));
  });

  it("definition-step-warnings: selector `in` semantics, rejected refs skipped, sorted output", () => {
    for (const steps of [
      [step("p"), step("c", { dependencies: ["p"], toolArgs: "{$steps.p.workProductPath}" })],
      [step("p"), step("c", { dependencies: ["p"], toolArgs: "{$steps.p.workProductPath}", workProductSelectors: { p: {} } })],
      [step("0"), step("c", { dependencies: ["0"], toolArgs: "{$steps.0.workProductPath}", workProductSelectors: ["s"] })],
      [step("length"), step("c", { dependencies: ["length"], toolArgs: "{$steps.length.workProductPath}", workProductSelectors: [] })],
      [step("toString"), step("c", { dependencies: ["toString"], toolArgs: "{$steps.toString.workProductPath}", workProductSelectors: {} })],
      [step("hasOwnProperty"), step("c", { dependencies: ["hasOwnProperty"], toolArgs: "{$steps.hasOwnProperty.workProductPath}" })],
      [step("a"), step("b"), step("c", { dependencies: ["a", "b"], toolArgs: "{$steps.b.workProductPath} {$steps.a.workProductDir}" })],
      [step("p"), step("c", { dependencies: ["p"], toolArgs: "{$steps.p.workProductPath} {$steps.ghost.workProductPath}" })],
      [step("a"), step("b"), step("c", { toolArgs: "{$steps.a.workProductPath} {$steps.b.workProductPath}" })],
      [step("p"), "x", 5, step("c", { dependencies: ["p", "x"], toolArgs: "{$steps.p.workProductPath} {$steps.x.workProductPath}" })],
      [step("p"), step(5, { dependencies: ["p"], toolArgs: "{$steps.p.workProductPath}" })],
      [step("p"), step("c", { dependencies: ["p"], toolArgs: 5 })],
      [step("c", { dependencies: ["p"], workProductSelectors: "xy", toolArgs: "{$steps.p.workProductPath}" }), step("p")],
      5, "ab", { length: 0 },
    ]) run("definition-step-warnings", { steps }, () => warns(steps));
    parityThrow("definition-step-warnings", { steps: [null] }, () => warns([null]));
    parityThrow("definition-step-warnings",
      { steps: [step("a", { dependencies: ["b"], toolArgs: "{$steps.b.workProductPath}" }), step("b", { dependencies: {} })] },
      () => warns([step("a", { dependencies: ["b"], toolArgs: "{$steps.b.workProductPath}" }), step("b", { dependencies: {} })]));
  });

  it("summarize-step-warnings: key projection and element edge cases", () => {
    for (const warnings of [
      [], [{ kind: "k", stepId: "s", referencedStepId: "r", message: "m", extra: 1 }],
      [{ kind: "k" }, {}, { stepId: "s", extra: "x" }],
      [5, "x", true, [1, 2], { kind: 5, stepId: null, referencedStepId: ["a"] }],
      5, "ab", true, {},
    ]) run("summarize-step-warnings", { warnings }, () => summ(warnings));
    parityThrow("summarize-step-warnings", { warnings: [null] }, () => summ([null]));
    parityThrow("summarize-step-warnings", {}, () => summ(undefined));
  });

  it("apply-run-input-derivations: provided keeps, required gate, metadata spread", () => {
    for (const payload of [
      { runInputs: undefined, metadata: { a: 1 } }, { runInputs: [], metadata: undefined },
      { runInputs: null, metadata: "ab" }, { runInputs: [{ key: "x" }], metadata: [1, "y"] },
      { runInputs: [5, "s", true], metadata: 9 }, { runInputs: [null], metadata: {} },
      { runInputs: drv("v"), metadata: { u: `youtu.be/${V}` } },
      { runInputs: drv("v"), metadata: { u: `youtu.be/${V}`, v: "keep" } },
      { runInputs: drv("v"), metadata: { u: `youtu.be/${V}`, v: "   " } },
      { runInputs: drv("v"), metadata: { u: `youtu.be/${V}`, v: 5 } },
      { runInputs: drv("v"), metadata: {} }, { runInputs: drv("v", { required: false }), metadata: {} },
      { runInputs: drv("v", { required: false }), metadata: { v: "x", u: "bad url" } },
      { runInputs: drv("v"), metadata: { u: 5 } }, { runInputs: drv("v"), metadata: "xy" },
      { runInputs: drv("v"), metadata: null }, { runInputs: [{ key: "v" }], metadata: null },
      { runInputs: [{ key: 5, deriveFrom: { input: "u", extract: "youtubeVideoId" } }], metadata: { u: `youtu.be/${V}` } },
      { runInputs: [{ key: "v", deriveFrom: { input: "u", extract: "bogus" } }], metadata: {} },
      { runInputs: [{ key: "v", deriveFrom: { input: "u", extract: "bogus" } }], metadata: { u: "x" } },
      { runInputs: [{ key: "v", deriveFrom: { input: "u" } }], metadata: { u: "x" } },
      { runInputs: [{ key: "v", deriveFrom: 5 }], metadata: { u: `youtu.be/${V}` } },
      { runInputs: [{ key: "v", deriveFrom: "x" }], metadata: {} },
      { runInputs: [
        { key: "v", deriveFrom: { input: "u", extract: "youtubeVideoId" } },
        { key: "w", deriveFrom: { input: "v", extract: "youtubeVideoId" } },
      ], metadata: { u: `youtu.be/${V}` } },
      { runInputs: 5 }, { runInputs: "ab" }, { runInputs: { length: 0 } }, { runInputs: true },
    ]) {
      const p = payload as { runInputs?: unknown; metadata?: unknown };
      run("apply-run-input-derivations", p, () => deriv(p.runInputs, p.metadata));
    }
  });
});
