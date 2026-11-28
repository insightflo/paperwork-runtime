import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function resolvePaperclipHomeDir(): string {
  const paperworkHome = process.env.PAPERWORK_HOME?.trim();
  if (paperworkHome) return path.resolve(expandHomePrefix(paperworkHome));
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".paperclip");
}

export function resolvePaperworkHomeDir(): string {
  const paperworkHome = process.env.PAPERWORK_HOME?.trim();
  if (paperworkHome) return path.resolve(expandHomePrefix(paperworkHome));
  const paperclipHome = process.env.PAPERCLIP_HOME?.trim();
  if (paperclipHome) return path.resolve(expandHomePrefix(paperclipHome));
  return path.resolve(os.homedir(), ".paperwork");
}

export function resolvePaperclipInstanceId(override?: string): string {
  const raw = override?.trim() || process.env.PAPERCLIP_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(
      `Invalid instance id '${raw}'. Allowed characters: letters, numbers, '_' and '-'.`,
    );
  }
  return raw;
}

export function resolvePaperclipInstanceRoot(instanceId?: string): string {
  const id = resolvePaperclipInstanceId(instanceId);
  return path.resolve(resolvePaperclipHomeDir(), "instances", id);
}

export function resolveDefaultConfigPath(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "config.json");
}

export function resolveDefaultContextPath(): string {
  return path.resolve(resolvePaperclipHomeDir(), "context.json");
}

export function resolveLegacyCliAuthPath(): string {
  return path.resolve(resolvePaperclipHomeDir(), "auth.json");
}

export function resolveDefaultCliAuthPath(): string {
  const paperworkHome = process.env.PAPERWORK_HOME?.trim();
  if (paperworkHome) {
    return path.resolve(expandHomePrefix(paperworkHome), "auth.json");
  }

  const paperclipHome = process.env.PAPERCLIP_HOME?.trim();
  if (paperclipHome) {
    return path.resolve(expandHomePrefix(paperclipHome), "auth.json");
  }

  const paperworkAuthPath = path.resolve(resolvePaperworkHomeDir(), "auth.json");
  if (fs.existsSync(paperworkAuthPath)) return paperworkAuthPath;

  const legacyAuthPath = resolveLegacyCliAuthPath();
  if (fs.existsSync(legacyAuthPath)) return legacyAuthPath;

  return paperworkAuthPath;
}

export function resolveDefaultEmbeddedPostgresDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "db");
}

export function resolveDefaultLogsDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "logs");
}

export function resolveDefaultSecretsKeyFilePath(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "secrets", "master.key");
}

export function resolveDefaultStorageDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "data", "storage");
}

export function resolveDefaultBackupDir(instanceId?: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(instanceId), "data", "backups");
}

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function describeLocalInstancePaths(instanceId?: string) {
  const resolvedInstanceId = resolvePaperclipInstanceId(instanceId);
  const instanceRoot = resolvePaperclipInstanceRoot(resolvedInstanceId);
  return {
    homeDir: resolvePaperclipHomeDir(),
    instanceId: resolvedInstanceId,
    instanceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId),
    logDir: resolveDefaultLogsDir(resolvedInstanceId),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId),
  };
}
