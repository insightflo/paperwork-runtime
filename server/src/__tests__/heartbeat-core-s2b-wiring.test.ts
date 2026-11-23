import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  describeSessionResetReason,
  hasWorkflowQaReworkContract,
  shouldResetTaskSessionForWake,
} from "../services/heartbeat-session-reset.js";
import {
  canApplyMissingWorkProductRegistrationGate,
  resolveStepRunRequiresWorkProduct,
} from "../services/heartbeat-output-validation.js";
import {
  hasRunProgressEvidenceViaRust,
  resetHeartbeatCoreS2bFallbackWarningsForTests,
} from "../services/heartbeat-core-client-s2b.js";
import { hasRunProgressEvidence } from "../services/heartbeat-stability.js";

/**
 * [목적] heartbeat-core-client-s2b 동기 시임의 서비스 wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_HEARTBEAT_CORE_BIN 미설정/빈값) → 스폰 없는 TS 경로(테스트 기본 상태).
 *   - canned bin → TS 결과와 다른 마커로 Rust 팔 라우팅 증명(reason null·stepRequires absent
 *     정상값 포함 — 번들 반환 null 만이 폴백 신호다).
 *   - 실 release bin → wired 함수 전부 TS-동일(ſ/\u212A 타이틀, 3상 stepRequires, Date 창,
 *     TS-throw 미러(issue null·비문자열 title) 포함).
 *   - 고장 bin(비JSON/non-zero/없는 경로/상대경로)·lone surrogate(serde 거부)·non-JSON-safe
 *     (BigInt 직렬화 가드)·유효하지 않은 Date(스폰 전 가드) → 던지지 않고 TS 폴백.
 *   progress-evidence 의 TS 본문은 heartbeat-stability.ts 이고 서비스 wiring 지점이 아직 없어
 *   래퍼 vs TS 본문 parity 로 검증한다. 전수 parity 는 heartbeat-core-stage2-parity 테스트 담당.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/heartbeat-core/target/release/paperclip-heartbeat-core");

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

/** canned 응답은 전부 TS 결과와 다른 rust-arm 마커 — Rust 팔 실행을 증명한다. */
const CANNED_SCRIPT = `in=$(cat)
case "$1" in
  session-reset) case "$in" in *null_probe*) echo '{"hasQaReworkContract":false,"shouldReset":false,"reason":null}' ;; *) echo '{"hasQaReworkContract":true,"shouldReset":true,"reason":"RUST_ARM"}' ;; esac ;;
  output-validation) case "$in" in *null_probe*) echo '{"gate":false}' ;; *) echo '{"gate":true,"stepRequires":true}' ;; esac ;;
  progress-evidence) echo 'true' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/heartbeat-core/Cargo.toml")],
    { stdio: "inherit" },
  );
  dir = await mkdtemp(path.join(tmpdir(), "heartbeat-core-s2b-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; echo boom >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetHeartbeatCoreS2bFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Ctx = Record<string, unknown> | null | undefined;
type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
const outcomeOf = (fn: () => unknown): Outcome => {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
};

const RESET_INPUTS: Ctx[] = [
  {},
  { forceFreshSession: true },
  { forceFreshSession: "true" },
  { paperclipWorkflowReworkContract: { kind: "workflow_qa_rework" } },
  { paperclipWorkflowReworkContract: { kind: "  workflow_qa_rework  " } },
  { paperclipWorkflowReworkContract: { kind: "other" } },
  { paperclipWorkflowReworkContract: "x" },
  { wakeReason: "issue_assigned" },
  { wakeReason: "mission_owner_planning_issue_created" }, // 리셋은 되지만 사유 서술은 null(비대칭)
  { wakeReason: "mission_unblock_action_created" }, { wakeReason: "mission_unblock_action_stalled" },
  { wakeReason: "timer" }, { wakeReason: 5 }, null,
];
const resetTriplet = (ctx: Ctx) => ({
  has: hasWorkflowQaReworkContract(ctx),
  should: shouldResetTaskSessionForWake(ctx),
  reason: describeSessionResetReason(ctx),
});

const GATE_INPUTS: Array<{ issue: unknown; flag?: boolean }> = [
  { issue: { originKind: "mission_main_executor_plan", title: "create report" } },
  { issue: { originKind: "mission_main_executor_oversight" } },
  { issue: { originKind: "mission_main_executor_unblock" } },
  { issue: { originKind: "x", title: "final review" }, flag: true },
  { issue: { originKind: "x", title: "create report" }, flag: false },
  { issue: { originKind: "x", title: "QA sign-off" } },
  { issue: { originKind: "x", title: "\u017fynthesize notes" } }, // ſ 선행 — iu \b fold → true
  { issue: { originKind: "x", title: "report\u017f" } }, // ſ 후행 — \b 실패 → false
  { issue: { originKind: "x", title: "chec\u212a status" } }, // K 켈빈 — skip 단어 → false
  { issue: { originKind: "x", title: "보고서 작성" } },
  { issue: { originKind: "x", title: "보고서 검토" } }, { issue: { originKind: "x", title: "read the memo" } },
  { issue: { originKind: "x", title: "collect inputs", description: "Deliverable output (use exactly this directory) ARTIFACT: ./out" } },
  { issue: { originKind: "x", title: "read", description: "Deliverable output (use exactly this directory) save.md" } },
  { issue: { originKind: "x", title: "read", description: "ARTIFACT: ./out" } },
  { issue: { originKind: "x", title: "read", description: "Deliverable output (use exactly this directory) `[ARTIFACT]` :" } },
  { issue: { originKind: "x", title: 5 } }, { issue: null }, // 양쪽 TypeError — throw parity
];
const gateCall = (p: { issue: unknown; flag?: boolean }) =>
  canApplyMissingWorkProductRegistrationGate(p.issue as never, p.flag as never);

const META_INPUTS: unknown[] = [
  { graphWorkProductRequired: true }, { graphWorkProductRequired: false },
  { graphWorkProductRequired: "yes" }, {}, null, [true], "meta", undefined,
];

type ProgressInput = Parameters<typeof hasRunProgressEvidenceViaRust>[0];
const date = (ms: number | null) => (ms === null ? null : new Date(ms));
const progressCase = (
  run: { id: unknown; startedAt: number | null; finishedAt: number | null; createdAt: number },
  workProductRunIds: unknown[],
  transitionRunIds: unknown[],
  comments: number[],
): ProgressInput => ({
  run: { id: run.id, startedAt: date(run.startedAt), finishedAt: date(run.finishedAt), createdAt: date(run.createdAt) as Date },
  workProductRunIds: new Set(workProductRunIds),
  transitionRunIds: new Set(transitionRunIds),
  agentCommentTimestamps: comments.map((ms) => new Date(ms)),
});
const windowRun = { id: "r1", startedAt: 1000, finishedAt: 2000, createdAt: 500 };
const PROGRESS_CASES = [
  progressCase(windowRun, ["r1"], [], []), progressCase(windowRun, [], ["r1"], []),
  progressCase(windowRun, [], [], [1500]), // 창 안
  progressCase(windowRun, [], [], [900]), // 창 전
  progressCase(windowRun, [], [], [2000]), // 창 끝(경계 포함)
  progressCase(windowRun, [], [], [2500]), // 창 뒤
  progressCase({ id: "r1", startedAt: 1000, finishedAt: null, createdAt: 500 }, [], [], [1000]), // finishedAt 미기재 → end=start
  progressCase({ id: "r1", startedAt: null, finishedAt: 2000, createdAt: 500 }, [], [], [500]), // startedAt 미기재 → createdAt 창
  progressCase(windowRun, [], [], []), // 무증거 → false
  progressCase({ id: 5, startedAt: 1000, finishedAt: null, createdAt: 500 }, [5], [], []), // 숫자 id 매칭
];
// heartbeat-stability.ts 의 hasRunProgressEvidence 는 wiring 되지 않은 순수 TS 본문 — 기준값.
const tsProgressRef = (input: ProgressInput) => hasRunProgressEvidence(input as never);
const PROGRESS_EMPTY = progressCase(windowRun, [], [], []);

describe("heartbeat-core s2b wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    expect(resetTriplet({})).toEqual({ has: false, should: false, reason: null });
    expect(resetTriplet({ forceFreshSession: true })).toEqual({
      has: false, should: true, reason: "forceFreshSession was requested",
    });
    expect(describeSessionResetReason({ wakeReason: "mission_owner_planning_issue_created" })).toBeNull();
    expect(describeSessionResetReason({ wakeReason: "issue_assigned" })).toBe("wake reason is issue_assigned");
    expect(gateCall({ issue: { originKind: "mission_main_executor_plan" } })).toBe(false);
    expect(gateCall({ issue: { originKind: "x", title: "보고서 작성" } })).toBe(true);
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: true })).toBe(true);
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: "yes" })).toBeUndefined();
    expect(resolveStepRunRequiresWorkProduct(null)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    // TS 팔은 false/false/null — 마커가 Rust 팔임을 증명한다.
    expect(hasWorkflowQaReworkContract({})).toBe(true);
    expect(shouldResetTaskSessionForWake({})).toBe(true);
    expect(describeSessionResetReason({})).toBe("RUST_ARM");
    // TS 팔은 false — gate 마커가 Rust 팔임을 증명한다.
    expect(gateCall({ issue: { originKind: "x" } })).toBe(true);
    // TS 팔은 undefined("yes" 비-boolean) — stepRequires 마커가 라우팅됨을 증명한다.
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: "yes" })).toBe(true);
    // TS 팔은 false(빈 증거) — true 마커가 Rust 팔임을 증명한다.
    expect(hasRunProgressEvidenceViaRust(PROGRESS_EMPTY)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin routes legit Rust null/absent values without TS fallback", () => {
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    // TS 라면 issue_assigned 를 서술 — null 이면 Rust reason null 이 라우팅된 것이다.
    expect(describeSessionResetReason({ wakeReason: "issue_assigned null_probe" })).toBeNull();
    // TS 라면 true — false 이면 Rust shouldReset false 가 폴백 아닌 정상 라우팅된 것이다.
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned null_probe" })).toBe(false);
    // TS 라면 true — undefined 이면 Rust stepRequires absent 가 라우팅된 것이다.
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: true, probe: "null_probe" })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS arm on all session-reset edge inputs", () => {
    const expected = RESET_INPUTS.map(resetTriplet); // 게이트 OFF — TS 기준값
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    RESET_INPUTS.forEach((ctx, i) => expect(resetTriplet(ctx)).toEqual(expected[i]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS arm on all gate edge inputs incl. ſ/K titles", () => {
    const expected = GATE_INPUTS.map((p) => outcomeOf(() => gateCall(p)));
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    GATE_INPUTS.forEach((p, i) => expect(outcomeOf(() => gateCall(p))).toEqual(expected[i]));
    // issue null·비문자열 title 케이스만 TS-throw 미러로 exit 1 → 경고 1회(warn-once).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("live Rust arm matches the TS arm on stepRequires 3-state inputs", () => {
    const expected = META_INPUTS.map((m) => resolveStepRunRequiresWorkProduct(m));
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    META_INPUTS.forEach((m, i) => expect(resolveStepRunRequiresWorkProduct(m)).toBe(expected[i]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("live progress-evidence wrapper matches the TS body across Date windows", () => {
    const expected = PROGRESS_CASES.map(tsProgressRef);
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    PROGRESS_CASES.forEach((input, i) => expect(hasRunProgressEvidenceViaRust(input)).toBe(expected[i]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("broken binaries fall back to TS without throwing (bad_json / exit_1 / spawn_error)", () => {
    const refs = { reset: resetTriplet({}), gate: gateCall({ issue: { originKind: "x", title: "create report" } }), meta: resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: true }) };
    for (const [bin, reason] of [[garbageBin, "bad_json"], [failingBin, "exit_1"], [path.join(dir, "does-not-exist"), "spawn_error"]] as const) {
      vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", bin);
      expect(resetTriplet({})).toEqual(refs.reset);
      expect(gateCall({ issue: { originKind: "x", title: "create report" } })).toBe(refs.gate);
      expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: true })).toBe(refs.meta);
      expect(hasRunProgressEvidenceViaRust(PROGRESS_EMPTY)).toBeNull();
      const fallbackWarnings = warn.mock.calls.map(([message]) => message).filter(
        (message) => typeof message === "string" && message.startsWith("[heartbeat-core-s2b] Rust helper fallback to Node ("),
      );
      expect(fallbackWarnings).toHaveLength(3);
      expect(fallbackWarnings).toContainEqual(expect.stringContaining(reason));
      resetHeartbeatCoreS2bFallbackWarningsForTests();
      warn.mockClear();
    }
  });

  it("relative env path keeps the gate closed silently", () => {
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", "relative/bin");
    expect(resetTriplet({ forceFreshSession: true })).toEqual({ has: false, should: true, reason: "forceFreshSession was requested" });
    expect(gateCall({ issue: { originKind: "x", title: "create report" } })).toBe(true);
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: false })).toBe(false);
    expect(hasRunProgressEvidenceViaRust(PROGRESS_EMPTY)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("lone surrogate input rides the Rust parse rejection into the TS fallback", () => {
    const issue = { originKind: "x", title: "create report \ud800" };
    const expectedGate = gateCall({ issue });
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    expect(() => gateCall({ issue })).not.toThrow();
    expect(gateCall({ issue })).toBe(expectedGate);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("non-JSON-safe payload (BigInt) falls back to TS without throwing", () => {
    const metadata = { graphWorkProductRequired: 1n }, ctx = { wakeReason: 1n };
    const expectedMeta = resolveStepRunRequiresWorkProduct(metadata), expectedReset = resetTriplet(ctx);
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    expect(() => resolveStepRunRequiresWorkProduct(metadata)).not.toThrow();
    expect(resolveStepRunRequiresWorkProduct(metadata)).toBe(expectedMeta);
    expect(resetTriplet(ctx)).toEqual(expectedReset);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("invalid Date / non-Date input rides the pre-spawn guard to the TS arm silently", () => {
    const input: ProgressInput = { run: { id: "r1", startedAt: new Date("not-a-date"), finishedAt: null, createdAt: new Date(500) }, workProductRunIds: new Set<string>(), transitionRunIds: new Set<string>(), agentCommentTimestamps: [new Date(600)] };
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    expect(hasRunProgressEvidenceViaRust(input)).toBeNull();
    expect(hasRunProgressEvidenceViaRust({ ...input, agentCommentTimestamps: [1500] })).toBeNull();
    expect(hasRunProgressEvidenceViaRust({ ...input, run: { id: "r1", startedAt: 5, finishedAt: null, createdAt: new Date(500) } })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
