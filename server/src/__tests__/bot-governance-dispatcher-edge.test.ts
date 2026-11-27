import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { evaluateBotDispatch, evaluateChannelInvoke, evaluateTerminalCommand, type BotDispatchInput, type ChannelInvokeInput, type GovernanceDecision, type TerminalCommandInput } from "../services/bot-governance.js";
import { evaluateBotDispatchGovernance, evaluateChannelInvokeGovernance, evaluateTerminalCommandGovernance, resolveBotGovernanceEngine, resetBotGovernanceDispatcherForTests } from "../services/bot-governance-dispatcher.js";
import { resetBotGovernanceRustWarningsForTests } from "../services/bot-governance-rust-client.js";

// dispatcher 가 직접 잡는 "Rust 클라이언트 자체가 던지는 예외" 경로를 함께 검증하기 위해
// evaluateBotDispatchWithRust 만 실제 구현을 감싸는 스파이로 대체한다.
const mocks = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  rustDispatchMock: vi.fn(),
  actualRustDispatch: undefined as unknown as (input: BotDispatchInput) => GovernanceDecision,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFileSync: mocks.execFileSyncMock,
}));
vi.mock("../services/bot-governance-rust-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/bot-governance-rust-client.js")>();
  mocks.actualRustDispatch = actual.evaluateBotDispatchWithRust;
  return { ...actual, evaluateBotDispatchWithRust: mocks.rustDispatchMock };
});
const execMock = mocks.execFileSyncMock as unknown as MockInstance;
const rustDispatchMock = mocks.rustDispatchMock as unknown as MockInstance;
const ENGINE_ENV = "BOT_GOVERNANCE_ENGINE";
const rustClientModeEnv = "PAPERWORK_BOT_GOVERNANCE_MODE";
let warn: MockInstance;

const actor = { callerUserId: "u-sales", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a" } as const;
const dispatchDenied: BotDispatchInput = {
  ...actor, companyId: "company-a", kind: "personal", ownerUserId: "u-owner", teamId: null, callableBy: "self_only", status: "active",
};
const terminalDenied: TerminalCommandInput = {
  ...actor, companyId: "company-a", kind: "personal_terminal", ownerUserId: "u-owner", teamId: "team-sales", status: "active", action: "exec",
};
const channelDenied: ChannelInvokeInput = {
  ...actor, channelCompanyId: "company-a", channelMemberIds: ["u-sales", "bot-sales"], botId: "bot-sales", botCompanyId: "company-a",
  botKind: "team", botOwnerUserId: "u-lead", botTeamId: "team-sales", executionTarget: "worker_node", requestsCrossTeamSecrets: true,
};
const rustAllow = JSON.stringify({ allowed: true, requires_approval: false, effect: "allow", reason_code: "ok", message: "allowed" });

const execError = (props: Record<string, unknown>): never => { throw Object.assign(new Error("helper failed"), props); };
// 각 거부 입력을 정확히 한 번만 평가하고(스폰·경고 횟수 검증용) Node 결과와 리터럴 양쪽으로 대조한다.
function expectAllDenials(): void {
  const expected = [
    [evaluateBotDispatchGovernance(dispatchDenied), evaluateBotDispatch(dispatchDenied), { allowed: false, reason: "self_only_denied" }],
    [evaluateTerminalCommandGovernance(terminalDenied), evaluateTerminalCommand(terminalDenied), { allowed: false, reason: "personal_terminal_access_denied" }],
    [evaluateChannelInvokeGovernance(channelDenied), evaluateChannelInvoke(channelDenied), { allowed: false, reason: "cross_team_secrets_denied", requiresOwnerApproval: false, crossTeamSecretsAllowed: false }],
  ] as const;
  for (const [actual, node, literal] of expected) {
    expect(actual).toEqual(node);
    expect(actual).toEqual(literal);
  }
}
function expectOnlyFallbackWarnings(): void {
  expect(warn).toHaveBeenCalledTimes(3);
  for (const call of warn.mock.calls) {
    expect(String(call[0])).toContain("fallback to Node");
    expect(String(call[0])).not.toContain("parity diff");
  }
}

beforeEach(() => {
  execMock.mockReset();
  rustDispatchMock.mockReset();
  rustDispatchMock.mockImplementation((input: BotDispatchInput) => mocks.actualRustDispatch(input));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetBotGovernanceRustWarningsForTests();
  resetBotGovernanceDispatcherForTests();
  vi.stubEnv("PAPERWORK_BOT_BIN", "/tmp/mock-paperwork-bot");
  vi.stubEnv(ENGINE_ENV, "");
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("BOT_GOVERNANCE_ENGINE edge values", () => {
  it.each([
    ["\tShAdOw\r\n", "shadow"], [" \u00a0RUST\u00a0 ", "rust"], ["NODE", "node"], [undefined, "node"],
    ["rusty", "node"], ["shadow,rust", "node"], ["ＲＵＳＴ", "node"], ["0", "node"],
  ])('env %j resolves to %s', (value, expected) => {
    vi.stubEnv(ENGINE_ENV, value);
    expect(resolveBotGovernanceEngine()).toBe(expected);
  });

  it("keeps unknown env values on the Node path with denials intact and warns once per normalized value", () => {
    execMock.mockReturnValue(rustAllow);
    for (const variant of [" BOGUS ", "bogus", "Bogus\t"]) {
      vi.stubEnv(ENGINE_ENV, variant);
      expectAllDenials();
    }
    expect(execMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"bogus"'));
  });
});

describe("shadow engine edge cases", () => {
  beforeEach(() => vi.stubEnv(ENGINE_ENV, "shadow"));

  it.each([
    ["spawn error", { code: "ENOENT" }], ["non-zero exit", { status: 2 }], ["timeout", { code: "ETIMEDOUT" }],
    ["buffer overflow", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
  ])("preserves the exact Node denial when Rust %s and restores the client mode env", (_label, props) => {
    vi.stubEnv(rustClientModeEnv, "node");
    execMock.mockImplementation(() => execError(props));
    expectAllDenials();
    expect(execMock).toHaveBeenCalledTimes(3);
    expectOnlyFallbackWarnings();
    expect(process.env[rustClientModeEnv]).toBe("node");
  });

  it.each([
    ["empty stdout", ""], ["non-JSON", "not-json"], ["JSON null", "null"], ["JSON array", "[]"],
    ["effect/allowed mismatch", JSON.stringify({ allowed: false, requires_approval: false, effect: "deny", reason_code: "x", message: 1 })],
    ["missing message", JSON.stringify({ allowed: false, requires_approval: false, effect: "deny", reason_code: "x" })], ["extra key", `${rustAllow.slice(0, -1)}, "extra": 1,}`],
  ])("preserves the exact Node denial on malformed helper output (%s) without a divergence record", (_label, stdout) => {
    execMock.mockReturnValue(stdout);
    expectAllDenials();
    expect(execMock).toHaveBeenCalledTimes(3);
    expectOnlyFallbackWarnings();
  });

  it("records a Rust-allow divergence exactly once and keeps returning the Node denial object", () => {
    execMock.mockReturnValue(rustAllow);
    const first = evaluateBotDispatchGovernance(dispatchDenied);
    const second = evaluateBotDispatchGovernance(dispatchDenied);
    expect(first).toEqual(evaluateBotDispatch(dispatchDenied));
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty("requiresOwnerApproval");
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parity diff (bot_dispatch)"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"allowed":false'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"effect":"allow"'));
  });

  it("keeps Node's approval flags when Rust answers require_approval for a Node denial", () => {
    execMock.mockReturnValue(JSON.stringify({ allowed: false, requires_approval: true, effect: "require_approval", reason_code: "owner_approval_required", message: "" }));
    expect(evaluateChannelInvokeGovernance(channelDenied)).toEqual(evaluateChannelInvoke(channelDenied));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parity diff (channel_invoke)"));
  });

  it("does not spawn for inputs the Rust payload cannot represent and still returns the Node decision", () => {
    const loneSurrogate = { ...dispatchDenied, callerUserId: "\ud800" } as BotDispatchInput;
    expect(evaluateBotDispatchGovernance(loneSurrogate)).toEqual(evaluateBotDispatch(loneSurrogate));
    expect(evaluateBotDispatchGovernance(loneSurrogate)).toEqual({ allowed: false, reason: "self_only_denied" });
    expect(execMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("non_json_safe_input"));
  });
});

describe("rust engine fail-closed edge cases", () => {
  beforeEach(() => vi.stubEnv(ENGINE_ENV, "rust"));

  it.each([
    ["non-zero exit", { status: 1 }], ["signal-kill exit", { status: null, signal: "SIGKILL" }],
    ["timeout", { code: "ETIMEDOUT" }], ["spawn error", { code: "ENOENT" }],
  ])("never upgrades a Node denial to allow when the client %s", (_label, props) => {
    execMock.mockImplementation(() => execError(props));
    expectAllDenials();
    expect(execMock).toHaveBeenCalledTimes(3);
    expectOnlyFallbackWarnings();
  });

  it.each(["", "not-json", "null", JSON.stringify({ allowed: true, requires_approval: false, effect: "deny", reason_code: "ok", message: "" })])(
    "never upgrades a Node denial to allow on malformed helper output %j",
    (stdout) => {
      execMock.mockReturnValue(stdout);
      expectAllDenials();
      expect(execMock).toHaveBeenCalledTimes(3);
      expectOnlyFallbackWarnings();
    },
  );

  it.each([
    ["Error with code", () => execError({ code: "EPIPE" }), "Error:EPIPE"],
    ["non-Error value", () => { throw "rust bridge exploded"; }, "unknown"],
  ])("falls back to the Node denial when the Rust client itself throws (%s) and restores the mode env", (_label, impl, detail) => {
    rustDispatchMock.mockImplementation(impl);
    vi.stubEnv(rustClientModeEnv, "shadow");
    expect(evaluateBotDispatchGovernance(dispatchDenied)).toEqual({ allowed: false, reason: "self_only_denied" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`engine=rust threw for bot_dispatch (${detail}); using Node decision`));
    expect(process.env[rustClientModeEnv]).toBe("shadow");
    delete process.env[rustClientModeEnv];
    rustDispatchMock.mockImplementation(() => { throw 42; });
    expect(evaluateBotDispatchGovernance(dispatchDenied)).toEqual({ allowed: false, reason: "self_only_denied" });
    expect(process.env[rustClientModeEnv]).toBeUndefined();
  });
});
