import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as stab from "../services/heartbeat-stability.js";
import * as runctx from "../services/heartbeat-run-context.js";
import { resetHeartbeatCoreS2aFallbackWarningsForTests } from "../services/heartbeat-core-client-s2a.js";

/**
 * [목적] heartbeat-core-client-s2a 동기 시임의 서비스 wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_HEARTBEAT_CORE_BIN 미설정) → 스폰 없는 TS 경로가 기존과 동일.
 *   - 설정 + 실 release bin → Rust 팔이 실행되고 TS 결과와 동일.
 *   - 고장 bin(비JSON/non-zero/없는 경로/상대경로) → 던지지 않고 TS 로 투명 폴백.
 *   - 번들 서브커맨드(stability-env/-compute·run-context)는 함수가 필요한 키만 골라 쓰고,
 *     runTaskKey 는 deriveTaskKey 경유로 스폰을 공유한다.
 *   - lone surrogate·비JSON 안전 입력(순환·비유한수·비평범 객체·undefined·동일 참조 비교)은
 *     스폰 전 가드가 TS 팔로 보낸다.
 *   전수 parity 는 heartbeat-core-stage2-parity.test.ts 가 담당한다(범위 밖).
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

/** canned 응답은 전부 TS 결과와 다른 rust-arm marker — Rust 팔 실행을 증명한다. */
const CANNED_SCRIPT = `in=$(cat)
case "$1" in
  stability-env) echo '{"qaStepActiveExecutionTimeoutMs":1,"runawayLogLimitBytes":2,"adapterFailedTransientRetryMaxSec":3,"noProgressAdvisoryThreshold":4,"noProgressAutoBlockThreshold":5,"noProgressWindowMs":6,"provider403RetryDelaysMin":[7],"provider403ReasonCodes":["RUST_ARM"]}' ;;
  stability-compute) echo '{"runawayAdvisorySoftBytes":424242,"stepAwareTimeoutMs":777,"stepTimeoutSignals":{"stepTimeoutSeconds":9,"isQaStep":true}}' ;;
  run-context) echo '{"readNonEmptyString":"rust-arm","taskKey":"rust-task","fallbackAttempt":9,"agentNameKey":"rust-agent","sameTaskScope":true}' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/heartbeat-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "heartbeat-core-s2a-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; echo 'boom' >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetHeartbeatCoreS2aFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const env = (p: Record<string, unknown>) => p as NodeJS.ProcessEnv;

/** 배선된 공개 함수 전체를 한 입력으로 실행한 스냅샷 — 게이트 OFF(TS 기준)와 ON(Rust)을 비교한다. */
const wireEnv = (e: NodeJS.ProcessEnv, cfg?: Record<string, unknown> | null) => ({
  qa: stab.resolveQaStepActiveExecutionTimeoutMs(e),
  runaway: stab.resolveRunawayLogLimitBytes(cfg, e),
  transient: stab.resolveAdapterFailedTransientRetryMaxSec(e),
  advisory: stab.resolveNoProgressAdvisoryThreshold(e),
  autoBlock: stab.resolveNoProgressAutoBlockThreshold(e),
  window: stab.resolveNoProgressWindowMs(e),
  delays: stab.resolveProvider403RetryDelaysMin(e),
  codes: stab.resolveProvider403LadderReasonCodes(e),
});
const wireCompute = () => ({
  soft: stab.resolveRunawayAdvisorySoftBytes(16 * 1024 * 1024),
  stepAware: stab.resolveStepAwareActiveExecutionTimeoutMs({
    baseMs: 100, contract: { stepTimeoutSeconds: 10 }, qaStepActiveExecutionTimeoutMs: 2000,
  }),
  signals: stab.stepTimeoutSignalsFromStep({ timeoutSeconds: 5.9, type: " QA " }),
});
const wireCtx = () => ({
  read: runctx.readNonEmptyString("  a b  "),
  taskKey: runctx.deriveTaskKey({ taskKey: "  ", taskId: "t" }, { taskKey: "pk" }),
  runKey: runctx.runTaskKey({ contextSnapshot: { issueId: " i " } } as never),
  attempt: runctx.resolveAdapterFallbackAttempt({ fallbackAttempt: 3.9 }),
  agent: runctx.normalizeAgentNameKey("  AG Ent X  "),
  scope: runctx.isSameTaskScope("a", "b"),
});

describe("heartbeat-core stage2a wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    expect(wireEnv(env({}), { runawayLogLimitBytes: 5e6 })).toEqual({
      qa: 1_800_000, runaway: 5_000_000, transient: 300, advisory: 2, autoBlock: 3,
      window: 21_600_000, delays: [5, 15, 30],
      codes: ["PROVIDER_AUTH_OR_FORBIDDEN_403", "PROVIDER_QUOTA_OR_AUTH_403"],
    });
    expect(wireCompute()).toEqual({ soft: 10_066_329, stepAware: 10_000, signals: { stepTimeoutSeconds: 5, isQaStep: true } });
    expect(wireCtx()).toEqual({ read: "a b", taskKey: "t", runKey: "i", attempt: 3, agent: "ag ent x", scope: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and every wired key routes through", () => {
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    expect(wireEnv(env({}), null)).toEqual({
      qa: 1, runaway: 2, transient: 3, advisory: 4, autoBlock: 5, window: 6,
      delays: [7], codes: ["RUST_ARM"],
    });
    expect(wireCompute()).toEqual({ soft: 424242, stepAware: 777, signals: { stepTimeoutSeconds: 9, isQaStep: true } });
    expect(wireCtx()).toEqual({
      read: "rust-arm", taskKey: "rust-task", runKey: "rust-task",
      attempt: 9, agent: "rust-agent", scope: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("relative env path keeps the gate closed silently", () => {
    const expected = wireEnv(env({}), null);
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", "relative/bin");
    expect(wireEnv(env({}), null)).toEqual(expected);
    expect(wireCtx()).toEqual({ read: "a b", taskKey: "t", runKey: "i", attempt: 3, agent: "ag ent x", scope: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    const expected = wireEnv(env({}), null);
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(() => wireEnv(env({}), null)).not.toThrow();
    expect(wireEnv(env({}), null)).toEqual(expected);
    expect(wireCtx().taskKey).toBe("t");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("non-JSON stdout falls back to TS with a contract warning", () => {
    const expected = wireCompute();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", garbageBin);
    expect(() => wireCompute()).not.toThrow();
    expect(wireCompute()).toEqual(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const expectedEnv = wireEnv(env({}), null);
    const expectedCtx = wireCtx();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", failingBin);
    expect(wireEnv(env({}), null)).toEqual(expectedEnv);
    expect(wireCompute().soft).toBe(10_066_329);
    expect(wireCtx()).toEqual(expectedCtx);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("live Rust arm matches the TS arm across normal and edge inputs", () => {
    const envInputs = [
      {},
      { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "0" },
      { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "900.9" },
      { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "0x10" },
      { PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: "\uFEFF60\uFEFF" },
      {
        PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "1234567.9",
        PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC: "120",
        PAPERCLIP_NO_PROGRESS_WINDOW_SEC: "7200",
      },
      { PAPERCLIP_NO_PROGRESS_ADVISORY_THRESHOLD: "1e1", PAPERCLIP_NO_PROGRESS_AUTO_BLOCK_THRESHOLD: "0" },
      { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "2x, 7, -3, 0, 15.9", PAPERCLIP_PROVIDER_403_RETRY_REASON_CODES: "a_b, A_B,, c-d" },
      { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: " off ", PAPERCLIP_PROVIDER_403_RETRY_REASON_CODES: "NONE" },
    ];
    const fns: Array<() => unknown> = [
      ...envInputs.map((e) => () => wireEnv(env(e))),
      () => wireEnv(env({}), { runawayLogLimitBytes: 5e6 }),
      () => wireEnv(env({}), { runawayLogLimitBytes: -3 }),
      () => wireEnv(env({ PAPERCLIP_RUNAWAY_LOG_LIMIT_BYTES: "9e6" }), { runawayLogLimitBytes: "9e6" }),
      () => stab.resolveRunawayAdvisorySoftBytes(900_000),
      () => stab.resolveRunawayAdvisorySoftBytes(0),
      () => stab.resolveRunawayAdvisorySoftBytes("9000000" as never),
      () => stab.resolveRunawayAdvisorySoftBytes(true as never),
      () => stab.resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 0, contract: { stepTimeoutSeconds: 10 }, qaStepActiveExecutionTimeoutMs: 2000 }),
      () => stab.resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 100, contract: null, qaStepActiveExecutionTimeoutMs: 2000 }),
      () => stab.resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 100, contract: { isQaStep: true }, qaStepActiveExecutionTimeoutMs: 2000 }),
      () => stab.resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 100, contract: { isQaStep: true }, qaStepActiveExecutionTimeoutMs: 0 }),
      () => stab.resolveStepAwareActiveExecutionTimeoutMs({ baseMs: "abc" as never, contract: null, qaStepActiveExecutionTimeoutMs: 0 }),
      () => stab.stepTimeoutSignalsFromStep({ timeoutSeconds: -2 }),
      () => stab.stepTimeoutSignalsFromStep({ qaType: "delivery" }),
      () => stab.stepTimeoutSignalsFromStep({ type: "approval" }),
      () => runctx.readNonEmptyString("\uFEFF\uFEFF"),
      () => runctx.readNonEmptyString("\u0085x"),
      () => runctx.readNonEmptyString(5),
      () => runctx.deriveTaskKey({ taskKey: " K1 " }, { taskId: "p" }),
      () => runctx.deriveTaskKey({ taskKey: "  " }, { issueId: "pi" }),
      () => runctx.deriveTaskKey(null, null),
      () => runctx.deriveTaskKey(5 as never, { taskKey: "x" }),
      () => runctx.resolveAdapterFallbackAttempt({ fallbackAttempt: -2 }),
      () => runctx.resolveAdapterFallbackAttempt([1, 2]),
      () => runctx.resolveAdapterFallbackAttempt("x"),
      () => runctx.normalizeAgentNameKey(" \u00A0 "),
      () => runctx.normalizeAgentNameKey(5 as never),
      () => runctx.isSameTaskScope(null, null),
      () => runctx.isSameTaskScope("a", "a"),
      () => runctx.isSameTaskScope(5 as never, "5" as never),
      () => stab.resolveQaStepActiveExecutionTimeoutMs(), // 기본 env — Env::Real 경로
    ];
    const expected = fns.map((f) => f()); // 게이트 OFF — TS 팔 기준값
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    fns.forEach((f, i) => expect(f()).toEqual(expected[i]));
    expect(warn).not.toHaveBeenCalled(); // 폴백 0건 — 전 입력이 Rust 팔로 통과
  });

  it("live Rust arm preserves TS throws on rejecting inputs", () => {
    const fns = [
      () => stab.resolveQaStepActiveExecutionTimeoutMs(env({ PAPERCLIP_QA_STEP_ACTIVE_EXECUTION_TIMEOUT_MS: 5 })),
      () => stab.resolveQaStepActiveExecutionTimeoutMs(null as never),
      () => stab.stepTimeoutSignalsFromStep(null as never),
    ];
    const attempt = (f: () => unknown) => { try { f(); return null; } catch (e) { return String(e); } };
    const expected = fns.map(attempt);
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    fns.forEach((f, i) => {
      const actual = attempt(f);
      expect(actual).toBe(expected[i]);
      expect(actual).not.toBeNull();
    });
  });

  it("lone-surrogate inputs take the TS arm via the pre-spawn guard", () => {
    const fns: Array<() => unknown> = [
      () => runctx.readNonEmptyString("ab\uD800cd"),
      () => runctx.deriveTaskKey({ taskKey: "k\uD800z" }, null),
      () => runctx.normalizeAgentNameKey(" A\uDC00B "),
    ];
    const expected = fns.map((f) => f()); // 게이트 OFF — TS 기준값(실제 서러게이트 보존)
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    fns.forEach((f, i) => expect(f()).toEqual(expected[i]));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lone_surrogate_input"));
  });

  it("non-JSON-safe inputs fall back cleanly to TS", () => {
    const circular: Record<string, unknown> = { taskKey: "k" };
    circular.self = circular;
    const shared = { x: 1 };
    const fns: Array<() => unknown> = [
      () => runctx.readNonEmptyString(new Date()),
      () => runctx.deriveTaskKey(circular, null),
      () => runctx.resolveAdapterFallbackAttempt({ fallbackAttempt: undefined }),
      () => runctx.isSameTaskScope(shared as never, shared as never), // === 참조 비교 — Rust 는 못 미러
      () => stab.resolveRunawayAdvisorySoftBytes(Number.POSITIVE_INFINITY),
      () => stab.resolveRunawayLogLimitBytes({ runawayLogLimitBytes: Number.NaN }),
      () => stab.resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 100, contract: undefined, qaStepActiveExecutionTimeoutMs: 50 }),
      () => stab.stepTimeoutSignalsFromStep({ timeoutSeconds: 1, self: undefined }),
    ];
    const expected = fns.map((f) => f()); // 게이트 OFF — TS 기준값
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    fns.forEach((f, i) => {
      expect(() => f()).not.toThrow();
      expect(f()).toEqual(expected[i]);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("non_json_safe_input"));
  });
});
