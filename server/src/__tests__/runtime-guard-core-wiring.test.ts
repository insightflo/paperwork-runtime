// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { findRuntimeBroadScanCommand } from "../services/runtime-broad-scan-command-policy.js";
import { extractRuntimeCommand } from "../services/runtime-command-extractor.js";
import { resetRuntimeGuardCoreFallbackWarningsForTests } from "../services/runtime-guard-core-client.js";

/**
 * [목적] runtime-guard-core-client 동기 시임의 서비스 wiring 검증.
 *   - 게이트 OFF(PAPERCLIP_RUNTIME_GUARD_CORE_BIN 미설정·상대경로) → 스폰 없는 TS 경로, 경고 0.
 *   - canned bin → Rust 팔이 실제로 흐른다(TS 결과와 다른 rust-arm marker).
 *   - live release bin → TS 결과와 1:1(parity 의 최종 출처는 TS 본문).
 *   - 고장 bin(비JSON/non-zero/없는 경로) → 던지지 않고 TS 로 투명 폴백.
 *   전수 parity 는 runtime-guard-core-stage1-parity.test.ts 가 담당한다(범위 밖).
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/runtime-guard-core/target/release/paperclip-runtime-guard-core");

const j = JSON.stringify;
type ScanIn = Parameters<typeof findRuntimeBroadScanCommand>[0];
const scan = (command: string, extra: Partial<ScanIn> = {}): ScanIn => ({
  command,
  allowedPaths: [],
  allowedDirectories: [],
  workingDirectory: null,
  repoSearchRoot: null,
  shellVariables: new Map(),
  stdinFromPipe: false,
  ...extra,
});
const vars = (entries: [string, string][]): Map<string, string> => new Map(entries);

const EXTRACT_FIXTURES: [string, string][] = [
  ["codex_local", j({ type: "item.started", item: { type: "command_execution", command: "ls -R /tmp" } })],
  ["codex_local", "not json"],
  ["claude_local", j({ type: "assistant", message: { content: [{ type: "tool_use", name: "bash", input: { command: "grep -R x" } }] } })],
  ["hermes_local", "┊ 💻 $ ls -R /srv"],
  ["hermes_local", "┊ plain text"],
];
const CODEX_LINE = EXTRACT_FIXTURES[0][1];
const SCAN_FIXTURES: [string, Partial<ScanIn>][] = [
  ["find . -type f", {}],
  ["find /repo/src -type f", { repoSearchRoot: "/repo" }],
  ["find $d -type f", { shellVariables: vars([["d", "."]]) }],
  ["rg TODO", {}],
  ["rg TODO /", {}],
  ["grep -R needle", {}],
  ["git ls-files", {}],
  ["tree /r/x.txt", { repoSearchRoot: "/r" }],
];

/** 게이트 OFF 상태의 TS 기준값 — gate ON 결과와 비교하는 1:1 기준이다. */
const tsRefs = () => ({
  extract: EXTRACT_FIXTURES.map(([adapterType, line]) => extractRuntimeCommand(adapterType, line)),
  scan: SCAN_FIXTURES.map(([command, extra]) => findRuntimeBroadScanCommand(scan(command, extra))),
});
const wiredMatchesTs = (refs: ReturnType<typeof tsRefs>) => {
  EXTRACT_FIXTURES.forEach(([adapterType, line], i) => {
    expect(extractRuntimeCommand(adapterType, line)).toEqual(refs.extract[i]);
  });
  SCAN_FIXTURES.forEach(([command, extra], i) => {
    expect(findRuntimeBroadScanCommand(scan(command, extra))).toEqual(refs.scan[i]);
  });
};

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
  extract-command) echo '"rust-arm-cmd"' ;;
  broad-scan) echo '"rust-arm-scan"' ;;
esac`;
const CANNED_NULL_SCRIPT = "cat >/dev/null; echo null"; // 성공 + value null("미탐지") 라우팅 증명

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/runtime-guard-core/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "runtime-guard-core-wiring-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  cannedNullBin = await writeBin("canned-null", CANNED_NULL_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; echo 'boom' >&2; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetRuntimeGuardCoreFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runtime-guard-core wiring", () => {
  it("unset gate runs the TS arm silently with zero warnings", () => {
    const refs = tsRefs();
    expect(refs.extract[0]).toBe("ls -R /tmp"); // 정의된 TS 결과 — 폴백 아님
    expect(refs.scan[0]).toBe("find .");
    expect(warn).not.toHaveBeenCalled();
  });

  it("relative env path keeps the gate closed silently", () => {
    const refs = tsRefs();
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", "relative/bin");
    wiredMatchesTs(refs);
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its values route through", () => {
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", cannedBin);
    expect(extractRuntimeCommand("codex_local", CODEX_LINE)).toBe("rust-arm-cmd");
    expect(findRuntimeBroadScanCommand(scan("find . -type f"))).toBe("rust-arm-scan");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a successful Rust null (no match) routes through as a value, not a fallback", () => {
    const refs = tsRefs(); // TS 기준은 non-null — null 결과가 Rust 성공값임이 증명된다
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", cannedNullBin);
    expect(extractRuntimeCommand("codex_local", CODEX_LINE)).toBeNull();
    expect(findRuntimeBroadScanCommand(scan("find . -type f"))).toBeNull();
    expect(refs.extract[0]).toBe("ls -R /tmp");
    expect(refs.scan[0]).toBe("find .");
    expect(warn).not.toHaveBeenCalled();
  });

  it("live release bin matches the TS arm 1:1 on both wired entries", () => {
    const refs = tsRefs();
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", rustBin);
    wiredMatchesTs(refs);
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-JSON stdout falls back to TS with a bad_json warning", () => {
    const refs = tsRefs();
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", garbageBin);
    wiredMatchesTs(refs);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const refs = tsRefs();
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", failingBin);
    expect(() => extractRuntimeCommand("codex_local", CODEX_LINE)).not.toThrow();
    expect(() => findRuntimeBroadScanCommand(scan("find . -type f"))).not.toThrow();
    wiredMatchesTs(refs);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("missing binary path falls back via the spawn-error arm", () => {
    const refs = tsRefs();
    vi.stubEnv("PAPERCLIP_RUNTIME_GUARD_CORE_BIN", path.join(dir, "does-not-exist"));
    wiredMatchesTs(refs);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });
});
