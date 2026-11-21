// [목적] tool-hygiene-core-client 동기 시임의 서비스 wiring 검증.
//   - 게이트 OFF(PAPERCLIP_TOOL_HYGIENE_CORE_BIN 미설정) → 스폰 없는 TS 경로가 기존과 동일.
//   - 상대경로·없는 bin·비JSON·non-zero → 던지지 않고 TS 로 투명 폴백(warn-once).
//   - 실 release bin → 6개 시임 전부 TS 결과와 동일(parity).
//   - lone surrogate·비JSON 안전 입력(함수/symbol/순환/undefined)은 스폰 전에 걸러 TS 팔이
//     parity 를 보장한다.
//   전수 differential parity 는 tool-hygiene-core-stage1-parity.test.ts 가 담당한다(범위 밖).
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  computeAgentToolFingerprint,
  hasToolSurfaceChanged,
  type AgentToolFingerprintInput,
} from "../services/tool-fingerprint.js";
import {
  condenseDuplicateToolErrorBody,
  normalizeToolErrorSignature,
  resetToolErrorHygieneForTests,
} from "../services/tool-result-hygiene.js";
import { isSensitiveToolEnvKey } from "../services/tool-env-sensitivity.js";
import {
  hasLoneSurrogate,
  resetToolHygieneCoreFallbackWarningsForTests,
} from "../services/tool-hygiene-core-client.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/tool-hygiene-core/target/release/paperclip-tool-hygiene-core");

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
  compute-agent-tool-fingerprint) echo '"rust-arm-fp"' ;;
  has-tool-surface-changed) echo '{"changed":true,"currentFingerprint":"rust-arm-fp"}' ;;
  normalize-tool-error-signature) echo '"rust-arm-norm"' ;;
  tool-error-signature-key) echo '"rust-arm-key"' ;;
  condense-tool-error-text) echo '"rust-arm-condensed"' ;;
  is-sensitive-tool-env-key) echo 'true' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/tool-hygiene-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "tool-hygiene-core-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; echo 'boom' >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetToolHygieneCoreFallbackWarningsForTests();
  resetToolErrorHygieneForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type FpInput = Parameters<typeof computeAgentToolFingerprint>[0];
const FP_INPUT: FpInput = {
  adapterType: "pi",
  model: "gpt-5",
  instructionsText: "follow rules",
  mcpServers: [{ name: "b" }, { name: "a", args: ["-y", "mcp"], disabledTools: ["x", "x", " y "] }],
  allowedTools: ["write", "read", "write", " exec "],
  envKeys: { B: "two", A: "one" },
};
const NORM_TEXT = "  Error 404 \t Not  Found12  ";
const CONDENSE_INPUT = { runId: "wiring", tool: "search", status: 500, body: { error: "HTTP 400 bad request" } };

/** condenseDuplicateToolErrorBody 2회 — private signatureKey·condense 시임을 공개 면으로 두루고,
 *   signatures Map 을 리셋해 TS 기준값과 Rust 팔 실행을 독립으로 만든다. */
function condenseTwice(): Array<{ error: unknown; duplicateCount: number }> {
  resetToolErrorHygieneForTests();
  const out: Array<{ error: unknown; duplicateCount: number }> = [];
  for (let i = 0; i < 2; i += 1) {
    const r = condenseDuplicateToolErrorBody(CONDENSE_INPUT);
    out.push({ error: r.body.error, duplicateCount: r.duplicateCount });
  }
  return out;
}

/** 게이트 OFF 상태(테스트 기본)에서의 TS 기준값 — 각 테스트 첫 줄에서 계산한다. */
const tsReferences = () => ({
  fp: computeAgentToolFingerprint(FP_INPUT),
  changed: hasToolSurfaceChanged("deadbeef", FP_INPUT),
  unchanged: hasToolSurfaceChanged(computeAgentToolFingerprint(FP_INPUT), FP_INPUT),
  norm: normalizeToolErrorSignature(NORM_TEXT),
  sensTrue: isSensitiveToolEnvKey("API_KEY"),
  sensFalse: isSensitiveToolEnvKey("HOME"),
  condensed: condenseTwice(),
});

describe("tool-hygiene-core wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    const ref = tsReferences();
    expect(ref.fp).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.changed).toEqual({ changed: true, currentFingerprint: ref.fp });
    expect(ref.unchanged).toEqual({ changed: false, currentFingerprint: ref.fp });
    expect(ref.norm).toBe("error # not found#");
    expect(ref.sensTrue).toBe(true);
    expect(ref.sensFalse).toBe(false);
    expect(ref.condensed[0]).toEqual({ error: CONDENSE_INPUT.body.error, duplicateCount: 1 });
    expect(String(ref.condensed[1].error)).toContain("[duplicate tool error ×2");
    expect(ref.condensed[1].duplicateCount).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", cannedBin);
    expect(computeAgentToolFingerprint(FP_INPUT)).toBe("rust-arm-fp");
    expect(hasToolSurfaceChanged("x", FP_INPUT)).toEqual({ changed: true, currentFingerprint: "rust-arm-fp" });
    expect(normalizeToolErrorSignature(NORM_TEXT)).toBe("rust-arm-norm");
    expect(isSensitiveToolEnvKey("HOME")).toBe(true); // TS 는 false — rust-arm marker
    // signature-key canned 마커가 Map 키가 되고, 2회째 condense 마커가 몸통을 대체한다.
    expect(condenseTwice()).toEqual([
      { error: CONDENSE_INPUT.body.error, duplicateCount: 1 },
      { error: "rust-arm-condensed", duplicateCount: 2 },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS arm on all six wired entries", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", rustBin);
    expect(computeAgentToolFingerprint(FP_INPUT)).toBe(expected.fp);
    expect(hasToolSurfaceChanged("deadbeef", FP_INPUT)).toEqual(expected.changed);
    expect(hasToolSurfaceChanged(computeAgentToolFingerprint(FP_INPUT), FP_INPUT)).toEqual(expected.unchanged);
    expect(normalizeToolErrorSignature(NORM_TEXT)).toBe(expected.norm);
    expect(isSensitiveToolEnvKey("API_KEY")).toBe(expected.sensTrue);
    expect(isSensitiveToolEnvKey("HOME")).toBe(expected.sensFalse);
    expect(condenseTwice()).toEqual(expected.condensed);
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-JSON stdout falls back to TS with a contract warning", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", garbageBin);
    expect(computeAgentToolFingerprint(FP_INPUT)).toBe(expected.fp);
    expect(normalizeToolErrorSignature(NORM_TEXT)).toBe(expected.norm);
    expect(isSensitiveToolEnvKey("HOME")).toBe(expected.sensFalse);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", failingBin);
    expect(computeAgentToolFingerprint(FP_INPUT)).toBe(expected.fp);
    expect(hasToolSurfaceChanged("deadbeef", FP_INPUT)).toEqual(expected.changed);
    expect(normalizeToolErrorSignature(NORM_TEXT)).toBe(expected.norm);
    expect(condenseTwice()).toEqual(expected.condensed);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(computeAgentToolFingerprint(FP_INPUT)).toBe(expected.fp);
    expect(normalizeToolErrorSignature(NORM_TEXT)).toBe(expected.norm);
    expect(warn).toHaveBeenCalledTimes(2); // 서브커맨드별 warn-once — fp + normalize 각 1회
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("relative env path keeps the gate closed silently", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", "relative/bin");
    expect(computeAgentToolFingerprint(FP_INPUT)).toBe(expected.fp);
    expect(normalizeToolErrorSignature(NORM_TEXT)).toBe(expected.norm);
    expect(warn).not.toHaveBeenCalled();
  });

  it("lone surrogate input rides the pre-spawn guard into the TS fallback", () => {
    expect(hasLoneSurrogate("\uD800")).toBe(true);
    expect(hasLoneSurrogate("trailing \uDC00")).toBe(true);
    expect(hasLoneSurrogate("𐀀 🚀")).toBe(false); // 올바른 쌍·우선순위 쌍은 안전
    const input = { ...FP_INPUT, instructionsText: "배포 파이프라인이 \uD800 손상으로 중단됨" };
    const expected = computeAgentToolFingerprint(input); // 게이트 OFF — TS 기준값
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", rustBin);
    expect(() => computeAgentToolFingerprint(input)).not.toThrow();
    expect(computeAgentToolFingerprint(input)).toBe(expected);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lone_surrogate_input"));
  });

  it("non-JSON-safe inputs (function/symbol-ish/circular/undefined) fall back cleanly", () => {
    const withFn = { ...FP_INPUT, extra: () => {} } as unknown as FpInput;
    const circular: Record<string, unknown> = { ...FP_INPUT };
    circular.self = circular;
    const undefInput = { adapterType: "pi", model: undefined } as unknown as FpInput;
    // TS 는 알려진 필드만 읽으므로 이 입력들에서도 정의된 동작(성공)을 낸다 — 기준값.
    const expectedFn = computeAgentToolFingerprint(withFn);
    const expectedCircular = computeAgentToolFingerprint(circular as unknown as FpInput);
    const expectedUndef = computeAgentToolFingerprint(undefInput);
    vi.stubEnv("PAPERCLIP_TOOL_HYGIENE_CORE_BIN", rustBin);
    expect(() => computeAgentToolFingerprint(withFn)).not.toThrow();
    expect(computeAgentToolFingerprint(withFn)).toBe(expectedFn);
    expect(computeAgentToolFingerprint(circular as unknown as FpInput)).toBe(expectedCircular);
    expect(computeAgentToolFingerprint(undefInput)).toBe(expectedUndef);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("non_json_safe_input"));
  });
});
