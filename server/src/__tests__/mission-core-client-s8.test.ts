import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { resetMissionCoreFallbackWarningsForTests } from "../services/missions/mission-core-client.js";
import {
  buildDeliveryVerificationCriteriaWithNodeFallback,
  formatMissionPlanUnitContractLinesWithNodeFallback,
  isMissionExecutionLiaisonAgentWithNodeFallback,
  resolveHermesOpsModeWithNodeFallback,
  synthesizeDeliveryVerificationGateStepWithNodeFallback,
  validateDeclaredStructuralPlanWithNodeFallback,
} from "../services/missions/mission-core-client-s8.js";
import {
  isMissionExecutionLiaisonAgent,
  resolveHermesOpsMode,
} from "../services/missions/agent-role-boundaries.js";
import { validateDeclaredStructuralPlan } from "../services/missions/structural-plan-validation.js";
import {
  buildDeliveryVerificationCriteria,
  synthesizeDeliveryVerificationGateStep,
} from "../services/workflow/delivery-verification-gate.js";
import { renderMissionPlanUnitContractLines } from "../services/missions/mission-plan-unit-contract.js";

/**
 * [목적] mission-core-client-s8 브리지의 양 팔 검증.
 *   - Node 팔: MISSION_CORE_RUST 미설정/'0' → TS 구현 결과 그대로(무음, 스폰 없음).
 *   - 실 Rust bin 팔: PAPERCLIP_MISSION_CORE_BIN=release bin → TS 와 동일 결과.
 *   - canned bin: 서브커맨드별 고정 응답으로 Rust 팔 실행을 증명.
 *   - missing/비JSON/wrong-shape bin → warn-once 후 TS fallback.
 *   - 시맨틱 에러(exit 1 + stderr)는 fallback·warn 없이 그대로 전파.
 *   입력별 전수 패리티는 mission-core-*-parity.test.ts 계열이 담당한다(범위 밖).
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/mission-core/target/release/paperclip-mission-core");

let dir: string;
let cannedBin: string;
let garbageBin: string;
let wrongShapeBin: string;
let semanticBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

const CANNED_SCRIPT = `cat >/dev/null
case "$1" in
  is-liaison-agent) echo 'true' ;;
  resolve-hermes-ops-mode) echo '"admin"' ;;
  validate-declared-structural-plan) echo '["rust-arm"]' ;;
  delivery-build-criteria) echo '"Delivery Verification: rust-arm"' ;;
  delivery-synthesize-gate-step) echo '{"id":"delivery-verification-gate","name":"rust-arm","qaType":"delivery","graphWorkProductRequired":false,"description":"rust-arm"}' ;;
  plan-unit-contract-lines) echo '["rust-arm"]' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/mission-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "mission-core-s8-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  wrongShapeBin = await writeBin("wrong-shape", 'cat >/dev/null; echo "{}"');
  semanticBin = await writeBin("semantic", "cat >/dev/null; echo 'boom semantic' >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("MISSION_CORE_RUST", ""); // 게이트 닫힘 — TS 팔
  vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", ""); // env 비움 → 기본 bin 탐색
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMissionCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const NON_LIAISON = { name: "n", adapterType: "claude_local", runtimeConfig: {} };
const PLAN_UNITS = [
  { id: "p" },
  { id: "g", type: "tool", qaType: "structural", toolName: "v", dependencies: ["p"] },
];
const GATE_INPUT = { agentId: "qa-bot", dependencyStepIds: ["d1", "d2"] };
const UNIT = { expectedOutput: "out", acceptanceCriteria: ["a", "b"], evidenceRequired: "ev" };

/** [서브커맨드, 브리지 호출, TS 직접 호출] — 같은 입력을 양 팔에 먹인다. */
const CASES: [string, () => Promise<unknown>, () => unknown][] = [
  ["is-liaison-agent",
    () => isMissionExecutionLiaisonAgentWithNodeFallback(NON_LIAISON),
    () => isMissionExecutionLiaisonAgent(NON_LIAISON)],
  ["resolve-hermes-ops-mode",
    () => resolveHermesOpsModeWithNodeFallback(NON_LIAISON),
    () => resolveHermesOpsMode(NON_LIAISON)],
  ["validate-declared-structural-plan",
    () => validateDeclaredStructuralPlanWithNodeFallback(PLAN_UNITS),
    () => validateDeclaredStructuralPlan(PLAN_UNITS)],
  ["delivery-build-criteria",
    () => buildDeliveryVerificationCriteriaWithNodeFallback(),
    () => buildDeliveryVerificationCriteria()],
  ["delivery-synthesize-gate-step",
    () => synthesizeDeliveryVerificationGateStepWithNodeFallback(GATE_INPUT),
    () => synthesizeDeliveryVerificationGateStep(GATE_INPUT)],
  ["plan-unit-contract-lines",
    () => formatMissionPlanUnitContractLinesWithNodeFallback(UNIT),
    () => renderMissionPlanUnitContractLines(UNIT)],
];

/** canned 응답 — 전부 TS 결과와 달라 Rust 팔 실행을 증명한다. CASES 와 같은 순서. */
const CANNED: unknown[] = [
  true,
  "admin",
  ["rust-arm"],
  "Delivery Verification: rust-arm",
  { id: "delivery-verification-gate", name: "rust-arm", qaType: "delivery",
    graphWorkProductRequired: false, description: "rust-arm" },
  ["rust-arm"],
];

describe("mission-core-client-s8 bridges", () => {
  it("MISSION_CORE_RUST=0 uses the TS arm silently even with a live bin", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "0");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", cannedBin); // 스폰되면 rust-arm marker — Node 팔 증명
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("unset flag also stays silent on the TS arm", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", cannedBin);
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches TS on all six subcommands", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", rustBin);
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned Rust output is returned verbatim (Rust 팔 실행 증명)", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", cannedBin);
    for (const [index, [name, run]] of CASES.entries()) {
      expect(await run(), name).toEqual(CANNED[index]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("missing binary falls back to TS and warns once per subcommand", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", path.join(dir, "does-not-exist"));
    const [, run, ts] = CASES[0];
    expect(await run()).toEqual(ts());
    expect(await run()).toEqual(ts());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is-liaison-agent"));
  });

  it("non-JSON stdout falls back with a contract warning", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", garbageBin);
    expect(await CASES[3][1]()).toEqual(CASES[3][2]());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mission_core_bad_json"));
  });

  it("wrong-shape stdout falls back per subcommand with a contract warning", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", wrongShapeBin);
    for (const [name, run, ts] of CASES) {
      expect(await run(), name).toEqual(ts());
    }
    expect(warn).toHaveBeenCalledTimes(CASES.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_shape"));
  });

  it("semantic errors propagate from the Rust arm without fallback or warn", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", semanticBin);
    await expect(isMissionExecutionLiaisonAgentWithNodeFallback(NON_LIAISON))
      .rejects.toThrowError("boom semantic");
    expect(warn).not.toHaveBeenCalled();
  });

  it("real bin semantic throws surface the TS-identical message", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", rustBin);
    await expect(isMissionExecutionLiaisonAgentWithNodeFallback(null as never))
      .rejects.toThrowError("Cannot read properties of null (reading 'adapterType')");
    await expect(resolveHermesOpsModeWithNodeFallback(null as never))
      .rejects.toThrowError("Cannot read properties of null (reading 'runtimeConfig')");
    await expect(validateDeclaredStructuralPlanWithNodeFallback(null as never))
      .rejects.toThrowError("Cannot read properties of null (reading 'filter')");
    await expect(synthesizeDeliveryVerificationGateStepWithNodeFallback(null as never))
      .rejects.toThrowError("Cannot read properties of null (reading 'agentId')");
    await expect(formatMissionPlanUnitContractLinesWithNodeFallback(null as never))
      .rejects.toThrowError("Cannot read properties of null (reading 'expectedOutput')");
    expect(warn).not.toHaveBeenCalled();
  });
});
