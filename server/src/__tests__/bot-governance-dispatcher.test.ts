import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  evaluateBotDispatch,
  evaluateCapabilityDataScope,
  evaluateChannelInvoke,
  evaluateTerminalCommand,
  type BotDispatchInput,
  type CapabilityDataScopeInput,
  type ChannelInvokeInput,
  type TerminalCommandInput,
} from "../services/bot-governance.js";
import {
  evaluateBotDispatchGovernance,
  evaluateCapabilityDataScopeGovernance,
  evaluateChannelInvokeGovernance,
  evaluateTerminalCommandGovernance,
  resolveBotGovernanceEngine,
  resetBotGovernanceDispatcherForTests,
} from "../services/bot-governance-dispatcher.js";
import { resetBotGovernanceRustWarningsForTests } from "../services/bot-governance-rust-client.js";

const childProcessMocks = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: childProcessMocks.execFileSyncMock };
});
const execMock = childProcessMocks.execFileSyncMock as unknown as MockInstance;
const mockBin = "/tmp/mock-paperwork-bot";
const rustClientModeEnv = "PAPERWORK_BOT_GOVERNANCE_MODE";

let warn: MockInstance;
function rustJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ allowed: true, requires_approval: false, effect: "allow", reason_code: "ok", message: "allowed", ...overrides });
}
function denyJson(reason: string): string {
  return rustJson({ allowed: false, effect: "deny", reason_code: reason, message: "denied" });
}

const dispatchInput: BotDispatchInput = {
  callerUserId: "u-sales", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  companyId: "company-a", kind: "company", ownerUserId: "u-owner", teamId: null, callableBy: "company", status: "active",
};
const terminalInput: TerminalCommandInput = {
  callerUserId: "u-owner", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  companyId: "company-a", kind: "personal_terminal", ownerUserId: "u-owner", teamId: "team-sales", status: "active", action: "exec",
  botKind: null, botOwnerUserId: null, botTeamId: null, botApproved: false, botCompanyId: null, explicitOwnerContext: false,
};
const channelInput: ChannelInvokeInput = {
  callerUserId: "u-sales", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  channelCompanyId: "company-a", channelMemberIds: ["u-sales", "bot-sales"], botId: "bot-sales", botCompanyId: "company-a",
  botKind: "team", botOwnerUserId: "u-lead", botTeamId: "team-sales", executionTarget: "worker_node",
  ownerApproved: false, requestsCrossTeamSecrets: false,
};
const capabilityInput: CapabilityDataScopeInput = {
  caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
  capability: { capabilityKey: "caps", callableBy: "team", dataScope: "team", requiresApproval: false },
  targetRecord: { ownerUserId: "u-lead", teamId: "team-sales", companyId: "company-a" },
};

beforeEach(() => {
  execMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetBotGovernanceRustWarningsForTests();
  resetBotGovernanceDispatcherForTests();
  vi.stubEnv("BOT_GOVERNANCE_ENGINE", "");
  vi.stubEnv("PAPERWORK_BOT_BIN", mockBin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveBotGovernanceEngine", () => {
  it.each([
    [undefined, "node"], ["", "node"], ["  ", "node"], ["node", "node"],
    [" SHADOW ", "shadow"], ["Rust", "rust"], ["unexpected", "node"],
  ])("maps %j to %s", (value, expected) => {
    expect(resolveBotGovernanceEngine(value)).toBe(expected);
  });

  it("warns once per unknown value and never for the default", () => {
    expect(resolveBotGovernanceEngine("bogus")).toBe("node");
    expect(resolveBotGovernanceEngine("bogus")).toBe("node");
    expect(resolveBotGovernanceEngine("other")).toBe("node");
    expect(resolveBotGovernanceEngine("")).toBe("node");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"bogus"'));
  });
});

describe("bot-governance-dispatcher: node", () => {
  it("is the default and never touches the Rust helper", () => {
    vi.stubEnv("BOT_GOVERNANCE_ENGINE", "");
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
    expect(evaluateTerminalCommandGovernance(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(evaluateChannelInvokeGovernance(channelInput)).toEqual(evaluateChannelInvoke(channelInput));
    expect(execMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("explicit \"node\" and unknown values keep the Node path with Node denials intact", () => {
    vi.stubEnv("BOT_GOVERNANCE_ENGINE", "node");
    expect(evaluateBotDispatchGovernance({ ...dispatchInput, callableBy: "self_only" })).toEqual({ allowed: false, reason: "self_only_denied" });
    vi.stubEnv("BOT_GOVERNANCE_ENGINE", "invalid-engine");
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
    expect(evaluateChannelInvokeGovernance({ ...channelInput, requestsCrossTeamSecrets: true })).toEqual({ allowed: false, reason: "cross_team_secrets_denied", requiresOwnerApproval: false, crossTeamSecretsAllowed: false });
    expect(execMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps capability data scope on Node regardless of engine", () => {
    vi.stubEnv("BOT_GOVERNANCE_ENGINE", "rust");
    expect(evaluateCapabilityDataScopeGovernance(capabilityInput)).toEqual(evaluateCapabilityDataScope(capabilityInput));
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("bot-governance-dispatcher: shadow", () => {
  beforeEach(() => vi.stubEnv("BOT_GOVERNANCE_ENGINE", "shadow"));

  it("returns the Node decision and stays silent when Rust matches", () => {
    execMock.mockReturnValue(rustJson({ reason_code: "bot_dispatch_allowed" }));
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
    expect(evaluateTerminalCommandGovernance(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a divergence without altering the Node result (Rust allow, Node deny)", () => {
    execMock.mockReturnValue(rustJson());
    const denied = { ...dispatchInput, callableBy: "self_only" };
    expect(evaluateBotDispatchGovernance(denied)).toEqual({ allowed: false, reason: "self_only_denied" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parity diff"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bot_dispatch"));
  });

  it("logs a divergence without altering the Node result (Rust deny, Node allow)", () => {
    execMock.mockReturnValue(denyJson("not_bot_owner"));
    expect(evaluateChannelInvokeGovernance(channelInput)).toEqual(evaluateChannelInvoke(channelInput));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parity diff"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("channel_invoke"));
  });

  it("falls back to the Node decision when the helper fails or times out", () => {
    execMock.mockImplementation(() => {
      const error = new Error("timed out") as Error & { code?: string };
      error.code = "ETIMEDOUT";
      throw error;
    });
    expect(evaluateTerminalCommandGovernance(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(evaluateTerminalCommandGovernance(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback to Node"));
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
  });
});

describe("bot-governance-dispatcher: rust", () => {
  beforeEach(() => vi.stubEnv("BOT_GOVERNANCE_ENGINE", "rust"));

  it("returns Rust decisions for all three actions", () => {
    execMock.mockReturnValue(denyJson("not_bot_owner"));
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual({ allowed: false, reason: "not_bot_owner" });
    execMock.mockReturnValue(rustJson({ allowed: false, requires_approval: true, effect: "require_approval", reason_code: "personal_terminal_requires_owner_approval" }));
    expect(evaluateChannelInvokeGovernance(channelInput)).toEqual({
      allowed: false, reason: "personal_terminal_requires_owner_approval", requiresOwnerApproval: true, crossTeamSecretsAllowed: false,
    });
    execMock.mockReturnValue(rustJson({ reason_code: "terminal_command_allowed" }));
    expect(evaluateTerminalCommandGovernance(terminalInput)).toEqual({ allowed: true, reason: "terminal_command_allowed" });
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock).toHaveBeenCalledWith(mockBin, ["eval-policy"], expect.objectContaining({ encoding: "utf8", input: expect.any(String) }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("is authoritative over a conflicting PAPERWORK_BOT_GOVERNANCE_MODE and restores it afterwards", () => {
    vi.stubEnv(rustClientModeEnv, "node");
    execMock.mockReturnValue(denyJson("not_bot_owner"));
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual({ allowed: false, reason: "not_bot_owner" });
    expect(process.env[rustClientModeEnv]).toBe("node");
    vi.stubEnv(rustClientModeEnv, "");
    execMock.mockReturnValue(denyJson("not_bot_owner"));
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual({ allowed: false, reason: "not_bot_owner" });
    expect(process.env[rustClientModeEnv]).toBe("");
    delete process.env[rustClientModeEnv];
    execMock.mockReturnValue(denyJson("not_bot_owner"));
    expect(evaluateBotDispatchGovernance(dispatchInput)).toEqual({ allowed: false, reason: "not_bot_owner" });
    expect(process.env[rustClientModeEnv]).toBeUndefined();
  });

  it.each([
    ["helper exit", () => { const error = new Error("spawn failed") as Error & { status?: number }; error.status = 1; throw error; }, "exit_1"],
    ["helper timeout", () => { const error = new Error("timed out") as Error & { code?: string }; error.code = "ETIMEDOUT"; throw error; }, "fallback to Node"],
  ])("falls back to the Node decision on %s without bypassing denials", (_label, impl, expected) => {
    execMock.mockImplementation(impl as never);
    const denied = { ...dispatchInput, callableBy: "self_only" };
    expect(evaluateBotDispatchGovernance(denied)).toEqual({ allowed: false, reason: "self_only_denied" });
    expect(evaluateTerminalCommandGovernance(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(expected));
  });

  it.each(["not-json", "{\"allowed\":\"yes\"}", "{\"allowed\":true,\"requires_approval\":false,\"effect\":\"deny\",\"reason_code\":\"x\",\"message\":\"y\"}"])(
    "falls back to the Node decision on malformed helper output %s",
    (stdout) => {
      execMock.mockReturnValue(stdout);
      const denied = { ...channelInput, requestsCrossTeamSecrets: true };
      expect(evaluateChannelInvokeGovernance(denied)).toEqual(evaluateChannelInvoke(denied));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback to Node"));
    },
  );

  it("keeps malformed inputs on the fail-closed Node path without spawning", () => {
    execMock.mockReturnValue(rustJson());
    for (const malformed of [null, {}, { ...dispatchInput, unexpected: true }]) {
      expect(evaluateBotDispatchGovernance(malformed as never)).toEqual({ allowed: false, reason: "invalid_input" });
    }
    expect(execMock).not.toHaveBeenCalled();
  });
});
