import { posix, win32 } from "node:path";

export type SupportedLocalCli = "pi" | "claude" | "codex" | "agy" | "opencode" | "cursor" | "gemini";

export interface CliDelegationRequest {
  cli: SupportedLocalCli;
  prompt: string;
  cwd: string;
  allowedFolders: { path: string; mode: "ro" | "rw" }[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CliDelegationPlan {
  cli: SupportedLocalCli;
  /** Arguments only: invoke cli with these arguments and shell: false. */
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

const defaultOrder: SupportedLocalCli[] = ["pi", "codex", "claude", "gemini", "opencode", "cursor", "agy"];

function isSupported(cli: string): cli is SupportedLocalCli {
  return defaultOrder.includes(cli as SupportedLocalCli);
}

export function selectPreferredLocalCli(
  detectedClis: string[],
  preferredOrder: SupportedLocalCli[] = defaultOrder,
): SupportedLocalCli | null {
  return preferredOrder.find((cli) => isSupported(cli) && detectedClis.includes(cli)) ?? null;
}

function absolutePath(value: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid cwd or allowed folder path");
  }
  // Endpoint paths must be interpreted independently of the server's own OS.
  // Reject drive-relative, UNC/device paths and ambiguous POSIX backslashes.
  const windows = /^[a-z]:[\\/]/i.test(value);
  const paths = windows ? win32 : posix;
  if (!paths.isAbsolute(value) || (!windows && (value.includes("\\") || value.startsWith("//")))) {
    throw new Error("Expected an unambiguous absolute path");
  }
  if (windows && value.slice(3).split(/[\\/]/).some((part) =>
    /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Invalid Windows path segment");
  }
  return { value: paths.normalize(value), paths };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error("Invalid resource limit");
  return Math.floor(Math.max(min, Math.min(max, value)));
}

/** Pure lexical planner. The endpoint must check realpaths/symlinks and enforce limits at execution. */
export function buildLocalCliDelegationPlan(request: CliDelegationRequest): CliDelegationPlan {
  const { cli, prompt, allowedFolders } = request;
  if (!isSupported(cli)) throw new Error("Unsupported local CLI");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32_000 || prompt.includes("\0")) {
    throw new Error("Prompt must contain 1 to 32000 characters without null bytes");
  }
  // Some CLIs treat '-' as stdin/options and '@' as file expansion, even without a shell.
  if (/^[-@]/.test(prompt)) throw new Error("Prompt cannot begin with CLI option or file syntax");
  const cwd = absolutePath(request.cwd);
  if (!Array.isArray(allowedFolders)) throw new Error("Missing allowed folders");
  let writable = false;
  for (const folder of allowedFolders) {
    if (!folder || (folder.mode !== "ro" && folder.mode !== "rw")) throw new Error("Invalid folder policy");
    const root = absolutePath(folder.path);
    if (root.paths !== cwd.paths) continue;
    const relative = cwd.paths.relative(root.value, cwd.value);
    const contains = relative === "" || (!cwd.paths.isAbsolute(relative) &&
      relative !== ".." && !relative.startsWith(`..${cwd.paths.sep}`));
    if (!contains) continue;
    if (folder.mode === "ro") throw new Error("cwd is in a read-only allowed folder");
    writable = true;
  }
  if (!writable) throw new Error("cwd must be inside a read-write allowed folder");

  const prefixes: Record<SupportedLocalCli, string[]> = {
    pi: ["--no-session", "-p"],
    codex: ["exec", "--"],
    claude: ["-p"],
    gemini: ["-p"],
    agy: ["-p"],
    opencode: ["run", "--"],
    cursor: ["agent", "-p"],
  };
  return {
    cli,
    argv: [...prefixes[cli], prompt],
    cwd: cwd.value,
    timeoutMs: clamp(request.timeoutMs, 120_000, 5_000, 600_000),
    maxOutputBytes: clamp(request.maxOutputBytes, 131_072, 4_096, 1_048_576),
  };
}
