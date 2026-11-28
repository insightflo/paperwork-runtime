export interface DevinCliHealthReport {
  installed: boolean;
  version: string | null;
  supportsHeadlessPrompt: boolean;
  supportsWorkspaceTrustFlag: boolean;
  supportsInProcessModel: boolean;
  supportsSessionResume: boolean;
  readyForPaperwork: boolean;
  missingFlags: string[];
}

const VERSION_PATTERN =
  /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![\w.])/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesFlag(helpOutput: string, ...flags: string[]): boolean {
  return flags.some((flag) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(flag)}(?![A-Za-z0-9-])`);
    return pattern.test(helpOutput);
  });
}

export function parseDevinCliVersion(stdout: string): string | null {
  const match = VERSION_PATTERN.exec(stdout);
  return match?.[1] ?? null;
}

export function evaluateDevinCliHealth(input: {
  versionOutput?: string | null;
  helpOutput?: string | null;
  exitCode?: number | null;
}): DevinCliHealthReport {
  const version = parseDevinCliVersion(input.versionOutput ?? "");
  const installed = (input.exitCode ?? 0) === 0 && Boolean(version);
  const helpOutput = input.helpOutput ?? "";

  const supportsHeadlessPrompt = includesFlag(helpOutput, "-p", "--prompt");
  const supportsWorkspaceTrustFlag = includesFlag(helpOutput, "--respect-workspace-trust");
  const supportsInProcessModel = includesFlag(helpOutput, "--process-model");
  const supportsSessionResume = includesFlag(helpOutput, "-r", "--resume");

  const missingFlags: string[] = [];
  if (!supportsHeadlessPrompt) missingFlags.push("-p");
  if (!supportsWorkspaceTrustFlag) missingFlags.push("--respect-workspace-trust");
  if (!supportsInProcessModel) missingFlags.push("--process-model");
  if (!supportsSessionResume) missingFlags.push("-r");

  return {
    installed,
    version,
    supportsHeadlessPrompt,
    supportsWorkspaceTrustFlag,
    supportsInProcessModel,
    supportsSessionResume,
    readyForPaperwork: installed && missingFlags.length === 0,
    missingFlags,
  };
}
