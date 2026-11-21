// server/src/__tests__/portability-yaml-wiring.test.ts
//
// [목적] portability-yaml-client opt-in 동기 시임의 서비스 wiring 검증.
//   - 게이트 OFF(PAPERCLIP_PORTABILITY_YAML_BIN 미설정·빈값) → 스폰 없는 TS 경로.
//   - 설정 + 실 release bin → Rust 팔이 실행되고 TS 결과와 동일.
//   - 고장 bin(비JSON/non-zero/없는 경로)·상대경로 → 던지지 않고 TS 로 투명 폴백.
//   - lone surrogate·비JSON-safe 값(NaN/-0/undefined 원소/function·BigInt/순환)은
//     스폰 전 가드에서 걸러 TS 팔로 간다 — TS 가 던지는 입력은 팔에서도 같이 던진다.
//   - strip-empty-values 의 root drop(Rust {"value":null})은 TS undefined 로 매핑된다.
//   전수 parity 는 portability-yaml-stage1-parity.test.ts 가 담당한다(범위 밖).
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { buildMarkdown, buildYamlFile, stripEmptyValues } from "../services/company-portability-yaml.js";
import { resetPortabilityYamlFallbackWarningsForTests } from "../services/portability-yaml-client.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/portability-yaml/target/release/paperclip-portability-yaml");

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
  build-markdown) echo '{"markdown":"rust-arm-markdown"}' ;;
  build-yaml-file) echo '{"yaml":"rust-arm-yaml"}' ;;
  strip-empty-values) echo '{"value":"rust-arm-stripped"}' ;;
esac`;

beforeAll(async () => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/portability-yaml/Cargo.toml")],
    { stdio: "inherit" });
  dir = await mkdtemp(path.join(tmpdir(), "portability-yaml-"));
  cannedBin = await writeBin("canned", CANNED_SCRIPT);
  garbageBin = await writeBin("garbage", 'cat >/dev/null; echo "not-json"');
  failingBin = await writeBin("failing", "cat >/dev/null; exit 1");
}, 240_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", ""); // 게이트 OFF — TS 팔(테스트 기본 상태)
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetPortabilityYamlFallbackWarningsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const FM = {
  name: "writer", description: "writes docs", skills: ["write", "review"],
  budgetMonthlyCents: 5000, schedule: { cron: "0 * * * *" }, zebra: "last",
};
const BODY = "# Report\n\ndone";
const YAML_VALUE = { name: "alpha", tags: ["a", "", "b"], schedule: { cron: "0 9 * * *" }, empty: "", keep: 1 };
const STRIP_VALUE = { a: "", b: [1, "", null, 2], c: {}, keep: "v", zero: 0 };

/** 게이트 OFF 상태(테스트 기본)에서의 TS 기준값 — 각 테스트 첫 줄에서 계산한다. */
const tsReferences = () => ({
  markdown: buildMarkdown(FM, BODY),
  yaml: buildYamlFile(YAML_VALUE),
  yamlPreserve: buildYamlFile(YAML_VALUE, { preserveEmptyStrings: true }),
  stripped: stripEmptyValues(STRIP_VALUE),
  strippedPreserve: stripEmptyValues(STRIP_VALUE, { preserveEmptyStrings: true }),
});

describe("portability-yaml wiring", () => {
  it("unset gate runs the TS arm silently with identical outputs", () => {
    const { markdown, yaml, yamlPreserve, stripped, strippedPreserve } = tsReferences();
    expect(markdown).toContain('name: "writer"');
    expect(markdown).toContain("# Report");
    expect(yaml).toContain('name: "alpha"');
    expect(yaml).not.toContain("empty:");
    expect(yamlPreserve).toContain('empty: ""');
    expect(stripped).toEqual({ b: [1, 2], keep: "v", zero: 0 });
    expect(strippedPreserve).toEqual({ a: "", b: [1, "", 2], keep: "v", zero: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("canned bin proves the Rust arm runs and its shapes route through", () => {
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", cannedBin);
    expect(buildMarkdown(FM, BODY)).toBe("rust-arm-markdown");
    expect(buildYamlFile(YAML_VALUE)).toBe("rust-arm-yaml");
    expect(stripEmptyValues(STRIP_VALUE)).toBe("rust-arm-stripped");
    expect(warn).not.toHaveBeenCalled();
  });

  it("live Rust arm matches the TS arm on all three wired entries", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", rustBin);
    expect(buildMarkdown(FM, BODY)).toEqual(expected.markdown);
    expect(buildYamlFile(YAML_VALUE)).toEqual(expected.yaml);
    expect(buildYamlFile(YAML_VALUE, { preserveEmptyStrings: true })).toEqual(expected.yamlPreserve);
    expect(stripEmptyValues(STRIP_VALUE)).toEqual(expected.stripped);
    expect(stripEmptyValues(STRIP_VALUE, { preserveEmptyStrings: true })).toEqual(expected.strippedPreserve);
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps a dropped strip-empty-values root (Rust null) to undefined like TS", () => {
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", rustBin);
    // Rust {"value":null} === TS undefined — kept null 은 없어 매핑이 정확하다.
    expect(stripEmptyValues({ only: { deep: "" } })).toBeUndefined();
    expect(stripEmptyValues(null)).toBeUndefined();
    expect(stripEmptyValues({ a: {} }, { preserveEmptyStrings: true })).toBeUndefined();
    expect(stripEmptyValues({ a: null, b: [] })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("non-JSON stdout falls back to TS with a contract warning", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", garbageBin);
    expect(buildMarkdown(FM, BODY)).toEqual(expected.markdown);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad_json"));
  });

  it("non-zero exit falls back to TS without throwing", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", failingBin);
    expect(buildMarkdown(FM, BODY)).toEqual(expected.markdown);
    expect(buildYamlFile(YAML_VALUE)).toEqual(expected.yaml);
    expect(stripEmptyValues(STRIP_VALUE)).toEqual(expected.stripped);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("missing binary path falls back to TS via the spawn-error arm", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", path.join(dir, "does-not-exist"));
    expect(buildMarkdown(FM, BODY)).toEqual(expected.markdown);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("spawn_error"));
  });

  it("relative env path keeps the gate closed silently", () => {
    const expected = tsReferences();
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", "relative/bin");
    expect(buildMarkdown(FM, BODY)).toEqual(expected.markdown);
    expect(buildYamlFile(YAML_VALUE)).toEqual(expected.yaml);
    expect(stripEmptyValues(STRIP_VALUE)).toEqual(expected.stripped);
    expect(warn).not.toHaveBeenCalled();
  });

  it("lone surrogate input rides the JSON-safety guard into the TS fallback", () => {
    const fm = { name: "배포 \uD800 손상", description: "ok \uDFFF" };
    const body = "본문 \uDC00 lone";
    const yamlInput = { name: "\uD800", keep: 1 };
    const expectedMd = buildMarkdown(fm, body); // 게이트 OFF — TS 기준값
    const expectedYaml = buildYamlFile(yamlInput);
    const expectedStrip = stripEmptyValues({ t: "\uD800", keep: 2 });
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", rustBin);
    expect(() => buildMarkdown(fm, body)).not.toThrow();
    expect(buildMarkdown(fm, body)).toEqual(expectedMd);
    expect(buildYamlFile(yamlInput)).toEqual(expectedYaml);
    expect(stripEmptyValues({ t: "\uD800", keep: 2 })).toEqual(expectedStrip);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsafe_payload"));
  });

  it("non-JSON-safe values fall back to TS exactly (NaN/-0/undefined/function)", () => {
    const nanInput = { x: Number.NaN, inf: Number.POSITIVE_INFINITY, keep: 1 };
    const zeroInput = { z: -0, keep: 1 };
    const undefInput = { list: [1, undefined, 2], keep: 1 } as unknown as Record<string, unknown>;
    const fnInput = { fn: () => 1, keep: 2 } as unknown as Record<string, unknown>;
    const expected = {
      nan: buildYamlFile(nanInput),
      zero: buildYamlFile(zeroInput),
      undef: buildYamlFile(undefInput),
      fn: buildYamlFile(fnInput),
    };
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", rustBin);
    expect(buildYamlFile(nanInput)).toEqual(expected.nan);
    expect(buildYamlFile(nanInput)).toContain("x: NaN");
    expect(buildYamlFile(zeroInput)).toEqual(expected.zero);
    expect(buildYamlFile(undefInput)).toEqual(expected.undef);
    expect(buildYamlFile(fnInput)).toEqual(expected.fn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsafe_payload"));
  });

  it("BigInt and circular inputs stay on the TS arm (its throw semantics included)", () => {
    const bigInput = { n: BigInt(10) } as unknown as Record<string, unknown>;
    const circular: Record<string, unknown> = { keep: 1 };
    circular.self = circular;
    vi.stubEnv("PAPERCLIP_PORTABILITY_YAML_BIN", rustBin);
    // 가드가 스폰을 막고 TS 팔로 보낸다 — TS 본문의 throw 계약(TypeError/RangeError)이 그대로다.
    expect(() => buildYamlFile(bigInput)).toThrow(TypeError);
    expect(() => buildYamlFile(circular)).toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsafe_payload"));
  });
});
