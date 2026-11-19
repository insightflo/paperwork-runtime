import path from "node:path";
import {
  setNativeSecretRedactorDriver,
  type NativeSecretRedactorDriver,
} from "@paperclipai/adapter-utils/secret-redactor";

interface NativeAddonExports {
  setRegisteredLiteralSecrets?: (literals: string[]) => void;
  registerRuntimeSecrets?: (values: string[], allowShort: boolean) => void;
  clearRegisteredRuntimeSecrets?: () => void;
  redactSensitiveText?: (value: string, emails: boolean, keepUnscanned: boolean) => string | null;
  redactEmbeddedJson?: (value: string, emails: boolean, keepUnscanned: boolean) => string | null;
  redactCurrentUserText?: (
    input: string,
    userNames: string[],
    homeDirs: string[],
    replacement: string | null,
  ) => string | null;
}

let addon: NativeAddonExports | null = null;
let resolvedPath: string | null = null;
const warnedPaths = new Set<string>();

function configuredPath(): string {
  const raw = process.env.PAPERCLIP_REDACTOR_LIB?.trim() ?? "";
  return raw !== "" && !raw.includes("\0") && path.isAbsolute(raw) ? raw : "";
}

function warnLoadFailure(libPath: string, err: unknown): void {
  if (warnedPaths.has(libPath)) return;
  warnedPaths.add(libPath);
  const detail = err instanceof Error ? err.message : String(err);
  // Lazy import keeps this module free of server logger deps for browser-side bundles.
  import("./middleware/logger.js")
    .then(({ logger }) => logger?.warn?.(`[redactor-native] dlopen failed for ${libPath}: ${detail}`))
    .catch(() => {});
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
    const mod = { exports: {} as NativeAddonExports };
    process.dlopen(mod, cfg);
    if (
      typeof mod.exports.redactSensitiveText !== "function"
      || typeof mod.exports.redactEmbeddedJson !== "function"
    ) {
      throw new Error("missing redactSensitiveText/redactEmbeddedJson exports");
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
  addon = null;
  resolvedPath = null;
  warnedPaths.clear();
  setNativeSecretRedactorDriver(null);
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
