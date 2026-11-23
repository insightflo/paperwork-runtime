import { joinPromptSections, type AcpFlavor, type AcpFlavorBuildArgsInput } from "@paperclipai/adapter-utils";
import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";

export interface BuildClaudeArgsOptions {
  resumeSessionId: string | null;
  model: string;
  effort: string;
  maxTurns: number;
  dangerouslySkipPermissions: boolean;
  chrome: boolean;
  instructionsFilePath?: string;
  disallowedTools?: readonly string[];
  skillsDir?: string;
  extraArgs?: readonly string[];
}

export function buildClaudeArgs(options: BuildClaudeArgsOptions): string[] {
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (options.chrome) args.push("--chrome");
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.maxTurns > 0) args.push("--max-turns", String(options.maxTurns));
  if (options.instructionsFilePath) {
    args.push("--append-system-prompt-file", options.instructionsFilePath);
  }
  const disallowedTools = options.disallowedTools ?? [];
  if (disallowedTools.length > 0) {
    args.push("--disallowedTools", disallowedTools.join(","));
  }
  if (options.skillsDir) args.push("--add-dir", options.skillsDir);
  const extraArgs = options.extraArgs ?? [];
  if (extraArgs.length > 0) args.push(...extraArgs);
  return args;
}

/** Flags the driver controls; matching user-supplied args are stripped. */
export const CLAUDE_RESERVED_ARGS = [
  "--print",
  "--output-format",
  "--verbose",
  "--resume",
  "--dangerously-skip-permissions",
  "--chrome",
  "--model",
  "--effort",
  "--max-turns",
  "--append-system-prompt-file",
  "--disallowedTools",
  "--disallowed-tools",
  "--add-dir",
] as const;

export const claudeFlavor: AcpFlavor = {
  key: "claude",
  protocolTransport: "agent_text",
  defaultCommand: "claude",
  supportsSessionResume: true,
  reservedArgs: CLAUDE_RESERVED_ARGS,
  buildArgs(input: AcpFlavorBuildArgsInput): string[] {
    const config = input.config;
    return buildClaudeArgs({
      resumeSessionId: input.resumeSessionId,
      model: input.model,
      effort: input.effort,
      maxTurns: input.maxTurns,
      dangerouslySkipPermissions: asBoolean(
        config.dangerouslySkipPermissions,
        config.dangerouslySkipPermissions !== false,
      ),
      chrome: asBoolean(config.chrome, false),
      instructionsFilePath: asString(config.instructionsFilePath, "") || undefined,
      disallowedTools: asStringArray(config.disallowedTools),
      skillsDir: asString(config.skillsDir, "") || undefined,
      extraArgs: input.extraArgs,
    });
  },
};

export function buildClaudeVisionDelegationBrief(input: {
  visionCommand: string;
  visionModel: string;
}): string {
  const visionHelperCommand = input.visionCommand || "$PAPERCLIP_VISION_COMMAND";
  return joinPromptSections([
    "Paperclip vision delegation (CRITICAL):",
    "- Keep your main reasoning on the configured primary model.",
    "- The primary model may be text-only. For image artifacts, using the Read tool sends image input to the primary model and can fail the run.",
    "- If a path ends in .png, .jpg, .jpeg, .webp, or .gif, DO NOT use the Read tool on that path.",
    "- Instead delegate only the visual inspection to the vision helper command via Bash, then continue from the helper's text result.",
    `- Helper command format: ${visionHelperCommand} <image-path> "<specific visual question>"`,
    `- Example: ${visionHelperCommand} "/absolute/path/to/artifact.png" "Validate visible text, claims, layout, and obvious rendering errors; return PASS or issues."`,
    `- Vision model hint: ${input.visionModel || "$PAPERCLIP_VISION_MODEL" || "vision-capable model"}.`,
    "- If the helper command is unavailable, block with a clear setup error instead of attempting image input on the primary model.",
  ]);
}
