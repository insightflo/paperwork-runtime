import { describe, expect, it } from "vitest";
import { evaluateBotDispatch, evaluateCapabilityDataScope, evaluateChannelInvoke, evaluateTerminalCommand } from "../services/bot-governance.js";

const dispatchBase = {
  callerUserId: "u-sales", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  companyId: "company-a", kind: "personal", ownerUserId: "u-owner", teamId: null,
  callableBy: "company", status: "active",
};
function dispatch(overrides: Record<string, unknown> = {}) {
  return evaluateBotDispatch({ ...dispatchBase, ...overrides } as never);
}

const capabilityBase = {
  caller: { userId: "u-sales", teamId: "team-sales", role: "member", companyId: "company-a" },
  capability: { capabilityKey: "salary.read", callableBy: "company", dataScope: "self", requiresApproval: true },
  targetRecord: { ownerUserId: "u-sales", teamId: "team-sales", companyId: "company-a" },
};
function capability(overrides: Record<string, Record<string, unknown>> = {}) {
  const input = structuredClone(capabilityBase) as Record<string, Record<string, unknown>>;
  for (const key of ["caller", "capability", "targetRecord"] as const) {
    input[key] = { ...input[key], ...(overrides[key] ?? {}) };
  }
  return evaluateCapabilityDataScope(input as never);
}

const terminalBase = {
  callerUserId: "u-owner", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  companyId: "company-a", kind: "personal_terminal", ownerUserId: "u-owner", teamId: "team-sales",
  status: "active", action: "exec", botKind: null, botOwnerUserId: null, botTeamId: null,
  botApproved: false, botCompanyId: null, explicitOwnerContext: false,
};
function terminal(overrides: Record<string, unknown> = {}) {
  return evaluateTerminalCommand({ ...terminalBase, ...overrides } as never);
}

const channelBase = {
  callerUserId: "u-caller", callerTeamId: "team-sales", callerRole: "member", callerCompanyId: "company-a",
  channelCompanyId: "company-a", channelMemberIds: ["u-caller", "bot-hr"], botId: "bot-hr",
  botCompanyId: "company-a", botKind: "personal", botOwnerUserId: "u-owner", botTeamId: "team-hr",
  executionTarget: "personal_terminal", ownerApproved: false, requestsCrossTeamSecrets: false,
};
function channel(overrides: Record<string, unknown> = {}) {
  return evaluateChannelInvoke({ ...channelBase, ...overrides } as never);
}

describe("evaluateBotDispatch", () => {
  it("allows an active company bot for a company member", () => {
    expect(dispatch()).toEqual({ allowed: true, reason: "allowed" });
  });
  it("denies cross-company dispatch before any other privilege", () => {
    expect(dispatch({ callerCompanyId: "company-b" })).toEqual({ allowed: false, reason: "cross_company_denied" });
  });
  it.each(["inactive", "revoked", "paused", "unknown"])("denies non-active bot status %s", (status) => {
    expect(dispatch({ status })).toEqual({ allowed: false, reason: "bot_inactive" });
  });
  it("enforces self_only only for the owner", () => {
    expect(dispatch({ callableBy: "self_only", ownerUserId: "u-sales" }).allowed).toBe(true);
    expect(dispatch({ callableBy: "self_only", ownerUserId: "u-other" })).toEqual({ allowed: false, reason: "self_only_denied" });
  });
  it("enforces team callableBy for same-team members and company owners only", () => {
    expect(dispatch({ callableBy: "team", teamId: "team-sales" }).allowed).toBe(true);
    expect(dispatch({ callableBy: "team", teamId: "team-hr" }).allowed).toBe(false);
    expect(dispatch({ callableBy: "team", teamId: "team-hr", callerRole: "owner" }).allowed).toBe(true);
    expect(dispatch({ callableBy: "team", teamId: null, callerRole: "owner" }).allowed).toBe(true);
  });
  it("allows viewers for company callableBy because write capability is evaluated separately", () => {
    expect(dispatch({ callerRole: "viewer" }).allowed).toBe(true);
  });
  it.each([
    ["unknown caller role", { callerRole: "superuser" }],
    ["unknown bot kind", { kind: "service" }],
    ["unknown callableBy", { callableBy: "public" }],
    ["missing caller user", { callerUserId: "" }],
    ["missing company", { companyId: null }],
    ["personal bot missing owner", { ownerUserId: null }],
    ["team bot missing team", { kind: "team", ownerUserId: null, teamId: null }],
    ["undefined required nullable team", { teamId: undefined }],
  ])("fails closed on %s", (_name, overrides) => {
    expect(dispatch(overrides).allowed).toBe(false);
  });
});

describe("evaluateCapabilityDataScope", () => {
  it("allows a sales employee to read only their own salary through a company-callable HR capability", () => {
    expect(capability()).toEqual({
      allowed: true, reason: "allowed", forcedFilter: { ownerUserId: "u-sales" }, requiresApproval: true,
    });
  });
  it("denies the same employee reading a colleague's salary with data_scope_self_violation", () => {
    expect(capability({ targetRecord: { ownerUserId: "u-colleague" } })).toEqual({
      allowed: false, reason: "data_scope_self_violation", forcedFilter: null, requiresApproval: true,
    });
  });
  it("enforces team data scope for same-team records and owner override", () => {
    expect(capability({
      capability: { dataScope: "team" }, targetRecord: { ownerUserId: "u-colleague", teamId: "team-sales" },
    })).toMatchObject({ allowed: true, forcedFilter: { teamId: "team-sales" } });
    expect(capability({
      caller: { role: "owner", teamId: null }, capability: { dataScope: "team" },
      targetRecord: { ownerUserId: "u-hr", teamId: "team-hr" },
    })).toMatchObject({ allowed: true, forcedFilter: { teamId: "team-hr" } });
    expect(capability({
      caller: { role: "owner", teamId: null }, capability: { dataScope: "team" },
      targetRecord: { ownerUserId: "u-hr", teamId: null },
    })).toMatchObject({ allowed: true, forcedFilter: null });
  });
  it("denies cross-team member reads with data_scope_team_violation", () => {
    expect(capability({
      capability: { dataScope: "team" }, targetRecord: { ownerUserId: "u-hr", teamId: "team-hr" },
    })).toMatchObject({ allowed: false, reason: "data_scope_team_violation", forcedFilter: null });
  });
  it("allows company data scope with a company forced filter", () => {
    expect(capability({
      capability: { dataScope: "company" }, targetRecord: { ownerUserId: "u-hr", teamId: "team-hr" },
    })).toMatchObject({ allowed: true, forcedFilter: { companyId: "company-a" } });
  });
  it("denies company-scope records when company equality differs or cannot be proven", () => {
    expect(capability({ targetRecord: { companyId: "company-b" } }).reason).toBe("cross_company_denied");
    expect(capability({ caller: { companyId: null } }).allowed).toBe(false);
  });
  it("enforces callableBy before data scope", () => {
    expect(capability({
      capability: { callableBy: "self_only", dataScope: "company" }, targetRecord: { ownerUserId: "u-other" },
    }).allowed).toBe(false);
    expect(capability({
      capability: { callableBy: "team", dataScope: "company" },
      targetRecord: { ownerUserId: "u-other", teamId: "team-hr" },
    }).allowed).toBe(false);
  });
  it.each([
    ["unknown role", { caller: { role: "superuser" } }],
    ["unknown callableBy", { capability: { callableBy: "public" } }],
    ["unknown data scope", { capability: { dataScope: "all" } }],
    ["missing requiresApproval", { capability: { requiresApproval: undefined } }],
    ["missing capability key", { capability: { capabilityKey: "" } }],
    ["missing target owner for self", { targetRecord: { ownerUserId: null } }],
    ["undefined required nullable caller team", { caller: { teamId: undefined } }],
  ])("fails closed on %s", (_name, overrides) => {
    expect(capability(overrides).allowed).toBe(false);
  });
});

describe("evaluateTerminalCommand", () => {
  it("allows the owner to exec on their personal terminal", () => {
    expect(terminal()).toEqual({ allowed: true, reason: "allowed" });
  });
  it("allows the owner's own personal bot only with explicit owner context", () => {
    const bot = { callerUserId: "u-service", botKind: "personal", botOwnerUserId: "u-owner", botCompanyId: "company-a" };
    expect(terminal({ ...bot, explicitOwnerContext: true }).allowed).toBe(true);
    expect(terminal({ ...bot, explicitOwnerContext: false }).allowed).toBe(false);
  });
  it("denies admin exec on an employee personal terminal but allows revoke and stop", () => {
    const admin = { callerUserId: "u-admin", callerRole: "admin" };
    expect(terminal({ ...admin, action: "exec" })).toEqual({ allowed: false, reason: "personal_terminal_exec_denied" });
    expect(terminal({ ...admin, action: "stop" }).allowed).toBe(true);
    expect(terminal({ ...admin, action: "revoke" }).allowed).toBe(true);
  });
  it("denies members and viewers even stop/revoke on another user's personal terminal", () => {
    expect(terminal({ callerUserId: "u-peer", action: "stop" }).allowed).toBe(false);
    expect(terminal({ callerUserId: "u-peer", callerRole: "viewer", action: "revoke" }).allowed).toBe(false);
  });
  it("denies cross-company and revoked terminals", () => {
    expect(terminal({ callerCompanyId: "company-b" })).toEqual({ allowed: false, reason: "cross_company_denied" });
    expect(terminal({ status: "revoked" })).toEqual({ allowed: false, reason: "terminal_revoked" });
  });
  it("allows same-team admins and members on worker nodes but always denies viewers", () => {
    const worker = { kind: "worker_node", ownerUserId: null };
    expect(terminal({ ...worker, callerUserId: "u-member" }).allowed).toBe(true);
    expect(terminal({ ...worker, callerUserId: "u-admin", callerRole: "admin" }).allowed).toBe(true);
    expect(terminal({ ...worker, callerUserId: "u-viewer", callerRole: "viewer" }).allowed).toBe(false);
  });
  it("allows company owners across teams and approved same-team team bots on worker nodes", () => {
    const worker = { kind: "worker_node", ownerUserId: null };
    expect(terminal({ ...worker, callerRole: "owner", callerTeamId: null }).allowed).toBe(true);
    expect(terminal({
      ...worker, callerUserId: "u-service", callerTeamId: "team-other", botKind: "team",
      botTeamId: "team-sales", botCompanyId: "company-a", botApproved: true,
    }).allowed).toBe(true);
    expect(terminal({
      ...worker, callerUserId: "u-service", callerTeamId: "team-other", botKind: "team",
      botTeamId: "team-hr", botCompanyId: "company-a", botApproved: true,
    }).allowed).toBe(false);
  });
  it("denies cross-team members and unapproved team bots on worker nodes", () => {
    const worker = { kind: "worker_node", ownerUserId: null };
    expect(terminal({ ...worker, callerUserId: "u-outsider", callerTeamId: "team-hr" }).allowed).toBe(false);
    expect(terminal({
      ...worker, callerUserId: "u-service", callerTeamId: "team-other", botKind: "team",
      botTeamId: "team-sales", botCompanyId: "company-a", botApproved: false,
    }).allowed).toBe(false);
  });
  it("denies explicit owner context when the personal bot owner differs", () => {
    expect(terminal({
      callerUserId: "u-service", botKind: "personal", botOwnerUserId: "u-other",
      botCompanyId: "company-a", explicitOwnerContext: true,
    }).allowed).toBe(false);
  });
  it.each([
    ["unknown action", { action: "delete" }],
    ["unknown terminal kind", { kind: "cloud_terminal" }],
    ["unknown status", { status: "mystery" }],
    ["undefined required nullable owner", { ownerUserId: undefined }],
    ["bot ownership without bot kind", { botOwnerUserId: "u-owner" }],
    ["personal bot missing owner scope", { botKind: "personal", botCompanyId: "company-a", explicitOwnerContext: true }],
    ["team bot missing team scope", { botKind: "team", botCompanyId: "company-a", botApproved: true }],
    ["cross-company bot context", { botKind: "team", botTeamId: "team-sales", botCompanyId: "company-b", botApproved: true }],
  ])("fails closed on %s", (_name, overrides) => {
    expect(terminal(overrides).allowed).toBe(false);
  });
});

describe("evaluateChannelInvoke", () => {
  it("requires owner approval before another user's personal bot executes on a personal terminal", () => {
    expect(channel()).toEqual({
      allowed: false, reason: "personal_terminal_requires_owner_approval",
      requiresOwnerApproval: true, crossTeamSecretsAllowed: false,
    });
    expect(channel({ ownerApproved: true })).toEqual({
      allowed: true, reason: "allowed", requiresOwnerApproval: false, crossTeamSecretsAllowed: false,
    });
    expect(channel({ callerUserId: "u-owner", channelMemberIds: ["u-owner", "bot-hr"] }).allowed).toBe(true);
  });
  it("does not require owner approval when invocation does not execute on a personal terminal", () => {
    expect(channel({ executionTarget: "none" }).allowed).toBe(true);
    expect(channel({ executionTarget: "worker_node" }).allowed).toBe(true);
  });
  it("requires both caller and target bot to be channel members", () => {
    expect(channel({ channelMemberIds: ["bot-hr"] })).toMatchObject({ allowed: false, reason: "caller_not_channel_member" });
    expect(channel({ channelMemberIds: ["u-caller"] })).toMatchObject({ allowed: false, reason: "bot_not_channel_member" });
  });
  it("denies cross-company channel invocation", () => {
    expect(channel({ callerCompanyId: "company-b" }).reason).toBe("cross_company_denied");
    expect(channel({ botCompanyId: "company-b" }).reason).toBe("cross_company_denied");
  });
  it("never allows cross-team secrets or internal KB through channel invocation", () => {
    expect(channel({ requestsCrossTeamSecrets: true })).toMatchObject({
      allowed: false, reason: "cross_team_secrets_denied", crossTeamSecretsAllowed: false,
    });
    expect(channel({ ownerApproved: true }).crossTeamSecretsAllowed).toBe(false);
  });
  it.each([
    ["unknown caller role", { callerRole: "superuser" }],
    ["unknown bot kind", { botKind: "service" }],
    ["unknown execution target", { executionTarget: "cloud_terminal" }],
    ["malformed members", { channelMemberIds: ["u-caller", 42] }],
    ["missing bot id", { botId: "" }],
    ["personal bot missing owner scope", { botOwnerUserId: null }],
    ["team bot missing team scope", { botKind: "team", botOwnerUserId: null, botTeamId: null }],
    ["undefined required nullable bot owner", { botOwnerUserId: undefined }],
    ["non-boolean owner approval", { ownerApproved: "yes" }],
  ])("fails closed on %s", (_name, overrides) => {
    expect(channel(overrides).allowed).toBe(false);
  });
});

describe("fail-closed malformed input", () => {
  it("denies null, arrays, and empty objects for every evaluator", () => {
    for (const input of [null, [], {}]) {
      expect(evaluateBotDispatch(input as never).allowed).toBe(false);
      expect(evaluateCapabilityDataScope(input as never).allowed).toBe(false);
      expect(evaluateTerminalCommand(input as never).allowed).toBe(false);
      expect(evaluateChannelInvoke(input as never).allowed).toBe(false);
    }
  });
});
