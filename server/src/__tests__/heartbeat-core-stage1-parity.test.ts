import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  classifyHeartbeatRunFailure,
  containsToolLimitLifecycleFailure,
  heartbeatRunFailureText,
} from "../services/heartbeat-failure-classification.js";
import { detectCodexAuthFailureForAutoBlock } from "../services/heartbeat-codex-auth-classification.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rustBin = path.join(repoRoot, "crates/heartbeat-core/target/release/paperclip-heartbeat-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargoBin = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(
    cargoBin,
    ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/heartbeat-core/Cargo.toml")],
    { stdio: "inherit" },
  );
}, 240_000);

type Outcome = { threw: false; value: unknown } | { threw: true; error: string };
const classify = classifyHeartbeatRunFailure as (input: unknown) => unknown;
const failText = heartbeatRunFailureText as (input: unknown) => unknown;
const toolLimit = containsToolLimitLifecycleFailure as unknown as (run: unknown) => unknown;
const codexAuth = detectCodexAuthFailureForAutoBlock as (input: unknown) => unknown;

function ts(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: fn() };
  } catch (err) {
    return { threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}
function rustRaw(subcommand: string, stdin: string): Outcome {
  const res = spawnSync(rustBin, [subcommand], { input: stdin, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) {
    return { threw: true, error: String(res.error ?? res.stderr).trim() };
  }
  return { threw: false, value: JSON.parse(String(res.stdout)) };
}
const rust = (subcommand: string, payload: unknown) => rustRaw(subcommand, JSON.stringify(payload));

function expectParity(t: Outcome, r: Outcome): void {
  if (r.threw !== t.threw) {
    throw new Error(`throw parity mismatch: ts=${JSON.stringify(t)} rust=${JSON.stringify(r)}`);
  }
  if (!t.threw && !r.threw) expect(r.value).toEqual(t.value);
}

describe("classify-run-failure: TS vs paperclip-heartbeat-core", () => {
  const cases: Array<[string, unknown]> = [
    ["timed_out beats error text", { status: "timed_out", errorMessage: "quota exceeded" }],
    ["cancelled", { status: "cancelled", errorCode: "claude_api_error_529" }],
    ["status needs exact match (no trim)", { status: " timed_out ", errorMessage: "plain" }],
    ["529 overload wins over ENOENT stderr", { status: "failed", errorCode: "claude_api_error_529", stderrExcerpt: "ENOENT: no such file" }],
    ["500 overload", { status: "failed", errorCode: "claude_api_error_500" }],
    ["503 mid-string errorCode", { status: "failed", errorCode: "wrap:claude_api_error_503" }],
    ["502 is not overload", { status: "failed", errorCode: "claude_api_error_502" }],
    ["overloaded message", { status: "failed", errorMessage: "Service is currently overloaded" }],
    ["max-turns cap classified distinctly", { status: "failed", adapterType: "commandcode_local", errorCode: "commandcode_max_turns", errorMessage: "Command Code reached the --max-turns cap before completing; partial response returned." }],
    ["max-turns errorCode needs exact match", { status: "failed", adapterType: "commandcode_local", errorCode: "commandcode_max_turns_extra" }],
    ["array errorCode coerced via ToString", { status: "failed", errorCode: ["claude_api_error_503"] }],
    ["guardrail: step input manifest", { status: "failed", stderrExcerpt: "step input manifest violated" }],
    ["guardrail: runtime broad scan", { status: "failed", errorMessage: "runtime broad scan attempt" }],
    ["guardrail: 'tree' needs word boundary", { status: "failed", stderrExcerpt: "the xtree module" }],
    ["guardrail ignores stdout (strongEvidence only)", { status: "failed", stdoutExcerpt: "step input manifest" }],
    ["quota: 429 + rate limit", { status: "failed", errorMessage: "HTTP 429 rate limit" }],
    ["quota: 403 + capacity -> AUTH_403 code", { status: "failed", errorMessage: "403 capacity exceeded" }],
    ["quota: code but no quota word -> falls to adapter", { status: "failed", errorMessage: "HTTP 429 slowed down" }],
    ["quota words without code", { status: "failed", errorMessage: "billing hard limit hit" }],
    ["rate.?limit: one BMP char ok", { status: "failed", errorMessage: "rateZlimit" }],
    ["rate.?limit: newline blocks the dot", { status: "failed", errorMessage: "rate\nlimit" }],
    ["rate.?limit: astral char is 2 UTF-16 units", { status: "failed", errorMessage: "rate\u{1f4a9}limit" }],
    ["auth: 401 unauthorized", { status: "failed", errorMessage: "401 Unauthorized" }],
    ["auth: forbidden without 403", { status: "failed", errorMessage: "forbidden region" }],
    ["command: spawn ENOENT", { status: "failed", stderrExcerpt: "spawn codex ENOENT" }],
    ["command: EACCES permission denied", { status: "failed", errorMessage: "EACCES: permission denied" }],
    ["adapter fallback trims errorCode", { status: "failed", errorCode: "  MY_CODE " }],
    ["adapter fallback default", { status: "failed" }],
    ["kimi provider seeds fallbacks", { status: "failed", provider: "kimi" }],
    ["mimo model seeds fallbacks on auth result too", { status: "failed", model: "mimo-x", errorMessage: "401" }],
    ["dotless-i kimi does NOT match (JS non-u rejects ı->I fold)", { status: "failed", provider: "k\u0131m\u0131" }],
    ["long-s moonshot does NOT match (JS non-u rejects ſ->s)", { status: "failed", provider: "moon\u{17f}hot" }],
    ["Kelvin-K matches via toLowerCase not regex canon", { status: "failed", provider: "\u{212a}imi" }],
    ["status non-string falls through", { status: 0, errorCode: "E1" }],
    ["empty object", {}],
    ["null throws", null],
    ["number input falls through to adapter", 5],
    ["array input falls through to adapter", ["x"]],
    ["numeric errorCode throws at fallback", { status: "failed", errorCode: 5 }],
    ["whitespace-only fields filtered from haystack", { status: "failed", errorMessage: "   ", stdoutExcerpt: "\n\t" }],
  ];
  for (const [name, input] of cases) {
    it(`parity: ${name}`, () => {
      expectParity(ts(() => classify(input)), rust("classify-run-failure", input));
    });
  }
});

describe("run-failure-text: TS vs paperclip-heartbeat-core", () => {
  const cases: Array<[string, unknown]> = [
    ["joins non-blank fields in order", { errorCode: "E", errorMessage: "m", stdoutExcerpt: "o", stderrExcerpt: "e" }],
    ["kept strings stay untrimmed", { errorCode: "  E  ", stdoutExcerpt: "   " }],
    ["non-string fields dropped", { errorCode: 5, errorMessage: ["x"], stderrExcerpt: "err" }],
    ["all blank -> empty string", { stdoutExcerpt: "\n\t " }],
    ["FEFF is JS-trimmable", { errorCode: "\ufeffX\ufeff" }],
    ["null throws", null],
  ];
  for (const [name, input] of cases) {
    it(`parity: ${name}`, () => {
      expectParity(ts(() => failText(input)), rust("run-failure-text", input));
    });
  }
});

describe("contains-tool-limit-failure: TS vs paperclip-heartbeat-core", () => {
  const cases: Array<[string, unknown]> = [
    ["reached maximum iterations", { stdoutExcerpt: "reached maximum iterations" }],
    ["tool-call limit", { stderrExcerpt: "hit tool-call limit" }],
    ["tool call limit", { error: "tool call limit exceeded" }],
    ["toolcall limit (no separator)", { error: "toolcall limit" }],
    ["tool FEFF call limit — FEFF is JS whitespace", { stdoutExcerpt: "tool\ufeffcall limit" }],
    ["tool NEL call limit — U+0085 is NOT JS whitespace", { stdoutExcerpt: "tool\u0085call limit" }],
    ["could not post", { error: "could not post the reply" }],
    ["couldn't post", { stderrExcerpt: "couldn't post" }],
    ["before i could post", { stdoutExcerpt: "before i could post" }],
    ["could not .*mark", { stdoutExcerpt: "could not mark step" }],
    ["u-flag dot crosses emoji to mark", { stdoutExcerpt: "could not \u{1f600}mark" }],
    ["newline breaks could-not-to-mark", { stdoutExcerpt: "could not x\nmark" }],
    ["negative: posted fine", { stdoutExcerpt: "posted the result" }],
    ["empty fields", {}],
    ["whitespace-only strings are truthy", { stdoutExcerpt: "  " }],
    ["error array coerces via ToString", { error: ["could not post"] }],
    ["error false dropped by filter(Boolean)", { error: false, stdoutExcerpt: "x" }],
    ["null run throws", null],
    ["non-object run -> false", 5],
  ];
  for (const [name, input] of cases) {
    it(`parity: ${name}`, () => {
      expectParity(ts(() => toolLimit(input)), rust("contains-tool-limit-failure", input));
    });
  }
});

describe("detect-codex-auth-failure: TS vs paperclip-heartbeat-core", () => {
  const cases: Array<[string, unknown]> = [
    ["non-codex adapter -> null", { adapterType: "claude_local", errorMessage: "auth error: 401" }],
    ["missing adapter -> null", { errorMessage: "auth error: 401" }],
    ["prefix w/ suffix code", { adapterType: "codex_local", errorCode: "codex_auth_401_token_expired" }],
    ["prefix is case-insensitive via normalization", { adapterType: "codex_local", errorCode: "CODEX_AUTH_401_SESSION_EXPIRED" }],
    ["prefix w/ padded code", { adapterType: "codex_local", errorCode: " codex_auth_401__invalid_grant " }],
    ["bare prefix + 'auth error: 401'", { adapterType: "codex_local", errorCode: "codex_auth_401", stdoutExcerpt: "auth error: 401" }],
    ["trailing underscore falls to haystack", { adapterType: "codex_local", errorCode: "codex_auth_401_", errorMessage: "no codex credentials stored" }],
    ["auth error code + 'auth error: 401'", { adapterType: "codex_local", stderrExcerpt: "Auth Error Code: invalid_grant\nauth error: 401" }],
    ["detected code w/o 401 -> CODEX_AUTH_x not _401_", { adapterType: "codex_local", errorMessage: "auth error code: token_expired" }],
    ["literal auth word + '401 Unauthorized'", { adapterType: "codex_local", stdoutExcerpt: "refresh_token_reused, 401 Unauthorized" }],
    ["'auth error: 401' alone", { adapterType: "codex_local", errorMessage: "auth error: 401" }],
    ["'401 Unauthorized' alone -> null", { adapterType: "codex_local", errorMessage: "401 Unauthorized" }],
    ["token expired phrase", { adapterType: "codex_local", errorMessage: "provided authentication token is expired" }],
    ["log out phrase", { adapterType: "codex_local", stderrExcerpt: "please log out and sign in again" }],
    ["no credentials", { adapterType: "codex_local", errorMessage: "no codex credentials stored" }],
    ["access token refresh", { adapterType: "codex_local", errorMessage: "access token could not be refreshed" }],
    ["auth code normalization: 'some-thing' + 401", { adapterType: "codex_local", stderrExcerpt: "auth error code: some-thing\n401 Unauthorized" }],
    ["dotless-i not captured (JS non-u rejects the fold)", { adapterType: "codex_local", errorMessage: "auth error code: \u0131\n401 Unauthorized" }],
    ["long-s before auth word: boundary + capture positions", { adapterType: "codex_local", errorMessage: "\u{17f}auth error code: x9\n401 Unauthorized" }],
    ["errorCode number throws", { adapterType: "codex_local", errorCode: 401 }],
    ["null throws", null],
    ["string input -> null", "codex_local"],
    ["array errorMessage coercion", { adapterType: "codex_local", errorMessage: ["auth error code: token_expired", "auth error: 401"] }],
  ];
  for (const [name, input] of cases) {
    it(`parity: ${name}`, () => {
      expectParity(ts(() => codexAuth(input)), rust("detect-codex-auth-failure", input));
    });
  }
});

describe("paperclip-heartbeat-core CLI contract", () => {
  it("fails closed on unknown subcommand and malformed/oversized/empty stdin", () => {
    for (const out of [
      rustRaw("bogus-subcommand", "{}"),
      rustRaw("classify-run-failure", "{not json"),
      rustRaw("classify-run-failure", ""),
      rustRaw("classify-run-failure", " ".repeat(4 * 1024 * 1024 + 8)),
    ]) {
      expect(out.threw).toBe(true);
    }
  });
});
