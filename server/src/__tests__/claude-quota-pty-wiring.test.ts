import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureClaudeCliUsageText,
  parseClaudeQuotaPtyOutput,
  resolveClaudeQuotaPtyBin,
} from "../../../packages/adapters/claude-local/src/server/quota.js";

const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileAsync }) };
});

describe("resolveClaudeQuotaPtyBin", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const bin = "paperclip-claude-quota-pty";
  const candidates = [
    path.join(repoRoot, "target", "release", bin),
    path.join(repoRoot, "crates", "claude-quota-pty", "target", "release", bin),
    path.join(repoRoot, "target", "debug", bin),
  ];

  it.each([
    ["workspace release", 0],
    ["staged release", 1],
    ["workspace debug", 2],
  ] as const)("discovers %s from the module anchor in priority order", (_, index) => {
    const existsSync = vi.fn((p: string) => candidates.slice(index).includes(p));
    expect(resolveClaudeQuotaPtyBin({ env: {}, existsSync })).toBe(candidates[index]);
    expect(existsSync.mock.calls).toEqual(candidates.slice(0, index + 1).map((p) => [p]));
  });

  it("reports all searched paths when none exist", () => {
    const existsSync = vi.fn(() => false);
    expect(() => resolveClaudeQuotaPtyBin({ repoRoot, env: {}, existsSync })).toThrow(candidates.join(", "));
    expect(existsSync.mock.calls).toEqual(candidates.map((p) => [p]));
  });

  it("rejects a relative repo root before probing", () => {
    const existsSync = vi.fn(() => true);
    expect(() => resolveClaudeQuotaPtyBin({ repoRoot: "relative", env: {}, existsSync })).toThrow(/repoRoot.*absolute/);
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("preserves the exact absolute override after trimming", () => {
    const override = `${repoRoot}${path.sep}custom${path.sep}..${path.sep}${bin}`;
    const existsSync = vi.fn(() => true);
    const env = { PAPERCLIP_CLAUDE_QUOTA_PTY_BIN: `  ${override}  ` };
    expect(resolveClaudeQuotaPtyBin({ repoRoot, env, existsSync })).toBe(override);
    expect(existsSync.mock.calls).toEqual([[override]]);
  });

  it.each([["empty", ""], ["whitespace-only", "   "]])("rejects an %s override without probing", (_, override) => {
    const existsSync = vi.fn(() => true);
    const env = { PAPERCLIP_CLAUDE_QUOTA_PTY_BIN: override };
    expect(() => resolveClaudeQuotaPtyBin({ repoRoot, env, existsSync })).toThrow(/PAPERCLIP_CLAUDE_QUOTA_PTY_BIN.*non-empty absolute path/);
    expect(existsSync).not.toHaveBeenCalled();
  });

  it.each(["target/release/paperclip-claude-quota-pty", bin])("rejects nonabsolute override %s without probing", (override) => {
    const existsSync = vi.fn(() => true);
    const env = { PAPERCLIP_CLAUDE_QUOTA_PTY_BIN: override };
    expect(() => resolveClaudeQuotaPtyBin({ repoRoot, env, existsSync })).toThrow(/PAPERCLIP_CLAUDE_QUOTA_PTY_BIN.*absolute/);
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("rejects a missing absolute override without falling back to an available workspace binary", () => {
    const override = path.join(repoRoot, "missing", bin);
    const existsSync = vi.fn((p: string) => p === candidates[0]);
    const env = { PAPERCLIP_CLAUDE_QUOTA_PTY_BIN: override };
    expect(() => resolveClaudeQuotaPtyBin({ repoRoot, env, existsSync })).toThrow(`does not exist: ${override}`);
    expect(existsSync.mock.calls).toEqual([[override]]);
  });
});

describe("parseClaudeQuotaPtyOutput", () => {
  const valid = { schema_version: 1, output: "\u001b[0mCurrent session\r", timed_out: true, truncated: false };

  it("preserves terminal output and maps the native flags", () => {
    expect(parseClaudeQuotaPtyOutput(JSON.stringify({ ...valid, exit_code: null }))).toEqual({
      output: valid.output,
      timedOut: true,
      truncated: false,
    });
  });

  it("rejects malformed JSON", () => {
    expect(() => parseClaudeQuotaPtyOutput("{")).toThrow(/invalid JSON/);
  });

  it.each([
    [null],
    [[]],
    [{ ...valid, schema_version: 2 }],
    [{ ...valid, schema_version: "1" }],
    [{ ...valid, schema_version: undefined }],
    [{ ...valid, output: undefined }],
    [{ ...valid, timed_out: undefined }],
    [{ ...valid, truncated: undefined }],
    [{ ...valid, output: 42 }],
    [{ ...valid, timed_out: "true" }],
    [{ ...valid, truncated: 0 }],
  ])("rejects invalid version-1 output %#", (value) => {
    expect(() => parseClaudeQuotaPtyOutput(JSON.stringify(value))).toThrow(/schema version 1/);
  });
});

describe("captureClaudeCliUsageText", () => {
  afterEach(() => {
    execFileAsync.mockReset();
    vi.unstubAllEnvs();
  });

  it.each([
    [NaN, 12_000],
    [Infinity, 12_000],
    [-Infinity, 12_000],
    [999, 1_000],
    [12_345.9, 12_345],
    [60_001, 60_000],
  ])("normalizes %s ms to %s ms before spawning the helper", async (timeoutMs, expectedMs) => {
    vi.stubEnv("PAPERCLIP_CLAUDE_QUOTA_PTY_BIN", process.execPath);
    const output = "Current session 42%\nCurrent week 10%";
    execFileAsync.mockResolvedValue({ stdout: JSON.stringify({ schema_version: 1, output, timed_out: false, truncated: false }) });

    await expect(captureClaudeCliUsageText(timeoutMs)).resolves.toBe(output);
    expect(execFileAsync).toHaveBeenCalledExactlyOnceWith(
      process.execPath, ["--timeout-ms", String(expectedMs)], expect.objectContaining({ timeout: expectedMs + 5_000 }),
    );
  });
});

it("does not shell out for the Claude quota PTY probe", () => {
  const source = readFileSync(new URL("../../../packages/adapters/claude-local/src/server/quota.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/script\s+-q|buildClaudeCliShellProbeCommand|quoteForShell|execFileAsync\(\s*["']sh["']/);
});
