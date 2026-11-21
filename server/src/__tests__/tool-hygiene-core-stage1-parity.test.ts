// Stage 3.A differential parity: crates/tool-hygiene-core (Rust port) vs the
// pure parts of tool-fingerprint.ts, tool-result-hygiene.ts and
// tool-env-sensitivity.ts. A Rust Err (stderr + exit 1) mirrors a TS throw —
// only the ok/fail class and successful output are compared, since Node and
// Rust error texts differ by design. signatureKey/condenseErrorText are
// private in TS, so they are exercised through the exported surface
// (normalizeToolErrorSignature + node:crypto, and condenseDuplicateToolErrorBody)
// instead of re-implementing them here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rustBin = path.join(repoRoot, "crates/tool-hygiene-core/target/release/paperclip-tool-hygiene-core");

type Outcome = { ok: boolean; value?: unknown };
const tsCall = (fn: () => unknown): Outcome => {
  try { return { ok: true, value: fn() }; } catch { return { ok: false }; }
};
const rustCall = (subcommand: string, payload: unknown): Outcome => {
  try {
    const stdout = execFileSync(rustBin, [subcommand], {
      input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    });
    return { ok: true, value: JSON.parse(stdout) };
  } catch { return { ok: false }; }
};
const parity = (label: string, ts: Outcome, rs: Outcome) => {
  expect(rs.ok, `${label}: ok`).toBe(ts.ok);
  if (ts.ok && rs.ok) expect(rs.value, `${label}: value`).toEqual(ts.value);
};

beforeAll(() => {
  execFileSync(process.env.CARGO || "cargo", [
    "build", "--release", "--manifest-path",
    path.join(repoRoot, "crates/tool-hygiene-core/Cargo.toml"),
  ], { stdio: "inherit" });
}, 120_000);

describe("compute-agent-tool-fingerprint vs computeAgentToolFingerprint", () => {
  const cases: Array<[string, unknown]> = [
    ["minimal adapterType", { adapterType: "pi" }],
    ["empty object omits adapterType", {}],
    ["string input leaves adapterType undefined", "raw"],
    ["number input leaves adapterType undefined", 5],
    ["all optional fields populated", { adapterType: "codex", model: "gpt-5", thinkingEffort: "high", cwd: "/tmp/x", instructionsFileName: "CLAUDE.md", instructionsText: "follow rules" }],
    ["nullish fields collapse", { adapterType: "pi", model: null, thinkingEffort: null, cwd: null, instructionsFileName: null, instructionsText: null }],
    ["empty instructionsText -> null hash", { adapterType: "pi", instructionsText: "" }],
    ["unicode instructions text", { adapterType: "pi", instructionsText: "한국어 지시 🚀 ñ" }],
    ["numeric adapterType", { adapterType: 5 }],
    ["exponent adapterType", { adapterType: 1e21 }],
    ["float adapterType", { adapterType: 0.1 + 0.2 }],
    ["negative zero adapterType", { adapterType: -0 }],
    ["object adapterType integer-key order", { adapterType: { z: 1, a: 2, "10": 3, "2": 4 } }],
    ["null input throws", null],
    ["mcpServers sorted by name", { adapterType: "pi", mcpServers: [{ name: "b" }, { name: "a" }] }],
    ["mcpServers case sort", { adapterType: "pi", mcpServers: [{ name: "z" }, { name: "Z" }, { name: "a" }] }],
    ["mcpServers locale sort accented", { adapterType: "pi", mcpServers: [{ name: "z" }, { name: "é" }, { name: "e" }] }],
    ["mcpServers full entry", { adapterType: "pi", mcpServers: [{ name: "x", command: "npx", args: ["-y", "mcp"], url: "http://h", disabledTools: ["b", "a", "a"] }] }],
    ["mcpServers non-string first name kept (pivot-safe)", { adapterType: "pi", mcpServers: [{ name: 5 }, { name: "a" }] }],
    ["mcpServers numeric pivot name throws", { adapterType: "pi", mcpServers: [{ name: "a" }, { name: 5 }] }],
    ["mcpServers null entry throws", { adapterType: "pi", mcpServers: [null, { name: "a" }] }],
    ["mcpServers single-char string spreads", { adapterType: "pi", mcpServers: "x" }],
    ["mcpServers two-char string throws", { adapterType: "pi", mcpServers: "ab" }],
    ["mcpServers non-iterable throws", { adapterType: "pi", mcpServers: 5 }],
    ["mcpServers entry args string spreads", { adapterType: "pi", mcpServers: [{ name: "x", args: "ab" }] }],
    ["mcpServers entry args non-iterable throws", { adapterType: "pi", mcpServers: [{ name: "x", args: 5 }] }],
    ["mcpServers entry disabledTools element throws", { adapterType: "pi", mcpServers: [{ name: "x", disabledTools: [7] }] }],
    ["mcpServers empty array", { adapterType: "pi", mcpServers: [] }],
    ["allowedTools dedupe trim sort", { adapterType: "pi", allowedTools: ["write", "read", "write", "  exec  ", ""] }],
    ["allowedTools utf16 astral order", { adapterType: "pi", allowedTools: ["\uE000", "𐀀", "a"] }],
    ["allowedTools non-array throws", { adapterType: "pi", allowedTools: "notarray" }],
    ["allowedTools numeric element throws", { adapterType: "pi", allowedTools: [5] }],
    ["allowedTools null element throws", { adapterType: "pi", allowedTools: [null] }],
    ["disabledTools null", { adapterType: "pi", disabledTools: null }],
    ["envKeys sorted with hashed values", { adapterType: "pi", envKeys: { B: "two", A: "one", "10": "x", "2": "y" } }],
    ["envKeys null value hashes empty", { adapterType: "pi", envKeys: { K: null } }],
    ["envKeys numeric value throws", { adapterType: "pi", envKeys: { K: 5 } }],
    ["envKeys array index keys", { adapterType: "pi", envKeys: ["x", "y"] }],
    ["envKeys string index keys", { adapterType: "pi", envKeys: "ab" }],
    ["envKeys empty object", { adapterType: "pi", envKeys: {} }],
    ["thinkingEffort zero stays", { adapterType: "pi", thinkingEffort: 0 }],
    ["instructionsFileName zero stays", { adapterType: "pi", instructionsFileName: 0 }],
  ];
  for (const [label, input] of cases) {
    it(label, () => parity(label,
      tsCall(() => computeAgentToolFingerprint(input as AgentToolFingerprintInput)),
      rustCall("compute-agent-tool-fingerprint", input)));
  }
});

describe("has-tool-surface-changed vs hasToolSurfaceChanged", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["null previous -> unchanged", null, { adapterType: "pi" }],
    ["empty previous -> unchanged", "", { adapterType: "pi" }],
    ["zero previous -> unchanged", 0, { adapterType: "pi" }],
    ["mismatched previous -> changed", "deadbeef", { adapterType: "pi" }],
    ["numeric previous -> changed", 123, { adapterType: "pi" }],
    ["null currentInput throws", "x", null],
    ["missing currentInput throws", "x", undefined],
  ];
  for (const [label, prev, cur] of cases) {
    it(label, () => parity(label,
      tsCall(() => hasToolSurfaceChanged(prev as string, cur as AgentToolFingerprintInput)),
      rustCall("has-tool-surface-changed", { previousFingerprint: prev, currentInput: cur })));
  }
  it("matching previous -> unchanged", () => {
    const cur = { adapterType: "pi", model: "m" } as AgentToolFingerprintInput;
    const prev = computeAgentToolFingerprint(cur);
    parity("match", tsCall(() => hasToolSurfaceChanged(prev, cur)),
      rustCall("has-tool-surface-changed", { previousFingerprint: prev, currentInput: cur }));
  });
});

describe("normalize-tool-error-signature vs normalizeToolErrorSignature", () => {
  const cases: Array<[string, unknown]> = [
    ["mixed digits and case", { text: "Error 404 Not Found" }],
    ["whitespace collapse", { text: "  a\t\n  b   c  " }],
    ["digits only", { text: "12345" }],
    ["unicode lowercasing", { text: "HTTP 오류 500 Ñ İ" }],
    ["digit runs each masked", { text: "v1.22 id=333 status=404" }],
    ["empty string", { text: "" }],
    ["NEL is not JS whitespace", { text: "a\u0085b" }],
    ["FEFF is JS whitespace", { text: "a\uFEFFb" }],
    ["astral text", { text: "Err 𐀀 code 12" }],
    ["numeric text throws", { text: 5 }],
    ["missing text throws", {}],
  ];
  for (const [label, payload] of cases) {
    it(label, () => parity(label,
      tsCall(() => normalizeToolErrorSignature((payload as { text: string }).text)),
      rustCall("normalize-tool-error-signature", payload)));
  }
});

describe("tool-error-signature-key vs signatureKey internals", () => {
  const sha16 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
  const expectedKey = (tool: unknown, status: unknown, error: string) =>
    `${tool}|${status ?? "x"}|${sha16(normalizeToolErrorSignature(error).slice(0, 2000))}`;
  const cases: Array<[string, { tool?: unknown; status?: unknown; error?: unknown }]> = [
    ["basic", { tool: "search", status: 400, error: "HTTP 400 bad request" }],
    ["null status -> x", { tool: "read", status: null, error: "x" }],
    ["zero status stays", { tool: "read", status: 0, error: "x" }],
    ["string status", { tool: "read", status: "404", error: "x" }],
    ["missing status -> x", { tool: "read", error: "x" }],
    ["missing tool -> undefined", { status: 500, error: "y" }],
    ["numeric tool", { tool: 5, status: 200, error: "y" }],
    ["normalized-over-2000 truncates at utf16", { tool: "t", status: 1, error: `${"e".repeat(1999)}𐀀tail` }],
    ["missing error throws", { tool: "t", status: 1 }],
  ];
  for (const [label, c] of cases) {
    it(label, () => parity(label,
      tsCall(() => expectedKey(c.tool, c.status, c.error as string)),
      rustCall("tool-error-signature-key", c)));
  }
});

describe("condense-tool-error-text vs condenseDuplicateToolErrorBody", () => {
  const tsCondense = (error: string, count: number): unknown => {
    resetToolErrorHygieneForTests();
    let body: Record<string, unknown> = { error };
    for (let i = 0; i < count; i += 1) {
      body = condenseDuplicateToolErrorBody({ runId: "parity", tool: "t", status: 500, body: { error } }).body;
    }
    return body.error;
  };
  const cases: Array<[string, { error: string; count: number }]> = [
    ["short error count 2", { error: "boom", count: 2 }],
    ["count 3", { error: "kaput", count: 3 }],
    ["exactly 140 chars", { error: "x".repeat(140), count: 2 }],
    ["141 chars truncates", { error: "y".repeat(141), count: 2 }],
    ["astral pair inside excerpt", { error: `${"a".repeat(137)}𐀀bbbb`, count: 2 }],
    ["unicode text", { error: "오류 반복 500번", count: 2 }],
  ];
  for (const [label, c] of cases) {
    it(label, () => parity(label,
      tsCall(() => tsCondense(c.error, c.count)),
      rustCall("condense-tool-error-text", c)));
  }
  it("null error exits nonzero (private path unreachable in TS)", () => {
    expect(rustCall("condense-tool-error-text", { error: null, count: 2 }).ok).toBe(false);
  });
});

describe("is-sensitive-tool-env-key vs isSensitiveToolEnvKey", () => {
  const keys: unknown[] = [
    "API_KEY", "myapikey", "api-key", "token", "tokens", "x-token-y", "xtoken",
    "tokenx", "onetoken", "tokenization", "MY_AUTH", "authorization", "oauth2",
    "bearer", "APP_SECRET", "passwd", "db_password", "credential_file", "my-jwt",
    "private-key", "privatekey", "cookie_jar", "CONNECTIONSTRING", "HOME",
    5, ["a_api_key", "b"], null, {},
  ];
  for (const key of keys) {
    const label = JSON.stringify(key);
    it(`key ${label}`, () => parity(label,
      tsCall(() => isSensitiveToolEnvKey(key as string)),
      rustCall("is-sensitive-tool-env-key", { key })));
  }
});
