import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readExplicitValidationVerdict } from "../services/validation-verdict.js";
import { resolveQualityVerdictRouting } from "../services/quality-verdict-routing.js";

/**
 * verdict-core Rust SSOT wiring tests (TS fallback removed; Rust binary is authoritative).
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/verdict-core/target/release/paperclip-verdict-core");

let dir: string;
let cannedBin: string;
let cannedNullBin: string;
let garbageBin: string;
let failingBin: string;

async function writeBin(name: string, body: string): Promise<string> {
  const binPath = path.join(dir, name);
  await writeFile(binPath, `#!/bin/bash\n${body}\n`, "utf8");
  await chmod(binPath, 0o755);
  return binPath;
}

const CANNED_SCRIPT = `cat >/dev/null
case "$1" in
  read-explicit-validation-verdict) echo '"request_changes"' ;;
  resolve-quality-verdict-routing) echo '{"kind":"correction","verdict":"request_changes","reason":"rust-arm","failureType":"rust-arm"}' ;;
esac`;
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
  vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("verdict-core Rust SSOT wiring", () => {
  it("auto-resolves the workspace Rust binary when PAPERCLIP_VERDICT_CORE_BIN is unset", () => {
    expect(readExplicitValidationVerdict("text\n## QA verdict\n\nPASS\ntail")).toBe("pass");
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toBe("request_changes");
    expect(readExplicitValidationVerdict("PASS first\nthen nothing verdictable")).toBeNull();
    expect(readExplicitValidationVerdict("PASS first\nthen nothing verdictable", { allowLeadingVerdict: true })).toBe("pass");
    expect(readExplicitValidationVerdict("no verdict anywhere in this prose")).toBeNull();
    expect(resolveQualityVerdictRouting({ verdict: "needs_evidence", requiredEvidenceSurfaces: [" a ", "", "  b\t"] }))
      .toEqual({ kind: "evidence", reason: null, requiredEvidenceSurfaces: ["a", "b"] });
    expect(resolveQualityVerdictRouting({ verdict: "fail", reason: "bug", failureType: "logic" }))
      .toEqual({ kind: "correction", verdict: "fail", reason: "bug", failureType: "logic" });
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" }))
      .toEqual({ kind: "none" });
  });

  it("canned bin proves the Rust binary is invoked directly", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", cannedBin);
    expect(readExplicitValidationVerdict("no verdict anywhere in this prose")).toBe("request_changes");
    expect(resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toEqual({
      kind: "correction", verdict: "request_changes", reason: "rust-arm", failureType: "rust-arm",
    });
  });

  it("canned null verdict response is accepted as valid null verdict", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", cannedNullBin);
    expect(readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toBeNull();
  });

  it("explicit PAPERCLIP_VERDICT_CORE_BIN override works", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", rustBin);
    expect(readExplicitValidationVerdict("text\n## QA verdict\n\nPASS\ntail")).toBe("pass");
  });

  it("fails closed on non-JSON stdout instead of falling back to TS", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", garbageBin);
    expect(() => readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toThrow(/bad_json/);
    expect(() => resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toThrow(/bad_json/);
  });

  it("fails closed on non-zero exit instead of falling back to TS", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", failingBin);
    expect(() => readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toThrow(/boom/);
    expect(() => resolveQualityVerdictRouting({ verdict: "totally unknown verdict" })).toThrow(/boom/);
  });

  it("fails closed on missing binary path", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", path.join(dir, "does-not-exist"));
    expect(() => readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toThrow(/spawn_error/);
  });

  it("fails closed on relative env path", () => {
    vi.stubEnv("PAPERCLIP_VERDICT_CORE_BIN", "relative/paperclip-verdict-core");
    expect(() => readExplicitValidationVerdict("The build failed.\n\nREQUEST_CHANGES")).toThrow(/Invalid PAPERCLIP_VERDICT_CORE_BIN/);
  });
});
