import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_WORKSPACE_PROCESSES,
  DEFAULT_MAX_HOST_CONCURRENT_TURNS,
  evaluateAgentMcpAccess,
  evaluateExecutionCapacity,
  filterAllowedMcpServers,
  type AgentMcpAccessPolicy,
} from "../services/agent-mcp-access-policy.js";

describe("evaluateAgentMcpAccess", () => {
  it("allows any server when the policy is null or undefined", () => {
    expect(evaluateAgentMcpAccess(null, "github")).toEqual({ allowed: true, reason: "ok" });
    expect(evaluateAgentMcpAccess(undefined, "github")).toEqual({ allowed: true, reason: "ok" });
  });

  it("allows any server in allow_all mode", () => {
    const policy: AgentMcpAccessPolicy = { mode: "allow_all", servers: [] };
    expect(evaluateAgentMcpAccess(policy, "github")).toEqual({ allowed: true, reason: "ok" });
  });

  it("allows only listed servers in allowlist mode, normalizing case and whitespace", () => {
    const policy: AgentMcpAccessPolicy = { mode: "allowlist", servers: [" GitHub ", "LINEAR"] };
    expect(evaluateAgentMcpAccess(policy, "github")).toEqual({ allowed: true, reason: "ok" });
    expect(evaluateAgentMcpAccess(policy, "  linear  ")).toEqual({ allowed: true, reason: "ok" });
  });

  it("denies unlisted servers in allowlist mode", () => {
    const policy: AgentMcpAccessPolicy = { mode: "allowlist", servers: ["github"] };
    expect(evaluateAgentMcpAccess(policy, "linear")).toEqual({
      allowed: false,
      reason: "denied_by_allowlist",
    });
  });

  it("denies listed servers in denylist mode and allows the rest", () => {
    const policy: AgentMcpAccessPolicy = { mode: "denylist", servers: ["unsafe-server"] };
    expect(evaluateAgentMcpAccess(policy, "UNSAFE-server ")).toEqual({
      allowed: false,
      reason: "denied_by_denylist",
    });
    expect(evaluateAgentMcpAccess(policy, "safe-server")).toEqual({ allowed: true, reason: "ok" });
  });

  it("fails closed on empty server names before policy evaluation", () => {
    expect(evaluateAgentMcpAccess(null, "   ")).toEqual({
      allowed: false,
      reason: "invalid_server_name",
    });
    expect(evaluateAgentMcpAccess({ mode: "allow_all", servers: [] }, "")).toEqual({
      allowed: false,
      reason: "invalid_server_name",
    });
  });
});

describe("filterAllowedMcpServers", () => {
  const servers = [
    { name: "github", url: "https://github.example" },
    { name: "linear", url: "https://linear.example" },
    { name: "unsafe", url: "https://unsafe.example" },
  ];

  it("returns every server when no policy is given", () => {
    expect(filterAllowedMcpServers(servers)).toEqual(servers);
    expect(filterAllowedMcpServers(servers, null)).toEqual(servers);
  });

  it("keeps only allowed servers under an allowlist policy", () => {
    const policy: AgentMcpAccessPolicy = { mode: "allowlist", servers: ["github"] };
    expect(filterAllowedMcpServers(servers, policy)).toEqual([servers[0]]);
  });

  it("drops denied servers under a denylist policy", () => {
    const policy: AgentMcpAccessPolicy = { mode: "denylist", servers: ["unsafe"] };
    expect(filterAllowedMcpServers(servers, policy)).toEqual([servers[0], servers[1]]);
  });
});

describe("evaluateExecutionCapacity", () => {
  it("exposes the default caps", () => {
    expect(DEFAULT_MAX_CONCURRENT_WORKSPACE_PROCESSES).toBe(8);
    expect(DEFAULT_MAX_HOST_CONCURRENT_TURNS).toBe(16);
  });

  it("allows runs below both caps", () => {
    const result = evaluateExecutionCapacity({ activeWorkspaceProcesses: 3, activeHostTurns: 5 });
    expect(result).toEqual({ allowed: true, reason: "ok", reserveUserSlot: false });
  });

  it("denies runs at the workspace process cap", () => {
    const result = evaluateExecutionCapacity({
      activeWorkspaceProcesses: DEFAULT_MAX_CONCURRENT_WORKSPACE_PROCESSES,
      activeHostTurns: 0,
    });
    expect(result).toEqual({
      allowed: false,
      reason: "workspace_process_limit_reached",
      reserveUserSlot: false,
    });
  });

  it("reports the workspace reason when both caps are exceeded", () => {
    const result = evaluateExecutionCapacity({
      activeWorkspaceProcesses: DEFAULT_MAX_CONCURRENT_WORKSPACE_PROCESSES,
      activeHostTurns: DEFAULT_MAX_HOST_CONCURRENT_TURNS,
    });
    expect(result.reason).toBe("workspace_process_limit_reached");
  });

  it("applies custom workspace caps", () => {
    const atCap = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 2,
      activeHostTurns: 0,
      maxWorkspaceProcesses: 2,
    });
    expect(atCap.reason).toBe("workspace_process_limit_reached");
    const belowCap = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 1,
      activeHostTurns: 0,
      maxWorkspaceProcesses: 2,
    });
    expect(belowCap.allowed).toBe(true);
  });

  it("denies host turns at the cap even for user-initiated runs", () => {
    const result = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 0,
      activeHostTurns: DEFAULT_MAX_HOST_CONCURRENT_TURNS,
      isUserInitiated: true,
    });
    expect(result).toEqual({ allowed: false, reason: "host_turn_limit_reached", reserveUserSlot: true });
  });

  it("reserves the last host turn slot for human operators", () => {
    const automated = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 0,
      activeHostTurns: DEFAULT_MAX_HOST_CONCURRENT_TURNS - 1,
    });
    expect(automated).toEqual({ allowed: false, reason: "host_turn_limit_reached", reserveUserSlot: false });

    const userInitiated = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 0,
      activeHostTurns: DEFAULT_MAX_HOST_CONCURRENT_TURNS - 1,
      isUserInitiated: true,
    });
    expect(userInitiated).toEqual({ allowed: true, reason: "ok", reserveUserSlot: true });
  });

  it("reserves the human slot only when the host cap allows at least two turns", () => {
    const tinyCap = { activeWorkspaceProcesses: 0, activeHostTurns: 0, maxHostTurns: 1 };
    expect(evaluateExecutionCapacity({ ...tinyCap, isUserInitiated: false }).allowed).toBe(true);
    expect(evaluateExecutionCapacity({ ...tinyCap, activeHostTurns: 1, isUserInitiated: true }).allowed).toBe(
      false,
    );
  });

  it("applies custom host turn caps together with the reservation", () => {
    const userFits = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 0,
      activeHostTurns: 3,
      maxHostTurns: 4,
      isUserInitiated: true,
    });
    expect(userFits).toEqual({ allowed: true, reason: "ok", reserveUserSlot: true });
    const automatedBlocked = evaluateExecutionCapacity({
      activeWorkspaceProcesses: 0,
      activeHostTurns: 3,
      maxHostTurns: 4,
    });
    expect(automatedBlocked.allowed).toBe(false);
  });
});
