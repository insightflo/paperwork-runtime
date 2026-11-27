/**
 * Per-agent MCP access policy and execution capacity policy.
 *
 * Purpose
 * - Decide, per agent, which MCP tool servers may be reached, and gate new
 *   executions against workspace process and host turn concurrency caps.
 * - Modeled on OpenBot's mcp-access-v1, workspace-only-process-limit-v1, and
 *   host-turn-limits-v1 contracts.
 *
 * Connections
 * - Pure policy evaluators: no DB, no network. Callers (route handlers and
 *   dispatch services) pass agent policy config and current counters and act
 *   on the returned decisions.
 *
 * Caution
 * - Server names are compared only after trim + lowercase normalization;
 *   empty names always fail closed.
 * - The last host turn slot is reserved for user-initiated runs so automated
 *   background work cannot occupy every slot. Changing the reservation rules
 *   affects operator availability under load.
 */

export type AgentMcpAccessPolicyMode = "allow_all" | "allowlist" | "denylist";

export type AgentMcpAccessPolicy = {
  mode: AgentMcpAccessPolicyMode;
  servers: string[];
};

export type AgentMcpAccessDecision = {
  allowed: boolean;
  reason: string;
};

export const DEFAULT_MAX_CONCURRENT_WORKSPACE_PROCESSES = 8;
export const DEFAULT_MAX_HOST_CONCURRENT_TURNS = 16;

export type ExecutionCapacityInput = {
  activeWorkspaceProcesses: number;
  maxWorkspaceProcesses?: number;
  activeHostTurns: number;
  maxHostTurns?: number;
  isUserInitiated?: boolean;
};

export type ExecutionCapacityReason =
  | "ok"
  | "workspace_process_limit_reached"
  | "host_turn_limit_reached";

export type ExecutionCapacityDecision = {
  allowed: boolean;
  reason: ExecutionCapacityReason;
  reserveUserSlot: boolean;
};

const MCP_ACCESS_OK: AgentMcpAccessDecision = { allowed: true, reason: "ok" };

function normalizeMcpServerName(serverName: string): string {
  return serverName.trim().toLowerCase();
}

function normalizeServerList(servers: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const server of servers) {
    const name = normalizeMcpServerName(server ?? "");
    if (name) normalized.add(name);
  }
  return normalized;
}

/**
 * Evaluate one MCP server name against one agent's access policy.
 *
 * Input: the agent's policy (null/undefined means unrestricted) and the raw
 * server name as it appears in tool manifests. Output: an allow/deny decision
 * with a stable machine-readable reason. Denials are fail-closed: blank names
 * are rejected before the policy is even consulted, so an unparseable name
 * can never slip through an allow_all default.
 */
export function evaluateAgentMcpAccess(
  policy: AgentMcpAccessPolicy | null | undefined,
  serverName: string,
): AgentMcpAccessDecision {
  const normalizedName = normalizeMcpServerName(serverName ?? "");
  if (!normalizedName) {
    return { allowed: false, reason: "invalid_server_name" };
  }

  if (!policy || policy.mode === "allow_all") {
    return MCP_ACCESS_OK;
  }

  const configuredServers = normalizeServerList(policy.servers ?? []);
  if (policy.mode === "allowlist") {
    return configuredServers.has(normalizedName)
      ? MCP_ACCESS_OK
      : { allowed: false, reason: "denied_by_allowlist" };
  }

  return configuredServers.has(normalizedName)
    ? { allowed: false, reason: "denied_by_denylist" }
    : MCP_ACCESS_OK;
}

/**
 * Filter a server manifest down to the entries the agent may use.
 *
 * Input: any object list keyed by `name` and an optional policy. Output: a new
 * array containing only allowed entries; the original objects are returned
 * unchanged so callers keep extra fields (commands, env, urls).
 */
export function filterAllowedMcpServers<T extends { name: string }>(
  servers: readonly T[],
  policy?: AgentMcpAccessPolicy | null,
): T[] {
  if (!policy || policy.mode === "allow_all") {
    return [...servers];
  }
  return servers.filter((server) => evaluateAgentMcpAccess(policy, server.name).allowed);
}

/**
 * Decide whether a new execution may start under the process and turn caps.
 *
 * Input: current active workspace process and host turn counts, optional
 * custom caps (defaults 8 processes / 16 turns), and whether a human operator
 * initiated the run. Output: an allow/deny decision where the reason reports
 * the first cap hit (workspace processes are checked first) and
 * reserveUserSlot marks user-initiated requests.
 *
 * The last host turn slot is held back from automated runs when the cap is at
 * least 2, so background work can never take the slot a human operator needs;
 * user-initiated runs may consume it.
 */
export function evaluateExecutionCapacity(input: ExecutionCapacityInput): ExecutionCapacityDecision {
  const maxWorkspaceProcesses = input.maxWorkspaceProcesses ?? DEFAULT_MAX_CONCURRENT_WORKSPACE_PROCESSES;
  const maxHostTurns = input.maxHostTurns ?? DEFAULT_MAX_HOST_CONCURRENT_TURNS;
  const reserveUserSlot = input.isUserInitiated === true;
  const reservedHostTurns = !reserveUserSlot && maxHostTurns >= 2 ? 1 : 0;

  if (!(input.activeWorkspaceProcesses < maxWorkspaceProcesses)) {
    return { allowed: false, reason: "workspace_process_limit_reached", reserveUserSlot };
  }

  if (!(input.activeHostTurns < maxHostTurns - reservedHostTurns)) {
    return { allowed: false, reason: "host_turn_limit_reached", reserveUserSlot };
  }

  return { allowed: true, reason: "ok", reserveUserSlot };
}
