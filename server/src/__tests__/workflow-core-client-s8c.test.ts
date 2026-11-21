import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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
import { resetWorkflowCoreFallbackWarningsForTests } from "../services/workflow/workflow-core-client.js";
import {
  applyRunInputDerivationsWithNodeFallback,
  extractYoutubeVideoIdWithNodeFallback,
  findWorkflowDefinitionStepWarningsWithNodeFallback,
  summarizeDefinitionStepWarningsWithNodeFallback,
  validateRunInputDeclarationsWithNodeFallback,
  validateWorkflowDefinitionStepsWithNodeFallback,
} from "../services/workflow/workflow-core-client-s8c.js";

/**
 * [목적] Stage 8C Node 브리지(workflow-core-client-s8c)의 양 팔 검증.
 *   - Node fallback 팔: WORKFLOW_CORE_RUST=0 / bin 미설정 → TS 구현 결과 그대로(무음).
 *   - 실 Rust bin 팔: PAPERCLIP_WORKFLOW_CORE_BIN=release bin → TS 와 동일 결과.
 *   - canned bin: 서브커맨드별 고정 응답으로 Rust 팔 실행을 증명.
 *   - missing/malformed/wrong-shape bin → warn-once 후 TS fallback.
 *   입력별 전수 패리티(zod union·derivation·warning edge case)는
 *   workflow-core-rust-parity-s8c.test.ts 담당.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/workflow-core/target/release/paperclip-workflow-core");

let dir: string;
let cannedBin: string;
let errArmBin: string;
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
  extract-youtube-video-id) echo '{"videoId":"rust-arm-id"}' ;;
  validate-run-input-declarations) echo '{"ok":true}' ;;
  apply-run-input-derivations) echo '{"status":"ok","metadata":{"u":"rust-arm"}}' ;;
  validate-definition-steps) echo '{"ok":true}' ;;
  definition-step-warnings) echo '{"warnings":[{"kind":"workproduct_selector_missing","stepId":"s","referencedStepId":"rust-arm","message":"m"}]}' ;;
  summarize-step-warnings) echo '{"summary":[{"kind":"workproduct_selector_missing","stepId":"s","referencedStepId":"rust-arm"}]}' ;;
esac`;

const ERR_ARM_SCRIPT = `cat >/dev/null
case "$1" in
  apply-run-input-derivations) echo '{"status":"error","key":"k","message":"m"}' ;;
esac`;

beforeAll(async () => {
  execFileSync(process.env.CARGO || "cargo",
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/workflow-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-s8c-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  errArmBin = await writeBin("err-arm", ERR_ARM_SCRIPT);
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

const V = "ABCDEFGHIJK";
const YT_VALUE = `see https://youtu.be/${V}?t=1`;
const RUN_INPUTS = [
  { key: "u" },
  { key: "v", deriveFrom: { input: "u", extract: "youtubeVideoId" } },
] as never;
const METADATA = { u: `youtu.be/${V}` };
const DEF_STEPS = [
  { id: "a" },
  { id: "b", dependencies: ["a"], toolArgs: "{$steps.a.workProductPath}" },
] as never;
const WARN_STEPS = [
  { id: "p" },
  { id: "c", dependencies: ["p"], toolArgs: "{$steps.p.workProductPath}" },
] as never; // c 는 p 참조 + workProductSelectors 부재 → 경고 1건
const WARNINGS = [
  { kind: "workproduct_selector_missing", stepId: "c", referencedStepId: "p", message: "m" },
] as never;

/** [서브커맨드, 브리지 호출, TS 직접 호출] — 같은 입력을 양 팔에 먹인다. */
const CASES: [string, () => Promise<unknown>, () => unknown][] = [
  ["extract-youtube-video-id",
    () => extractYoutubeVideoIdWithNodeFallback(YT_VALUE),
    () => extractYoutubeVideoId(YT_VALUE)],
  ["validate-run-input-declarations",
    () => validateRunInputDeclarationsWithNodeFallback(RUN_INPUTS),
    () => validateRunInputDeclarations(RUN_INPUTS)],
  ["apply-run-input-derivations",
    () => applyRunInputDerivationsWithNodeFallback(RUN_INPUTS, METADATA),
    () => applyRunInputDerivations(RUN_INPUTS, METADATA)],
  ["validate-definition-steps",
    () => validateWorkflowDefinitionStepsWithNodeFallback(DEF_STEPS),
    () => validateWorkflowDefinitionSteps(DEF_STEPS)],
  ["definition-step-warnings",
    () => findWorkflowDefinitionStepWarningsWithNodeFallback(WARN_STEPS),
    () => findWorkflowDefinitionStepWarnings(WARN_STEPS)],
  ["summarize-step-warnings",
    () => summarizeDefinitionStepWarningsWithNodeFallback(WARNINGS),
    () => summarizeDefinitionStepWarnings(WARNINGS)],
];

/** canned 응답 해석 결과 — CASES 와 같은 순서. ok arm 은 TS 결과와 달라 Rust 팔 실행을 증명한다. */
const CANNED: unknown[] = [
  "rust-arm-id",
  undefined,
  { status: "ok", metadata: { u: "rust-arm" } },
  undefined,
  [{ kind: "workproduct_selector_missing", stepId: "s", referencedStepId: "rust-arm", message: "m" }],
  [{ kind: "workproduct_selector_missing", stepId: "s", referencedStepId: "rust-arm" }],
];

describe("workflow-core-client-s8c bridges", () => {
  it("Node arm (WORKFLOW_CORE_RUST=0) returns TS results without spawning or warning", async () => {
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", cannedBin); // 스폰되면 rust-arm marker — Node 팔 증명
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("bin unset also uses Node silently on all six", async () => {
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS implementations on all six subcommands", async () => {
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

  it("canned error arm maps to the TS derivation error shape", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", errArmBin);
    expect(await applyRunInputDerivationsWithNodeFallback(RUN_INPUTS, METADATA))
      .toEqual({ status: "error", key: "k", message: "m" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("missing binary falls back to TS and warns once per subcommand", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", path.join(dir, "does-not-exist"));
    const [, run, ts] = CASES[0];
    expect(await run()).toEqual(ts());
    expect(await run()).toEqual(ts());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("extract-youtube-video-id"));
  });

  it("non-JSON stdout falls back with a contract warning", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", garbageBin);
    expect(await CASES[5][1]()).toEqual(CASES[5][2]());
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
    const rejecting = [
      () => extractYoutubeVideoIdWithNodeFallback(null as never),
      () => validateRunInputDeclarationsWithNodeFallback([{ key: "a-b" }] as never),
      () => applyRunInputDerivationsWithNodeFallback(5 as never, {}),
      () => validateWorkflowDefinitionStepsWithNodeFallback([{ id: "a" }, { id: "a" }] as never),
      () => findWorkflowDefinitionStepWarningsWithNodeFallback([null] as never),
      () => summarizeDefinitionStepWarningsWithNodeFallback([null] as never),
    ];
    for (const run of rejecting) {
      await expect(run()).rejects.toThrow();
    }
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", rustBin);
    for (const run of rejecting) {
      await expect(run()).rejects.toThrow();
    }
  });
});
