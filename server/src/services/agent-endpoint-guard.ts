// Unified fail-closed pre-flight guard for agent local-tool calls against a
// personal endpoint bot. An agent may only execute a local task when BOTH its
// own botPolicy (per-folder ro/rw grants) AND the endpoint's allowed folder
// grants, destructive shell denylist, and size caps permit the call. Composes
// agent-bot-policy.ts (agent-side 4-tab policy) with
// endpoint-local-tool-bridge.ts (endpoint-side validation). Pure; no I/O.

import { canAgentAccessFolder, validateBotPolicy } from "./agent-bot-policy.js";
import {
  validateAndBuildEndpointTask,
  type AllowedFolderGrant,
  type LocalToolCall,
  type ValidatedEndpointTask,
} from "./endpoint-local-tool-bridge.js";

export type AgentEndpointGuardLayer = "agent_policy" | "endpoint_bridge";

export type AgentEndpointGuardDenial = {
  allowed: false;
  layer: AgentEndpointGuardLayer;
  reason: string;
};

export type AgentEndpointGuardResult =
  | { allowed: true; task: ValidatedEndpointTask }
  | AgentEndpointGuardDenial;

type RequiredMode = "ro" | "rw";

function deny(layer: AgentEndpointGuardLayer, reason: string): AgentEndpointGuardDenial {
  return { allowed: false, layer, reason };
}

// Reads (file/dir) need ro; writes and shell execution need rw. An unknown
// kind yields null so the caller can fail closed instead of guessing.
function requiredFolderMode(kind: LocalToolCall["kind"]): RequiredMode | null {
  if (kind === "local_read_file" || kind === "local_list_dir") return "ro";
  if (kind === "local_write_file" || kind === "local_shell_exec") return "rw";
  return null;
}

// The agent-policy folder check anchors on the file path for file/dir tools
// and on the working directory for shell execution, so the matched folder and
// its required mode are always well-defined.
function policyAnchorPath(call: LocalToolCall): string | null {
  if (call.kind === "local_shell_exec") return typeof call.cwd === "string" ? call.cwd : null;
  return typeof call.path === "string" ? call.path : null;
}

/**
 * Decides whether an agent may run a local tool call on a personal endpoint
 * bot, layering both permission sources fail-closed:
 *
 * 1. agent_policy — the agent's raw botPolicy is validated first; an invalid
 *    or unusable policy denies explicitly rather than silently falling back
 *    to defaults. Then the folder grant required by the call's mode is
 *    checked via canAgentAccessFolder.
 * 2. endpoint_bridge — the endpoint's folder grants, destructive shell
 *    denylist, and size caps are enforced via validateAndBuildEndpointTask.
 *
 * Only when both layers pass is an endpoint task payload produced.
 */
export function evaluateAgentEndpointToolCall(input: {
  rawBotPolicy: unknown;
  endpointFolders: readonly AllowedFolderGrant[];
  call: LocalToolCall;
}): AgentEndpointGuardResult {
  const call = input?.call;
  const mode = requiredFolderMode(call?.kind);
  if (!mode) {
    return deny("agent_policy", `unknown or missing local tool kind: ${String(call?.kind)}`);
  }

  const anchor = policyAnchorPath(call);
  if (anchor === null) {
    return deny("agent_policy", "call is missing the target path required by its tool kind");
  }

  const policyCheck = validateBotPolicy(input?.rawBotPolicy);
  if (!policyCheck.ok) {
    return deny("agent_policy", `invalid botPolicy: ${policyCheck.errors.join("; ")}`);
  }

  if (!canAgentAccessFolder(policyCheck.policy, anchor, mode)) {
    return deny("agent_policy", `agent botPolicy does not grant ${mode} access to ${anchor}`);
  }

  const endpointCheck = validateAndBuildEndpointTask({ call, allowedFolders: input?.endpointFolders });
  if (!endpointCheck.ok) {
    return deny("endpoint_bridge", `${endpointCheck.code}: ${endpointCheck.message}`);
  }

  return { allowed: true, task: endpointCheck.task };
}
