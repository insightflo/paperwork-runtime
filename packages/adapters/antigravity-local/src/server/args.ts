import { asStringArray } from "@paperclipai/adapter-utils/server-utils";

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

function parseFiniteNonNegativeSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }
  return null;
}

/**
 * Resolve `--print-timeout` for `agy --print`: honor explicit `printTimeout` /
 * `printTimeoutSec`, otherwise follow `timeoutSec` when positive, or fall back
 * to `"0s"` (wait until turn completes) unless already set in `extraArgs`.
 */
export function resolveAntigravityPrintTimeout(input: {
  printTimeout?: unknown;
  printTimeoutSec?: unknown;
  timeoutSec?: unknown;
  extraArgs?: string[];
}): string {
  if (input.extraArgs && readFlagValueFromArgs(input.extraArgs, "--print-timeout") !== null) {
    return "";
  }
  if (typeof input.printTimeout === "string" && input.printTimeout.trim().length > 0) {
    return input.printTimeout.trim();
  }
  const explicitSec = parseFiniteNonNegativeSeconds(input.printTimeoutSec);
  if (explicitSec !== null) {
    return `${explicitSec}s`;
  }
  const timeoutSec = parseFiniteNonNegativeSeconds(input.timeoutSec);
  if (timeoutSec !== null && timeoutSec > 0) {
    return `${timeoutSec}s`;
  }
  return "0s";
}

/**
 * Resolve `--dangerously-skip-permissions`, preferring the canonical
 * `dangerouslySkipPermissions` field edited by the UI over legacy `bypassPermissions`.
 */
export function resolveAntigravityBypassPermissions(config: Record<string, unknown>): boolean {
  if (typeof config.dangerouslySkipPermissions === "boolean") {
    return config.dangerouslySkipPermissions;
  }
  if (typeof config.bypassPermissions === "boolean") {
    return config.bypassPermissions;
  }
  return false;
}

/**
 * Resolve extra CLI arguments, preferring `extraArgs` over legacy `args`.
 */
export function resolveAntigravityExtraArgs(config: Record<string, unknown>): string[] {
  const fromExtraArgs = asStringArray(config.extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(config.args);
}

/**
 * Build concise headless `agy --print` guidance so commands avoid unnecessary
 * environment dumps and `BypassSandbox` escalations that trigger safety-monitor denials.
 */
export function buildAntigravityExecutionNote(input: { sandbox: boolean }): string {
  const lines = [
    "Antigravity CLI headless execution notes:",
    "- Paperclip already exports PAPERCLIP_API_URL, PAPERCLIP_API_BASE_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID, and PAPERCLIP_AGENT_ID into the shell environment. Do NOT inspect or print raw environment variables (such as env/printenv) or echo $PAPERCLIP_API_KEY, because Antigravity's credential safety monitor blocks credential-inspection commands in headless runs; reference $PAPERCLIP_API_KEY directly in curl Authorization headers or os.environ inside scripts.",
  ];
  if (!input.sandbox) {
    lines.push(
      '- Terminal sandbox is disabled for this run (--sandbox is off). Do NOT pass `"BypassSandbox": true` or request unsandboxed escalation in tool calls, because unsandboxed API-mutation requests trigger interactive monitor confirmations that auto-deny in non-interactive --print runs.',
    );
  }
  return lines.join("\n");
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
