export interface BuildAntigravityArgsInput {
  cwd: string;
  prompt: string;
  printTimeout: string;
  bypassPermissions: boolean;
  sandbox: boolean;
  sessionId: string | null;
  extraArgs: string[];
  diagnosticLogFilePath?: string;
  model?: string;
  effort?: string;
}

const MODEL_EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;

/**
 * Extract the effort tier embedded in an `agy models` id (e.g. `-high`, `-xhigh`), if any.
 */
export function extractAntigravityModelEffortSuffix(model: string): string | null {
  const match = model.trim().match(MODEL_EFFORT_SUFFIX_RE);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function readFlagValueFromArgs(args: string[], flag: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) {
      return args[i + 1]?.trim() ?? "";
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1).trim();
    }
  }
  return null;
}

export interface ResolvedAntigravityModelAndEffort {
  passModel: string | null;
  passEffort: string | null;
  conflictWarning: string | null;
}

/**
 * Resolve `--model` and `--effort` CLI flags while respecting `extraArgs` and
 * preventing `agy` errors when a suffixed model id conflicts with `--effort`.
 */
export function resolveAntigravityModelAndEffort(input: {
  model?: string;
  effort?: string;
  extraArgs: string[];
}): ResolvedAntigravityModelAndEffort {
  const extraModel = readFlagValueFromArgs(input.extraArgs, "--model");
  const extraEffort = readFlagValueFromArgs(input.extraArgs, "--effort");
  const configuredModel = input.model?.trim() ?? "";
  const isConfiguredAuto = configuredModel.length === 0 || configuredModel.toLowerCase() === "auto";
  const passModel = extraModel === null && !isConfiguredAuto ? configuredModel : null;

  const effectiveModel = extraModel !== null ? extraModel : isConfiguredAuto ? "" : configuredModel;
  const normalizedEffort = input.effort?.trim().toLowerCase() ?? "";
  if (extraEffort !== null || normalizedEffort.length === 0) {
    return { passModel, passEffort: null, conflictWarning: null };
  }

  const embeddedEffort = effectiveModel ? extractAntigravityModelEffortSuffix(effectiveModel) : null;
  if (embeddedEffort !== null && embeddedEffort !== normalizedEffort) {
    return {
      passModel,
      passEffort: null,
      conflictWarning: `Omitting conflicting --effort "${normalizedEffort}" because model "${effectiveModel}" already encodes effort "${embeddedEffort}".`,
    };
  }

  return { passModel, passEffort: normalizedEffort, conflictWarning: null };
}

/**
 * Build CLI arguments for `agy`, placing control flags before `--print`.
 */
export function buildAntigravityArgs(input: BuildAntigravityArgsInput): string[] {
  const args: string[] = [];
  if (input.printTimeout.trim()) args.push("--print-timeout", input.printTimeout.trim());
  if (input.bypassPermissions) args.push("--dangerously-skip-permissions");
  if (input.sandbox) args.push("--sandbox");
  args.push("--add-dir", input.cwd);
  if (input.sessionId) args.push("--conversation", input.sessionId);

  const { passModel, passEffort } = resolveAntigravityModelAndEffort({
    model: input.model,
    effort: input.effort,
    extraArgs: input.extraArgs,
  });
  if (passModel) args.push("--model", passModel);
  if (passEffort) args.push("--effort", passEffort);

  const diagnosticLogFilePath = input.diagnosticLogFilePath?.trim();
  const extraArgs = diagnosticLogFilePath
    ? input.extraArgs.filter((arg, index, all) => arg !== "--log-file" && all[index - 1] !== "--log-file")
    : input.extraArgs;
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (diagnosticLogFilePath) args.push("--log-file", diagnosticLogFilePath);
  args.push("--print", input.prompt);
  return args;
}
