import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  buildCanonicalMissionRevisionDeltaWithNodeFallback,
  extractMissionQualityContractWithNodeFallback,
  isMissionPlanUnitMaterializedWithNodeFallback,
  MissionCoreUnavailableError,
  normalizeMissionPlanDependencyGraphWithNodeFallback,
  parseMissionRevisionReusePlanRecordWithNodeFallback,
  remapCanonicalDependenciesToStepIdsWithNodeFallback,
  renderMissionQualityContractSectionWithNodeFallback,
  resetMissionCoreFallbackWarningsForTests,
  resolveMissionCoreBin,
  resolveMissionRevisionReuseClosureWithNodeFallback,
  runMissionCoreSubcommand,
} from "../services/missions/mission-core-client.js";
import {
  isMissionPlanUnitMaterialized,
  normalizeMissionPlanDependencyGraph,
  remapCanonicalDependenciesToStepIds,
} from "../services/missions/mission-plan-dependency-graph.js";
import {
  extractMissionQualityContract,
  renderMissionQualityContractSection,
} from "../services/missions/mission-quality-contract.js";
import {
  buildCanonicalRevisionDelta,
  parseRevisionReusePlanRecord,
  resolveReuseClosure,
} from "../services/missions/revision-reuse-plan.js";

/**
 * [목적] mission-core-client 의 Rust→Node fallback 정책 단위 검증 — opt-in 게이트, fake bin
 *   (ENOENT/비JSON/shape 불일치/exit-1 시맨틱/타임아웃), 그리고 실 Rust bin 라이브 팔.
 *   전수 패리티는 mission-core-*-parity.test.ts 계열이 담당한다(여기서 범위 밖).
 */
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

let dir: string;
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
  dir = await mkdtemp(path.join(tmpdir(), "mission-core-client-"));
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  emptyShapeBin = await writeBin("empty-shape", 'cat >/dev/null; echo "{}"');
  semanticBin = await writeBin("semantic", "cat >/dev/null; echo 'boom semantic' >&2; exit 1");
  sleepBin = await writeBin("sleep", "cat >/dev/null; sleep 30");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("MISSION_CORE_RUST", "");
  vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", "");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMissionCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const units = [
  { id: "a", unitId: "legacy-a" },
  { id: "b", dependsOn: ["legacy-a"] },
  { id: "o", kind: "oversight" },
];

describe("resolveMissionCoreBin", () => {
  it("accepts an absolute env path, trimmed", () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", "  /opt/bin/paperclip-mission-core  ");
    expect(resolveMissionCoreBin()).toBe("/opt/bin/paperclip-mission-core");
  });

  it("nulls relative/NUL env values; unset env falls back to the compiled default when present", () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", "bin/relative");
    expect(resolveMissionCoreBin()).toBeNull();
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", "   ");
    expect(resolveMissionCoreBin()).toBe(rustBin); // 빈 env → 기본 경로 존재 시 사용
    // env 값은 NUL 을 운반하지 못해 잘리므로(Node 가 C 문자열로 저장) 직접 주입해 검증.
    expect(resolveMissionCoreBin("/opt/bin/pa\0th")).toBeNull();
  });
});

describe("MISSION_CORE_RUST gate (opt-in)", () => {
  it("unset/'0'/'yes' force the Node path silently even with a working bin", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", emptyShapeBin);
    for (const flag of ["", "0", "yes"]) {
      warn.mockClear();
      vi.stubEnv("MISSION_CORE_RUST", flag);
      const result = await normalizeMissionPlanDependencyGraphWithNodeFallback(units);
      expect(result).toEqual(normalizeMissionPlanDependencyGraph(units));
      expect(warn).not.toHaveBeenCalled();
    }
  });
});

describe("live Rust binary (MISSION_CORE_RUST=1)", () => {
  beforeEach(() => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", rustBin);
  });

  it("runs the dependency-graph subcommands on the Rust arm", async () => {
    expect(await normalizeMissionPlanDependencyGraphWithNodeFallback(units))
      .toEqual(normalizeMissionPlanDependencyGraph(units));
    expect(await isMissionPlanUnitMaterializedWithNodeFallback(units[2]!))
      .toBe(isMissionPlanUnitMaterialized(units[2]!));
    const normalized = normalizeMissionPlanDependencyGraph(units);
    if (!normalized.ok) throw new Error("expected ok graph");
    const canonical = normalized.graph.units;
    expect(await remapCanonicalDependenciesToStepIdsWithNodeFallback(canonical, ["s1", "s2", "s3"]))
      .toEqual(remapCanonicalDependenciesToStepIds(canonical, ["s1", "s2", "s3"]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs the quality-contract subcommands on the Rust arm", async () => {
    const input = { missionGoal: "Write a guide", qualitySignals: { beginnerFacing: true } };
    const contract = await extractMissionQualityContractWithNodeFallback(input);
    expect(contract).toEqual(extractMissionQualityContract(input));
    expect(await renderMissionQualityContractSectionWithNodeFallback(contract))
      .toEqual(renderMissionQualityContractSection(extractMissionQualityContract(input)));
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs the revision-reuse subcommands on the Rust arm", async () => {
    const refs = { revisionReusePlan: {
      schemaVersion: "mission-revision-reuse.v1", sourceWorkflowRunId: "run-1",
      roots: ["s3"], closureUnitIds: ["s1", "s2", "s3"] } };
    expect(await parseMissionRevisionReusePlanRecordWithNodeFallback(refs))
      .toEqual(parseRevisionReusePlanRecord(refs));
    const steps = [
      { id: "s1", name: "a", agentId: "g", dependencies: [] },
      { id: "s2", name: "b", agentId: "g", dependencies: ["s1"] },
      { id: "s3", name: "c", agentId: "g", dependencies: ["s2"] },
    ];
    expect(await resolveMissionRevisionReuseClosureWithNodeFallback(steps, ["s3"]))
      .toEqual(resolveReuseClosure(steps, ["s3"]));
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const delta = {
      schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: uuid,
      base: { workflowDefinitionId: uuid, snapshotHash: "a".repeat(64) },
      units: [{ unitId: "s3", operation: "reuse", sourceStepId: "s3" }],
    };
    expect(await buildCanonicalMissionRevisionDeltaWithNodeFallback(delta, ["s1", "s3"]))
      .toEqual(buildCanonicalRevisionDelta(delta, ["s1", "s3"]));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("unavailable fallback", () => {
  it("falls back to TS on missing binary and warns once per process", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(await isMissionPlanUnitMaterializedWithNodeFallback({ id: "u" })).toBe(true);
    expect(await isMissionPlanUnitMaterializedWithNodeFallback({ id: "u" })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is-unit-materialized"));
  });
});

describe("contract fallback", () => {
  beforeEach(() => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
  });

  it("falls back on unparsable stdout", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", garbageBin);
    expect(await isMissionPlanUnitMaterializedWithNodeFallback({ id: "u" })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mission_core_bad_json"));
  });

  it("falls back on wrong response shape", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", emptyShapeBin);
    const result = await normalizeMissionPlanDependencyGraphWithNodeFallback([{ id: "a" }]);
    expect(result).toEqual(normalizeMissionPlanDependencyGraph([{ id: "a" }]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mission_core_normalize_bad_shape"));
  });
});

describe("semantic error passthrough", () => {
  beforeEach(() => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
  });

  it("propagates an exit-1 stderr throw without Node fallback or warn", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", semanticBin);
    // TS fallback 은 이 입력에서 true 를 반환한다 — rejection 이 Rust 팔의 판정임을 증명.
    await expect(isMissionPlanUnitMaterializedWithNodeFallback({ id: "u" }))
      .rejects.toThrowError("boom semantic");
    expect(warn).not.toHaveBeenCalled();
  });

  it("real bin semantic throws surface the TS-identical message", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", rustBin);
    await expect(remapCanonicalDependenciesToStepIdsWithNodeFallback([{ id: "a" }], []))
      .rejects.toThrowError("Canonical units and workflow steps must have equal length.");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("timeout", () => {
  it("kills a hung helper and rejects as unavailable", async () => {
    vi.stubEnv("MISSION_CORE_RUST", "1");
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", sleepBin);
    await expect(runMissionCoreSubcommand("is-unit-materialized", {}, 150)).rejects.toSatisfy(
      (err: unknown) => err instanceof MissionCoreUnavailableError && err.message === "mission_core_timeout",
    );
  });
});
