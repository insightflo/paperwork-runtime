import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  evaluateBotDispatch,
  evaluateChannelInvoke,
  evaluateTerminalCommand,
  type BotDispatchInput,
  type ChannelInvokeInput,
  type TerminalCommandInput,
} from "../services/bot-governance.js";
import {
  evaluateBotDispatchWithRust,
  evaluateChannelInvokeWithRust,
  evaluateTerminalCommandWithRust,
  resetBotGovernanceRustWarningsForTests,
  resolvePaperworkBotBin,
} from "../services/bot-governance-rust-client.js";

const childProcessMocks = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  actualExecFileSync: undefined as unknown as (...args: unknown[]) => unknown,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMocks.actualExecFileSync = actual.execFileSync as (...args: unknown[]) => unknown;
  return { ...actual, execFileSync: childProcessMocks.execFileSyncMock };
});

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const mockBin = "/tmp/mock-paperwork-bot";
const execMock = childProcessMocks.execFileSyncMock as unknown as MockInstance;
let warn: MockInstance;

function rustJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    allowed: true,
    requires_approval: false,
    effect: "allow",
    reason_code: "ok",
    message: "allowed",
    ...overrides,
  });
}

function setMode(mode: string): void {
  vi.stubEnv("PAPERWORK_BOT_GOVERNANCE_MODE", mode);
  vi.stubEnv("PAPERWORK_BOT_BIN", mockBin);
}

function payloadFromFirstCall(): Record<string, unknown> {
  const options = execMock.mock.calls[0]?.[2] as { input?: string } | undefined;
  return JSON.parse(options?.input ?? "{}") as Record<string, unknown>;
}

const dispatchInput: BotDispatchInput = {
  callerUserId: "u-sales", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  companyId: "company-a", kind: "company", ownerUserId: "u-owner", teamId: null,
  callableBy: "company", status: "active",
};

const terminalInput: TerminalCommandInput = {
  callerUserId: "u-owner", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  companyId: "company-a", kind: "personal_terminal", ownerUserId: "u-owner", teamId: "team-sales",
  status: "active", action: "exec", botKind: null, botOwnerUserId: null, botTeamId: null,
  botApproved: false, botCompanyId: null, explicitOwnerContext: false,
};

const channelInput: ChannelInvokeInput = {
  callerUserId: "u-sales", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  channelCompanyId: "company-a", channelMemberIds: ["u-sales", "bot-sales"], botId: "bot-sales",
  botCompanyId: "company-a", botKind: "team", botOwnerUserId: "u-lead", botTeamId: "team-sales",
  executionTarget: "worker_node", ownerApproved: false, requestsCrossTeamSecrets: false,
};

function findRealBinary(): string | null {
  return [
    process.env.PAPERWORK_BOT_BIN,
    path.join(repoRoot, "target/release/paperwork-bot"),
    path.join(repoRoot, "target/debug/paperwork-bot"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

const realBinary = findRealBinary();

beforeEach(() => {
  execMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  resetBotGovernanceRustWarningsForTests();
  vi.stubEnv("PAPERWORK_BOT_BIN", mockBin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("bot-governance-rust-client", () => {
  it("uses node mode by default and never spawns the Rust helper", () => {
    vi.stubEnv("PAPERWORK_BOT_GOVERNANCE_MODE", "");
    expect(evaluateBotDispatchWithRust(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
    expect(evaluateTerminalCommandWithRust(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(evaluateChannelInvokeWithRust(channelInput)).toEqual(evaluateChannelInvoke(channelInput));
    expect(execMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an unknown mode as node mode for safe rollout", () => {
    setMode("unexpected");
    expect(evaluateBotDispatchWithRust(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
    expect(execMock).not.toHaveBeenCalled();
  });

  it("resolves the explicit binary only as a non-empty absolute path", () => {
    expect(resolvePaperworkBotBin(` ${mockBin} `)).toBe(mockBin);
    expect(resolvePaperworkBotBin("paperwork-bot")).toBeNull();
    expect(resolvePaperworkBotBin("")).not.toBe(mockBin);
  });

  it("shadow mode keeps the Node decision and logs a behavioral parity diff", () => {
    setMode("shadow");
    execMock.mockReturnValue(rustJson({
      allowed: false,
      effect: "deny",
      reason_code: "not_bot_owner",
      message: "denied",
    }));
    expect(evaluateBotDispatchWithRust(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parity diff"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bot_dispatch"));
  });

  it("shadow mode does not warn when Rust and Node behavior match", () => {
    setMode("shadow");
    execMock.mockReturnValue(rustJson({ reason_code: "channel_invoke_allowed" }));
    expect(evaluateChannelInvokeWithRust(channelInput)).toEqual(evaluateChannelInvoke(channelInput));
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rust mode returns the Rust bot dispatch decision and sends the translated payload", () => {
    setMode("rust");
    execMock.mockReturnValue(rustJson({
      allowed: false,
      effect: "deny",
      reason_code: "not_bot_owner",
      message: "denied",
    }));
    expect(evaluateBotDispatchWithRust(dispatchInput)).toEqual({ allowed: false, reason: "not_bot_owner" });
    expect(execMock).toHaveBeenCalledWith(mockBin, ["eval-policy"], expect.objectContaining({
      encoding: "utf8",
      input: expect.any(String),
    }));
    expect(payloadFromFirstCall()).toMatchObject({
      action: "bot_dispatch",
      actor: { company_id: "company-a", user_id: "u-sales", team_id: "team-sales", role: "member" },
      bot: {
        company_id: "company-a",
        owner_user_id: "u-owner",
        kind: "company",
        callable_by: "company",
        data_scope: "company",
        status: "active",
        requires_approval: false,
      },
    });
  });

  it("rust mode sends terminal_command payloads with the bot actor context", () => {
    setMode("rust");
    execMock.mockReturnValue(rustJson({ reason_code: "terminal_command_allowed" }));
    const input: TerminalCommandInput = {
      ...terminalInput,
      callerUserId: "u-service",
      botKind: "personal",
      botOwnerUserId: "u-owner",
      botTeamId: null,
      botCompanyId: "company-a",
      explicitOwnerContext: true,
    };
    expect(evaluateTerminalCommandWithRust(input)).toEqual({ allowed: true, reason: "terminal_command_allowed" });
    expect(payloadFromFirstCall()).toMatchObject({
      action: "terminal_command",
      terminal_company_id: "company-a",
      terminal_owner_user_id: "u-owner",
      terminal_active: true,
      terminal_kind: "personal_terminal",
      terminal_action: "exec",
      bot_actor: {
        bot_kind: "personal",
        bot_company_id: "company-a",
        bot_owner_user_id: "u-owner",
        explicit_owner_context: true,
      },
    });
  });

  it("rust mode sends channel_invoke payloads and maps approval state", () => {
    setMode("rust");
    execMock.mockReturnValue(rustJson({
      allowed: false,
      requires_approval: true,
      effect: "require_approval",
      reason_code: "personal_terminal_requires_owner_approval",
    }));
    expect(evaluateChannelInvokeWithRust(channelInput)).toEqual({
      allowed: false,
      reason: "personal_terminal_requires_owner_approval",
      requiresOwnerApproval: true,
      crossTeamSecretsAllowed: false,
    });
    expect(payloadFromFirstCall()).toMatchObject({
      action: "channel_invoke",
      channel_company_id: "company-a",
      channel_member_ids: ["u-sales", "bot-sales"],
      execution_target: "worker_node",
      owner_approved: false,
      requests_cross_team_secrets: false,
      bot: {
        bot_id: "bot-sales",
        company_id: "company-a",
        owner_user_id: "u-lead",
        team_id: "team-sales",
        kind: "team",
      },
    });
  });

  it.each(["not-json", "{\"allowed\":\"yes\"}"])(
    "rust mode falls back to Node once for malformed helper output %s",
    (stdout) => {
      setMode("rust");
      execMock.mockReturnValue(stdout);
      expect(evaluateBotDispatchWithRust(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
      expect(evaluateBotDispatchWithRust(dispatchInput)).toEqual(evaluateBotDispatch(dispatchInput));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("fallback to Node"));
    },
  );

  it("rust mode falls back to Node when the helper process fails", () => {
    setMode("rust");
    execMock.mockImplementation(() => {
      const error = new Error("spawn failed") as Error & { status?: number };
      error.status = 1;
      throw error;
    });
    expect(evaluateTerminalCommandWithRust(terminalInput)).toEqual(evaluateTerminalCommand(terminalInput));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit_1"));
  });

  it("rust mode keeps malformed inputs on the fail-closed Node path", () => {
    setMode("rust");
    const malformedInputs = [null, {}, { ...dispatchInput, unexpected: true }];
    for (const malformed of malformedInputs) {
      expect(evaluateBotDispatchWithRust(malformed as never)).toEqual({ allowed: false, reason: "invalid_input" });
    }
    expect(execMock).not.toHaveBeenCalled();
  });

  describe.skipIf(realBinary === null)("real paperwork-bot binary", () => {
    it("evaluates the three parity fixtures through eval-policy", () => {
      vi.stubEnv("PAPERWORK_BOT_GOVERNANCE_MODE", "rust");
      vi.stubEnv("PAPERWORK_BOT_BIN", realBinary!);
      execMock.mockImplementation((...args: unknown[]) => childProcessMocks.actualExecFileSync(...args));
      expect(evaluateBotDispatchWithRust(dispatchInput).allowed).toBe(true);
      expect(evaluateTerminalCommandWithRust(terminalInput).allowed).toBe(true);
      expect(evaluateChannelInvokeWithRust(channelInput).allowed).toBe(true);
      expect(execMock).toHaveBeenCalledTimes(3);
    });
  });
});
