import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export const defaultCreateValues: CreateConfigValues = {
  adapterType: "claude_local",
  cwd: "",
  instructionsFilePath: "",
  promptTemplate: "",
  model: "",
  thinkingEffort: "",
  chrome: false,
  dangerouslySkipPermissions: true,
  search: false,
  dangerouslyBypassSandbox: false,
  command: "",
  fallbackCommand: "",
  fallbackModel: "",
  args: "",
  extraArgs: "",
  envVars: "",
  envBindings: {},
  url: "",
  bootstrapPrompt: "",
  payloadTemplateJson: "",
  workspaceStrategyType: "project_primary",
  workspaceBaseRef: "",
  workspaceBranchTemplate: "",
  worktreeParentDir: "",
  runtimeServicesJson: "",
  maxTurnsPerRun: 300,
  heartbeatEnabled: false,
  intervalSec: 300,
};

export interface ThinkingEffortOption {
  readonly id: string;
  readonly label: string;
}

export const codexThinkingEffortOptions: readonly ThinkingEffortOption[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];

export const antigravityThinkingEffortOptions: readonly ThinkingEffortOption[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];

export const openCodeThinkingEffortOptions: readonly ThinkingEffortOption[] = [
  { id: "", label: "Auto" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

export const cursorModeOptions: readonly ThinkingEffortOption[] = [
  { id: "", label: "Auto" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
];

export const claudeThinkingEffortOptions: readonly ThinkingEffortOption[] = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/**
 * Return static thinking-effort/mode dropdown options for non-dynamic adapters.
 */
export function getStaticThinkingEffortOptions(
  adapterType: string,
): readonly ThinkingEffortOption[] {
  switch (adapterType) {
    case "codex_local":
      return codexThinkingEffortOptions;
    case "antigravity_local":
      return antigravityThinkingEffortOptions;
    case "pi_local":
    case "opencode_local":
      return openCodeThinkingEffortOptions;
    case "cursor":
      return cursorModeOptions;
    default:
      return claudeThinkingEffortOptions;
  }
}
