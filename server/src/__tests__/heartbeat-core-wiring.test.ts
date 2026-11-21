import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  classifyHeartbeatRunFailure,
  containsToolLimitLifecycleFailure,
  heartbeatRunFailureText,
} from "../services/heartbeat-failure-classification.js";
import { detectCodexAuthFailureForAutoBlock } from "../services/heartbeat-codex-auth-classification.js";
import { resetHeartbeatCoreFallbackWarningsForTests } from "../services/heartbeat-core-client.js";

/**
 * [목적] heartbeat-core-client 동기 시임의 서비스 wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_HEARTBEAT_CORE_BIN 미설정) → 스폰 없는 TS 경로가 기존과 동일.
 *   - 설정 + 실 release bin → Rust 팔이 실행되고 TS 결과와 동일.
 *   - 고장 bin(비JSON/non-zero/없는 경로) → 던지지 않고 TS 로 투명 폴백.
 *   - detect-codex-auth-failure 의 정상 null(미검출)은 폴백이 아니라 Rust 결과로 통과한다.
 *   - lone surrogate 입력은 Rust serde 거부(exit 1) → TS 폴백이 parity 를 보장.
 *   전수 parity 는 heartbeat-core-stage1-parity.test.ts 가 담당한다(범위 밖).
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
  classify-run-failure) echo '{"category":"adapter","reasonCode":"RUST_ARM","summary":"rust-arm","fallbackCandidates":["rust-arm-cand"]}' ;;
  run-failure-text) echo '"rust-arm-text"' ;;
  contains-tool-limit-failure) echo 'true' ;;
  detect-codex-auth-failure) case "$in" in *null_probe*) echo 'null' ;; *) echo '{"reasonCode":"CODEX_AUTH_RUST_ARM","authErrorCode":"rust_arm"}' ;; esac ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/heartbeat-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "heartbeat-core-wiring-"));
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
  resetHeartbeatCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const toolLimit = containsToolLimitLifecycleFailure as unknown as (run: unknown) => boolean;
const CLASSIFY_INPUT = { status: "failed", errorCode: "claude_api_error_529", stderrExcerpt: "ENOENT: no such file" };
const TEXT_INPUT = { errorCode: "  E1  ", errorMessage: "m", stderrExcerpt: "e" };
const RUN_INPUT = { stdoutExcerpt: "", stderrExcerpt: "", error: "plain adapter failure" };
const CODEX_INPUT = { adapterType: "codex_local", errorMessage: "auth error code: token_expired\nauth error: 401" };
const CODEX_MISS_INPUT = { adapterType: "codex_local", errorMessage: "no auth signal here" };

/** 게이트 OFF 상태(테스트 기본)에서의 TS 기준값 — 각 테스트 첫 줄에서 계산한다. */
const tsReferences = () => ({
  classify: classifyHeartbeatRunFailure(CLASSIFY_INPUT),
  text: heartbeatRunFailureText(TEXT_INPUT),
  limit: toolLimit(RUN_INPUT),
  codex: detectCodexAuthFailureForAutoBlock(CODEX_INPUT),
});

describe("heartbeat-core stage1 wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    const { classify, text, limit, codex } = tsReferences();
    expect(classify).toMatchObject({ category: "overload", reasonCode: "PROVIDER_OVERLOADED_529" });
    expect(text).toBe("E1  \nm\ne");
    expect(limit).toBe(false);
    expect(codex).toEqual({ reasonCode: "CODEX_AUTH_401_TOKEN_EXPIRED", authErrorCode: "token_expired" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    expect(classifyHeartbeatRunFailure(CLASSIFY_INPUT)).toEqual({
      category: "adapter", reasonCode: "RUST_ARM", summary: "rust-arm", fallbackCandidates: ["rust-arm-cand"],
    });
    expect(heartbeatRunFailureText(TEXT_INPUT)).toBe("rust-arm-text");
    expect(toolLimit(RUN_INPUT)).toBe(true); // TS 팔은 false — marker 가 Rust 팔을 증명
    expect(detectCodexAuthFailureForAutoBlock(CODEX_INPUT)).toEqual({
      reasonCode: "CODEX_AUTH_RUST_ARM", authErrorCode: "rust_arm",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin routes a legit Rust null (no detection) without TS fallback", () => {
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", cannedBin);
    // TS 팔이라면 token_expired 를 검출해 non-null — null 이 나오면 Rust null 이 라우팅된 것.
    expect(detectCodexAuthFailureForAutoBlock({
      adapterType: "codex_local",
      errorMessage: "auth error code: token_expired null_probe",
    })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS arm on all wired entries", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin);
    expect(classifyHeartbeatRunFailure(CLASSIFY_INPUT)).toEqual(expected.classify);
    expect(heartbeatRunFailureText(TEXT_INPUT)).toBe(expected.text);
    expect(toolLimit(RUN_INPUT)).toBe(expected.limit);
    expect(detectCodexAuthFailureForAutoBlock(CODEX_INPUT)).toEqual(expected.codex);
    // Rust 정상 null(미검출)도 폴백 없이 동일하게 통과한다.
    expect(detectCodexAuthFailureForAutoBlock(CODEX_MISS_INPUT)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-JSON stdout falls back to TS with a contract warning", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", garbageBin);
    expect(classifyHeartbeatRunFailure(CLASSIFY_INPUT)).toEqual(expected.classify);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", failingBin);
    expect(classifyHeartbeatRunFailure(CLASSIFY_INPUT)).toEqual(expected.classify);
    expect(heartbeatRunFailureText(TEXT_INPUT)).toBe(expected.text);
    expect(toolLimit(RUN_INPUT)).toBe(expected.limit);
    expect(detectCodexAuthFailureForAutoBlock(CODEX_INPUT)).toEqual(expected.codex);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(classifyHeartbeatRunFailure(CLASSIFY_INPUT)).toEqual(expected.classify);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("relative env path keeps the gate closed silently", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", "relative/bin");
    expect(classifyHeartbeatRunFailure(CLASSIFY_INPUT)).toEqual(expected.classify);
    expect(detectCodexAuthFailureForAutoBlock(CODEX_INPUT)).toEqual(expected.codex);
    expect(warn).not.toHaveBeenCalled();
  });

  it("lone surrogate input rides the Rust parse rejection into the TS fallback", () => {
    const input = { ...CLASSIFY_INPUT, errorMessage: "실패 \uD800 메시지" };
    const expected = classifyHeartbeatRunFailure(input); // 게이트 OFF — TS 기준값
    vi.stubEnv("PAPERCLIP_HEARTBEAT_CORE_BIN", rustBin); // serde 가 lone surrogate 입력을 거부(exit 1)
    expect(() => classifyHeartbeatRunFailure(input)).not.toThrow();
    expect(classifyHeartbeatRunFailure(input)).toEqual(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });
});
