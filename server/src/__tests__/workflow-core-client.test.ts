import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  findRunnableStepsWithNodeFallback,
  findSkippableStepsWithNodeFallback,
  renderToolArgsWithNodeFallback,
  resetWorkflowCoreFallbackWarningsForTests,
  resolveWorkflowCoreBin,
  runWorkflowCoreSubcommand,
  validateDagWithNodeFallback,
  WorkflowCoreUnavailableError,
  type WorkflowStepRunMap,
} from "../services/workflow/workflow-core-client.js";
import type { PredFacts } from "../services/workflow/control-flow/edge-condition.js";
import { validateDag as validateDagNode } from "../services/workflow/dag-validation.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

/**
 * [목적] workflow-core-client 의 Rust→Node fallback 정책 단위 검증 — 실 Rust bin 이 아니라
 *   동작 스크립트 fake bin 으로 spawn 경로(ENOENT/비JSON/시맨틱 envelope/타임아웃)를 흉내낸다.
 *   결과 패리티는 workflow-core-rust-parity.test.ts 계열이 담당한다(여기서 범위 밖).
 */
const steps: WorkflowStep[] = [
  { id: "s1", name: "s1", agentId: "g1", dependencies: [] },
  { id: "s2", name: "s2", agentId: "g1", dependencies: ["s1"] },
];
// TS validateDag 는 s2 에 unreachable warning 을 남긴다(계획 F1 기존 결함) — canned Rust
// 성공 응답과 달라서 "TS fallback 이 실제로 돌았는가"의 구분자로 쓴다.

let dir: string;
let okBin: string;
let garbageBin: string;
let emptyShapeBin: string;
let semanticBin: string;
let sleepBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wf-core-client-"));
  okBin = await writeBin("ok", [
    'sub="$1"; cat >/dev/null',
    'case "$sub" in',
    "  validate-dag) echo '{\"valid\":true,\"errors\":[],\"warnings\":[]}' ;;",
    "  runnable-steps) echo '{\"stepIds\":[\"s2\"]}' ;;",
    "  skippable-steps) echo '{\"stepIds\":[\"s2\"]}' ;;",
    "  render-tool-args) echo '{\"args\":{\"k\":\"rendered\"}}' ;;",
    '  *) echo "unknown $sub" >&2; exit 1 ;;',
    "esac",
  ].join("\n"));
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  emptyShapeBin = await writeBin("empty-shape", 'cat >/dev/null; echo "{}"');
  semanticBin = await writeBin(
    "semantic",
    "cat >/dev/null; echo '{\"error\":{\"code\":\"unresolved_child_inputs\",\"token\":\"{$childInputs.rustOnly}\",\"message\":\"rust unresolved\"}}'",
  );
  sleepBin = await writeBin("sleep", "cat >/dev/null; sleep 30");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("WORKFLOW_CORE_RUST", ""); // unset 과 동급 — 게이트 열림
  vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", ""); // 기본: bin 미설정
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetWorkflowCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveWorkflowCoreBin", () => {
  it("accepts an absolute path, trimmed", () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", "  /opt/bin/paperclip-workflow-core  ");
    expect(resolveWorkflowCoreBin()).toBe("/opt/bin/paperclip-workflow-core");
  });

  it("nulls relative, whitespace-only, unset, and NUL-containing values", () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", "bin/relative");
    expect(resolveWorkflowCoreBin()).toBeNull();
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", "   ");
    expect(resolveWorkflowCoreBin()).toBeNull();
    expect(resolveWorkflowCoreBin(undefined)).toBeNull(); // env 미설정
    // env 값은 NUL 을 운반하지 못해 잘리므로(Node 가 C 문자열로 저장) 직접 주입해 검증.
    expect(resolveWorkflowCoreBin("/opt/bin/pa\0th")).toBeNull();
  });
});

describe("WORKFLOW_CORE_RUST gate", () => {
  it("'0' forces the Node path silently even with a working bin", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", okBin);
    vi.stubEnv("WORKFLOW_CORE_RUST", "0");
    const result = await validateDagWithNodeFallback(steps);
    expect(result).toEqual(validateDagNode(steps));
    expect(result.warnings).toHaveLength(1); // TS 결과 — canned Rust 와 다름
    expect(warn).not.toHaveBeenCalled();
  });

  it("bin unset also uses Node silently", async () => {
    const result = await validateDagWithNodeFallback(steps);
    expect(result).toEqual(validateDagNode(steps));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("unavailable fallback", () => {
  it("falls back to TS on ENOENT and warns once per process", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", path.join(dir, "does-not-exist"));
    const first = await validateDagWithNodeFallback(steps);
    expect(first).toEqual(validateDagNode(steps));
    const second = await validateDagWithNodeFallback(steps);
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("validate-dag"));
  });
});

describe("contract fallback", () => {
  it("falls back on unparsable stdout", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", garbageBin);
    const result = await validateDagWithNodeFallback(steps);
    expect(result).toEqual(validateDagNode(steps));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workflow_core_bad_json"));
  });

  it("falls back on wrong response shape", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", emptyShapeBin);
    const result = await validateDagWithNodeFallback(steps);
    expect(result).toEqual(validateDagNode(steps));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workflow_core_validate_dag_bad_shape"));
  });
});

describe("semantic error passthrough", () => {
  it("throws unresolved childInputs from Rust without Node fallback", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", semanticBin);
    // 이 인자엔 미해결 토큰이 없다 — TS fallback 이 돌았으면 정상 렌더된다.
    // Rust 만 알려주는 rustOnly 토큰이 그대로 던져지는지로 passthrough 를 증명한다.
    await expect(renderToolArgsWithNodeFallback({
      args: "plain",
      runDate: "2026-11-20",
      runId: "r1",
      pathsByStepId: new Map(),
      runMetadata: {},
    })).rejects.toThrowError(/\{\$childInputs\.rustOnly\}/);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("timeout", () => {
  it("kills a hung helper and rejects as unavailable", async () => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", sleepBin);
    await expect(runWorkflowCoreSubcommand("validate-dag", {}, 150)).rejects.toSatisfy(
      (err: unknown) => err instanceof WorkflowCoreUnavailableError && err.message === "workflow_core_timeout",
    );
  });
});

describe("success path", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_WORKFLOW_CORE_BIN", okBin);
  });

  it("validateDag returns the helper verdict without warning", async () => {
    expect(await validateDagWithNodeFallback(steps)).toEqual({ valid: true, errors: [], warnings: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("findRunnableSteps maps stepIds back to step objects", async () => {
    const stepRunMap = new Map([["s2", { status: "pending", issueId: null }]]) as unknown as WorkflowStepRunMap;
    expect(await findRunnableStepsWithNodeFallback(steps, stepRunMap)).toEqual([steps[1]]);
  });

  it("findSkippableSteps maps stepIds back with eligibleStepIds option", async () => {
    const preds = new Map([
      ["s1", { status: "completed", isQaGate: false, verdict: null, verdictChecked: true } as unknown as PredFacts],
    ]);
    const result = await findSkippableStepsWithNodeFallback(steps, preds, { eligibleStepIds: new Set(["s2"]) });
    expect(result).toEqual([steps[1]]);
  });

  it("renderToolArgs returns rendered args", async () => {
    const args = await renderToolArgsWithNodeFallback({
      args: "{$runDate}",
      runDate: "2026-11-20",
      runId: "r1",
      pathsByStepId: new Map(),
      runMetadata: {},
    });
    expect(args).toEqual({ k: "rendered" });
    expect(warn).not.toHaveBeenCalled();
  });
});
