import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { formatOperatorDecisionSummary } from "../services/missions/operator-card-summary.js";
import { readStepDeclaredDependencyUnitIds } from "../services/missions/revision-plan-declaration-targets.js";
import {
  reviewPlanAgainstIntent,
  setMissionPlanQaCritiqueHook,
  type PlanQaCritiqueHook,
} from "../services/missions/mission-plan-qa.js";
import type { MissionIntent } from "../services/missions/mission-intent.js";
import { resetMissionCoreS9FallbackWarningsForTests } from "../services/missions/mission-core-client-s9.js";

/**
 * [목적] mission-core-client-s9 동기 시임의 서비스 wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_MISSION_CORE_BIN 미설정) → 스폰 없는 TS 경로가 기존과 동일.
 *   - 설정 + 실 release bin → Rust 팔이 실행되고 TS 결과와 동일.
 *   - 고장 bin(비JSON/non-zero/없는 경로) → 던지지 않고 TS 로 투명 폴백.
 *   - critiqueHook 등록 시 reviewPlanAgainstIntent 는 Rust 를 우회하고 TS 를 직접 실행.
 *   - lone surrogate 입력은 Rust serde 거부(exit 1) → TS 폴백이 parity 를 보장.
 *   전수 parity 는 mission-core-*-parity.test.ts 계열이 담당한다(범위 밖).
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/mission-core/target/release/paperclip-mission-core");

let dir: string;
let cannedBin: string;
let garbageBin: string;
let failingBin: string;
let warn: MockInstance;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

/** canned 응답은 전부 TS 결과와 다른 rust-arm marker — Rust 팔 실행을 증명한다. */
const CANNED_SCRIPT = `cat >/dev/null
case "$1" in
  format-operator-decision-summary) echo '"rust-arm-card"' ;;
  read-step-declared-dependency-unit-ids) echo '["rust-arm-unit"]' ;;
  review-plan-against-intent) echo '[{"code":"missing_publish_unit","severity":"invalid","message":"rust-arm-qa"}]' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/mission-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "mission-core-s9-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; echo 'boom' >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMissionCoreS9FallbackWarningsForTests();
});

afterEach(() => {
  setMissionPlanQaCritiqueHook(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type CardInput = Parameters<typeof formatOperatorDecisionSummary>[0];
const CARD_INPUT: CardInput = {
  decision: "escalate",
  missionTitle: "2026-08-25 tech-ai-news daily report",
  issueIdentifier: "RES-3638",
  issueTitle: "[Unblock] Synthesize multi-source AI news report draft",
  issueId: "c70bc2a9-b34a-4ee5-960d-2dbc1605e01f",
  reason: "The accepted reassign event c70bc2a9-1111-4ee5-960d-2dbc1605e01f did not materialize.",
  nextAction: "Assign the issue to an idle agent and dispatch its workflow wakeup.",
  evidence: "Fresh heartbeat shows status=blocked and assignee=c70bc2a9-2222-4ee5-960d-2dbc1605e01f.",
};
const DECL_DECISION = { steps: [{ units: ["b", "al"], dependencies: [] }] };
const DECL_UNITS = [{ id: "a", unitId: "al" }, { id: "b" }];
const QA_INTENT: MissionIntent = {
  publish: true, audienceSplit: false, scenario: false, audiences: [], beneficiary: [],
  matchedSignals: [{ category: "publish", token: "publication" }],
};
const QA_INPUT = { intent: QA_INTENT, selectedExecutionUnits: [{ id: "pub", toolName: "deploy" }] };

/** 게이트 OFF 상태(테스트 기본)에서의 TS 기준값 — 각 테스트 첫 줄에서 계산한다. */
const tsReferences = () => ({
  card: formatOperatorDecisionSummary(CARD_INPUT),
  declared: readStepDeclaredDependencyUnitIds(DECL_DECISION, DECL_UNITS),
  qa: reviewPlanAgainstIntent(QA_INPUT),
});

describe("mission-core s9 wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    const { card, declared, qa } = tsReferences();
    expect(card).toContain("증상:");
    expect(card).toContain("did not materialize");
    expect(card).not.toContain("c70bc2a9-1111"); // uuid 8자로 단축됨 — TS 포맷 계약
    expect(declared).toEqual(new Set(["a", "b"]));
    expect(qa).toHaveLength(1);
    expect(qa[0]).toMatchObject({ code: "missing_publish_unit", severity: "invalid" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", cannedBin);
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toBe("rust-arm-card");
    expect(readStepDeclaredDependencyUnitIds(DECL_DECISION, DECL_UNITS)).toEqual(new Set(["rust-arm-unit"]));
    expect(reviewPlanAgainstIntent(QA_INPUT)).toEqual([
      { code: "missing_publish_unit", severity: "invalid", message: "rust-arm-qa" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS arm on all three wired entries", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", rustBin);
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toEqual(expected.card);
    expect(readStepDeclaredDependencyUnitIds(DECL_DECISION, DECL_UNITS)).toEqual(expected.declared);
    expect(reviewPlanAgainstIntent(QA_INPUT)).toEqual(expected.qa);
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-JSON stdout falls back to TS with a contract warning", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", garbageBin);
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toEqual(expected.card);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", failingBin);
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toEqual(expected.card);
    expect(readStepDeclaredDependencyUnitIds(DECL_DECISION, DECL_UNITS)).toEqual(expected.declared);
    expect(reviewPlanAgainstIntent(QA_INPUT)).toEqual(expected.qa);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toEqual(expected.card);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("relative env path keeps the gate closed silently", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", "relative/bin");
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toEqual(expected.card);
    expect(readStepDeclaredDependencyUnitIds(DECL_DECISION, DECL_UNITS)).toEqual(expected.declared);
    expect(warn).not.toHaveBeenCalled();
  });

  it("active critiqueHook bypasses Rust and runs the TS path directly", async () => {
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", cannedBin); // 스폰되면 rust-arm marker — 우회 증명에 사용
    const hook: PlanQaCritiqueHook = async () => [];
    setMissionPlanQaCritiqueHook(hook);
    const expected = tsReferences(); // 훅 활성 상태 그대로 — TS 기준값도 Rust 를 우회해 계산된다
    expect(reviewPlanAgainstIntent(QA_INPUT)).toEqual(expected.qa);
    expect(reviewPlanAgainstIntent(QA_INPUT)[0]?.message).not.toBe("rust-arm-qa");
    // 우회는 mission-plan-qa 에 한정된다 — 9A/9C 는 여전히 Rust 팔을 쓴다.
    expect(formatOperatorDecisionSummary(CARD_INPUT)).toBe("rust-arm-card");
    expect(readStepDeclaredDependencyUnitIds(DECL_DECISION, DECL_UNITS)).toEqual(new Set(["rust-arm-unit"]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("lone surrogate input rides the Rust parse rejection into the TS fallback", () => {
    const input: CardInput = { ...CARD_INPUT, reason: "배포 파이프라인이 \uD800 손상으로 중단됨" };
    const expected = formatOperatorDecisionSummary(input); // 게이트 OFF — TS 기준값
    vi.stubEnv("PAPERCLIP_MISSION_CORE_BIN", rustBin); // serde 가 lone surrogate 입력을 거부(exit 1)
    expect(() => formatOperatorDecisionSummary(input)).not.toThrow();
    expect(formatOperatorDecisionSummary(input)).toEqual(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });
});
