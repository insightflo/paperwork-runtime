import fs from "node:fs";
import path from "node:path";
import {
  setNativeSecretRedactorDriver,
  type NativeSecretRedactorDriver,
} from "@paperclipai/adapter-utils/secret-redactor";

type NativeAddonExports = Partial<NativeSecretRedactorDriver> & {
  redactCurrentUserText?: (input: string, userNames: string[], homeDirs: string[], replacement: string | null) => string | null;
};

let addon: NativeAddonExports | null = null;
let resolvedPath: string | null = null;
const warnedPaths = new Set<string>();

function configuredPath(): string {
  const raw = process.env.PAPERCLIP_REDACTOR_LIB?.trim() ?? "";
  if (raw !== "" && (raw.includes("\0") || !path.isAbsolute(raw))) {
    warnLoadFailure(raw, new Error("invalid path (must be non-NUL absolute path)"), "path validation");
    return "";
  }
  return raw;
}

function warnLoadFailure(libPath: string, err: unknown, stage = "dlopen"): void {
  const key = `${stage}:${libPath}`;
  if (warnedPaths.has(key)) return;
  warnedPaths.add(key);
  const detail = err instanceof Error ? err.message : String(err);
  // Lazy import so this module can load without the server logger; if that import
  // itself fails, still surface the reason on stderr instead of dropping it.
  import("./middleware/logger.js")
    .then(({ logger }) => logger?.warn?.(`[redactor-native] ${stage} failed for ${libPath}: ${detail}`))
    .catch(() => console.warn(`[redactor-native] ${stage} failed for ${libPath}: ${detail}`));
}

function detach(): void {
  addon = null;
  resolvedPath = null;
  setNativeSecretRedactorDriver(null);
}

export function ensureNativeRedactorLoaded(): void {
  const cfg = configuredPath();
  if (cfg === (resolvedPath ?? "")) return; // loaded, failed-and-cached, or still unset
  if (!cfg) {
    if (resolvedPath !== null) detach();
    return;
  }
  detach();
  try {
    // Defense-in-depth before dlopen; POSIX permission/ownership bits are
    // meaningless on win32, so the stat guard runs on other platforms only.
    if (process.platform !== "win32") {
      const st = fs.statSync(cfg);
      if (!st.isFile() || (st.mode & 0o002) !== 0
        || (typeof process.getuid === "function" && st.uid !== 0 && st.uid !== process.getuid())) {
        throw new Error(`refusing unsafe native library permissions/ownership: ${cfg}`);
      }
    }
    const mod = { exports: {} as NativeAddonExports };
    process.dlopen(mod, cfg);
    if ([mod.exports.setRegisteredLiteralSecrets, mod.exports.registerRuntimeSecrets, mod.exports.clearRegisteredRuntimeSecrets, mod.exports.redactSensitiveText, mod.exports.redactEmbeddedJson]
      .some((fn) => typeof fn !== "function")) {
      throw new Error("missing native redactor exports");
    }
    addon = mod.exports;
    resolvedPath = cfg;
    setNativeSecretRedactorDriver(addon as NativeSecretRedactorDriver);
  } catch (err) {
    resolvedPath = cfg; // cache the failure; warn once per explicit path
    warnLoadFailure(cfg, err);
  }
}

export function resetNativeRedactorForTests(): void {
  warnedPaths.clear();
  detach();
  ensureNativeRedactorLoaded();
}

export function redactCurrentUserTextWithNative(
  input: string,
  userNames: string[],
  homeDirs: string[],
  replacement: string | null,
): string | null {
  const fn = addon?.redactCurrentUserText;
  if (typeof fn !== "function") return null;
  try {
    const out = fn.call(addon, input, userNames, homeDirs, replacement);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}
