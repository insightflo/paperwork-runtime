import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { readExplicitValidationVerdict } from "../services/validation-verdict.js";
import { resolveQualityVerdictRouting } from "../services/quality-verdict-routing.js";
import { resetVerdictCoreFallbackWarningsForTests } from "../services/verdict-core-client.js";

/**
 * [목적] verdict-core-client 동기 시임의 서비스 wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_VERDICT_CORE_BIN 미설정) → 스폰 없는 TS 경로가 기존과 동일.
 *   - 설정 + 실 release bin → Rust 팔이 실행되고 TS 결과와 1:1 동일.
 *   - 고장 bin(비JSON/non-zero/없는 경로) → 던지지 않고 TS 로 투명 폴백.
 *   - canned 응답은 TS 결과와 다른 rust-arm marker — Rust 팔 실행 자체를 증명한다.
 *   전수 parity 는 verdict-core-stage1-parity.test.ts 가 담당한다(범위 밖).
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/verdict-core/target/release/paperclip-verdict-core");

let dir: string;
let cannedBin: string;
let cannedNullBin: string;
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
  read-explicit-validation-verdict) echo '"request_changes"' ;;
  resolve-quality-verdict-routing) echo '{"kind":"correction","verdict":"request_changes","reason":"rust-arm","failureType":"rust-arm"}' ;;
esac`;
// shape-유효 성공(JSON null = 판정 없음) — bad_shape 폴백이 아니라 정상 Rust 결과로 흘러야 한다.
const CANNED_NULL_SCRIPT = "cat >/dev/null; echo null";

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/verdict-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "verdict-core-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  cannedNullBin = await writeBin("canned-null", CANNED_NULL_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; echo 'boom' >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetVerdictCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 게이트 OFF 상태(테스트 기본)에서의 TS 기준값 — 각 테스트 첫 줄에서 계산한다. */
const tsReferences = () => ({
  heading: readExplicitValidationVerdict("text\n## QA verdict\n\nPASS\ntail"),
  terminal: readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES"),
  leading: readExplicitValidationVerdict("PASS first\nthen nothing verdictable"),
  leadingAllowed: readExplicitValidationVerdict("PASS first\nthen nothing verdictable", { allowLeadingVerdict: true }),
  noVerdict: readExplicitValidationVerdict("no verdict anywhere in this prose"),
  evidence: resolveQualityVerdictRouting({ verdict: "needs_evidence", requiredEvidenceSurfaces: [" a ", "", "  b\t"] }),
  correction: resolveQualityVerdictRouting({ verdict: "fail", reason: "bug", failureType: "logic" }),
  none: resolveQualityVerdictRouting({ verdict: "totally unknown verdict" }),
});

describe("verdict-core wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    const refs = tsReferences();
    expect(refs.heading).toBe("pass");
    expect(refs.terminal).toBe("request_changes");
    expect(refs.leading).toBeNull();
    expect(refs.leadingAllowed).toBe("pass");
    expect(refs.noVerdict).toBeNull();
    expect(refs.evidence).toEqual({ kind: "evidence", reason: null, requiredEvidenceSurfaces: ["a", "b"] });
    expect(refs.correction).toEqual({ kind: "correction", verdict: "fail", reason: "bug", failureType: "logic" });
    expect(refs.none).toEqual({ kind: "none" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", cannedBin);
    // TS 라면 null 이어야 하는 입력 — "request_changes" 는 canned rust-arm marker 다.
    expect(readExplicitValidationVerdict("no verdict anywhere in this prose")).toBe("request_changes");
    // TS 라면 {kind:"none"} 이어야 하는 입력 — canned correction 객체가 그대로 흘러나온다.
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toEqual({
      kind: "correction", verdict: "request_changes", reason: "rust-arm", failureType: "rust-arm",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned null verdict response is a valid success shape, not a fallback", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", cannedNullBin);
    // TS 라면 request_changes — Rust 성공 응답 JSON null(판정 없음)이 그대로 나온다.
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toBeNull();
    expect(warn).not.toHaveBeenCalled(); // bad_shape 폴백 경고가 없어야 한다
  });

  it("live Rust arm matches the TS arm 1:1 on all wired entries", () => {
    const refs = tsReferences();
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", rustBin);
    expect(readExplicitValidationVerdict("text\n## QA verdict\n\nPASS\ntail")).toEqual(refs.heading);
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toEqual(refs.terminal);
    expect(readExplicitValidationVerdict("PASS first\nthen nothing verdictable")).toEqual(refs.leading);
    expect(readExplicitValidationVerdict("PASS first\nthen nothing verdictable", { allowLeadingVerdict: true })).toEqual(refs.leadingAllowed);
    expect(readExplicitValidationVerdict("no verdict anywhere in this prose")).toEqual(refs.noVerdict);
    expect(resolveQualityVerdictRouting({ verdict: "needs_evidence", requiredEvidenceSurfaces: [" a ", "", "  b\t"] })).toEqual(refs.evidence);
    expect(resolveQualityVerdictRouting({ verdict: "fail", reason: "bug", failureType: "logic" })).toEqual(refs.correction);
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toEqual(refs.none);
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-JSON stdout falls back to TS with a contract warning", () => {
    const refs = tsReferences();
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", garbageBin);
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toEqual(refs.terminal);
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toEqual(refs.none);
    expect(warn).toHaveBeenCalledTimes(2); // warn-once 는 시임별 키 — 두 시임 각 1회
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const refs = tsReferences();
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", failingBin);
    expect(() => readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).not.toThrow();
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toEqual(refs.terminal);
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toEqual(refs.none);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    const refs = tsReferences();
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toEqual(refs.terminal);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("relative env path keeps the gate closed silently", () => {
    const refs = tsReferences();
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", "relative/paperclip-verdict-core");
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toEqual(refs.terminal);
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toEqual(refs.none);
    // 스폰 시도가 있었다면 spawn_error 경고가 떴을 것이다 — 없음 = 게이트 폐쇄 증명.
    expect(warn).not.toHaveBeenCalled();
  });

  it("lone surrogate input rides the Rust serde rejection into the TS fallback", () => {
    const value = "판정: \uD800 손상";
    const expected = readExplicitValidationVerdict(value); // 게이트 OFF — TS 기준값
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", rustBin); // serde 가 lone surrogate 입력을 거부(exit 1)
    expect(() => readExplicitValidationVerdict(value)).not.toThrow();
    expect(readExplicitValidationVerdict(value)).toEqual(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });
});
