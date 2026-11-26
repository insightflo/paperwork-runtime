import fs from "node:fs/promises";
import path from "node:path";

/**
 * Command Code only honours `permissions.additionalDirectories` from its settings
 * layers (user / project / project-local); there is no CLI flag or env var for it.
 * In headless (`-p`) runs the `--add-dir` flag is a no-op, so a run whose agent
 * instructions reference absolute paths outside the workspace gets
 * `Permission denied by the user.` and stops with `stopReason=permission_denied`.
 *
 * This module owns the project-local settings layer only and merges into it, so
 * an operator's other permission settings (allow/deny/defaultMode/...) survive.
 */
export const SETTINGS_LOCAL_RELATIVE_PATH = ".commandcode/settings.local.json";

export interface MergedAdditionalDirectories {
  settings: Record<string, unknown>;
  changed: boolean;
  previous: string[];
  next: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDirectoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Merge `directories` into an existing settings document without dropping any
 * other key. Returns `changed: false` when the document already covers every
 * requested directory, so callers can skip the write entirely.
 */
export function mergeAdditionalDirectories(
  existing: unknown,
  directories: string[],
): MergedAdditionalDirectories {
  const settings = isPlainObject(existing) ? { ...existing } : {};
  const permissions = isPlainObject(settings.permissions) ? { ...settings.permissions } : {};
  const previous = toDirectoryList(permissions.additionalDirectories);
  const next = uniqueInOrder([...previous, ...directories.filter((d) => d.trim().length > 0)]);
  const changed = next.length !== previous.length;
  if (changed) {
    permissions.additionalDirectories = next;
    settings.permissions = permissions;
  }
  return { settings, changed, previous, next };
}

export interface EnsureAdditionalDirectoriesParams {
  /** Effective workspace cwd; the project-local settings layer lives under it. */
  cwd: string;
  /** Absolute directories the run must be able to read outside the workspace. */
  directories: string[];
}

export interface EnsureAdditionalDirectoriesResult {
  applied: boolean;
  changed: boolean;
  settingsPath: string;
  directories: string[];
  skippedReason: string | null;
}

/**
 * Make sure `.commandcode/settings.local.json` under `cwd` grants every
 * requested directory. Existing content is preserved; an unparseable settings
 * file is left untouched and reported instead of overwritten, because it may
 * carry operator-authored permission rules we cannot recover.
 */
export async function ensureCommandCodeAdditionalDirectories(
  params: EnsureAdditionalDirectoriesParams,
): Promise<EnsureAdditionalDirectoriesResult> {
  const settingsPath = path.join(params.cwd, SETTINGS_LOCAL_RELATIVE_PATH);
  const directories = uniqueInOrder(params.directories.filter((d) => d.trim().length > 0));
  if (directories.length === 0) {
    return {
      applied: false,
      changed: false,
      settingsPath,
      directories: [],
      skippedReason: "no additionalDirectories configured",
    };
  }

  let parsed: unknown;
  let existed = true;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        applied: false,
        changed: false,
        settingsPath,
        directories,
        skippedReason: `could not read existing settings file: ${reason}`,
      };
    }
    existed = false;
    parsed = {};
  }

  const merged = mergeAdditionalDirectories(parsed, directories);
  if (!merged.changed) {
    return { applied: true, changed: false, settingsPath, directories, skippedReason: null };
  }

  if (existed && !isPlainObject(parsed)) {
    return {
      applied: false,
      changed: false,
      settingsPath,
      directories,
      skippedReason: "existing settings file is not a JSON object",
    };
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(merged.settings, null, 2)}\n`, "utf8");
  return { applied: true, changed: true, settingsPath, directories, skippedReason: null };
}

export type RunLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

/**
 * Read the adapter-level `additionalDirectories` config for a run. Only an array
 * of non-blank strings is honoured; any other shape yields no directories, so a
 * mistyped value grants nothing rather than something unintended. Relative
 * entries are resolved against the effective cwd so the granted paths do not
 * depend on how Command Code would resolve them.
 */
export function resolveConfiguredAdditionalDirectories(
  config: Record<string, unknown>,
  cwd: string,
): string[] {
  const raw = config.additionalDirectories;
  if (!Array.isArray(raw)) return [];
  return uniqueInOrder(
    raw
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => path.resolve(cwd, entry.trim())),
  );
}

export interface RunAdditionalDirectoriesParams {
  config: Record<string, unknown>;
  /** Effective workspace cwd the headless run will be spawned in. */
  cwd: string;
  onLog: RunLog;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NOT_GRANTED_HINT =
  "out-of-workspace reads are not granted; the run may fail with permission_denied";

/**
 * execute.ts seam: persist the configured directories into the project-local
 * settings layer before a headless (`-p`) run, where `--add-dir` is a no-op.
 *
 * Does nothing at all when no directories are configured. Never throws: a
 * settings file that cannot be read, parsed, or written is reported on the run
 * log and left as-is, and the run proceeds exactly as it would have without
 * this step. This widens nothing — the worst case is the pre-existing behaviour
 * (Command Code denies the read and the run fails as `permission_denied`).
 */
export async function ensureCommandCodeRunAdditionalDirectories(
  params: RunAdditionalDirectoriesParams,
): Promise<EnsureAdditionalDirectoriesResult> {
  const { config, cwd, onLog } = params;
  const directories = resolveConfiguredAdditionalDirectories(config, cwd);
  if (directories.length === 0) {
    return {
      applied: false,
      changed: false,
      settingsPath: path.join(cwd, SETTINGS_LOCAL_RELATIVE_PATH),
      directories: [],
      skippedReason: "no additionalDirectories configured",
    };
  }

  let result: EnsureAdditionalDirectoriesResult;
  try {
    result = await ensureCommandCodeAdditionalDirectories({ cwd, directories });
  } catch (err) {
    result = {
      applied: false,
      changed: false,
      settingsPath: path.join(cwd, SETTINGS_LOCAL_RELATIVE_PATH),
      directories,
      skippedReason: `could not write settings file: ${errorReason(err)}`,
    };
  }

  if (!result.applied) {
    await onLog(
      "stderr",
      `[paperclip] Warning: Command Code additionalDirectories were not applied (${result.skippedReason}); ${NOT_GRANTED_HINT}.\n`,
    );
  } else if (result.changed) {
    await onLog(
      "stdout",
      `[paperclip] Granted Command Code additionalDirectories in ${result.settingsPath}: ${result.directories.join(", ")}\n`,
    );
  }
  return result;
}
