import { posix, win32 } from "node:path";

type AccessLevel = "full" | "ask" | "read_only";
type FolderMode = "ro" | "rw";
type McpMode = "allow_all" | "allowlist" | "denylist";
type BusyMessagePolicy = "queue" | "steer" | "side_task";
type NotificationLevel = "all" | "mentions_and_approvals" | "muted";
type AgentFolderGrant = { path: string; mode: FolderMode };
type AgentMcpAccess = { mode: McpMode; servers: string[] };

export type NormalizedBotPolicy = {
  accessLevel: AccessLevel;
  allowedFolders: AgentFolderGrant[];
  allowComputerUse: boolean;
  allowLocalScripts: boolean;
  canStartNewThreads: boolean;
  mcpAccess: AgentMcpAccess;
  busyMessagePolicy: BusyMessagePolicy;
  notificationLevel: NotificationLevel;
  fastMode: boolean;
  showPlanCard: boolean;
  memoryLimit: number | null;
  maxConcurrentTasks: number | null;
};

export type BotPolicyValidationResult = { ok: true; policy: NormalizedBotPolicy } | { ok: false; errors: string[] };

const frozenFolders = Object.freeze([]) as unknown as AgentFolderGrant[];
const frozenServers = Object.freeze([]) as unknown as string[];
const frozenMcp = Object.freeze({ mode: "allowlist" as const, servers: frozenServers }) as unknown as AgentMcpAccess;
export const DEFAULT_BOT_POLICY: Readonly<NormalizedBotPolicy> = Object.freeze({
  accessLevel: "read_only", allowedFolders: frozenFolders,
  allowComputerUse: false, allowLocalScripts: false, canStartNewThreads: false,
  mcpAccess: frozenMcp, busyMessagePolicy: "queue", notificationLevel: "mentions_and_approvals",
  fastMode: false, showPlanCard: true, // Chosen display default: plans remain visible.
  memoryLimit: 1000, maxConcurrentTasks: 1,
});

const ACCESS_LEVELS: readonly string[] = ["full", "ask", "read_only"];
const FOLDER_MODES: readonly string[] = ["ro", "rw"];
const MCP_MODES: readonly string[] = ["allow_all", "allowlist", "denylist"];
const BUSY_POLICIES: readonly string[] = ["queue", "steer", "side_task"];
const NOTIFICATIONS: readonly string[] = ["all", "mentions_and_approvals", "muted"];
const BOOLEAN_KEYS = ["allowComputerUse", "allowLocalScripts", "canStartNewThreads", "fastMode", "showPlanCard"] as const;

type RecordValue = Record<string, unknown>;
type CanonicalPath = { value: string; flavor: "posix" | "win32" };

function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }

function isChoice(value: unknown, choices: readonly string[]): value is string { return typeof value === "string" && choices.includes(value); }

function defaultPolicy(): NormalizedBotPolicy { return { ...DEFAULT_BOT_POLICY, allowedFolders: [], mcpAccess: { mode: "allowlist", servers: [] } }; }

function hasTraversal(value: string): boolean { return value.split(/[\\/]/).includes(".."); }

function canonicalizePath(input: string, trim: boolean): CanonicalPath | null {
  const value = trim ? input.trim() : input;
  if (!value || value.includes("\0") || hasTraversal(value)) return null;
  const drive = /^[A-Za-z]:[\\/]/.test(value);
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
  if (drive || unc) {
    if (!win32.isAbsolute(value)) return null;
    let normalized = win32.normalize(value);
    const root = win32.parse(normalized).root;
    while (normalized.length > root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
    return { value: normalized, flavor: "win32" };
  }
  if (!posix.isAbsolute(value)) return null;
  let normalized = posix.normalize(value);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return { value: normalized, flavor: "posix" };
}

function normalizeFolders(value: unknown): AgentFolderGrant[] {
  if (!Array.isArray(value)) return [];
  const grants = new Map<string, AgentFolderGrant>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== "string" || !isChoice(item.mode, FOLDER_MODES)) continue;
    const path = canonicalizePath(item.path, true);
    if (!path) continue;
    const key = path.flavor === "win32" ? path.value.toLowerCase() : path.value;
    const current = grants.get(key);
    const mode: FolderMode = current?.mode === "ro" || item.mode === "ro" ? "ro" : "rw";
    grants.set(key, { path: current?.path ?? path.value, mode });
  }
  return [...grants.values()];
}

function denyAllMcp(): AgentMcpAccess { return { mode: "allowlist", servers: [] }; }

function normalizeMcp(value: unknown): AgentMcpAccess {
  if (!isRecord(value) || !isChoice(value.mode, MCP_MODES) || !Array.isArray(value.servers)) return denyAllMcp();
  if (value.servers.some((server) => typeof server !== "string" || server.includes("\0") || (value.mode === "denylist" && !server.trim()))) return denyAllMcp();
  const servers = [...new Set((value.servers as string[]).map((server) => server.trim()).filter(Boolean))];
  return { mode: value.mode as McpMode, servers };
}

function normalizeCap(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Coerce stored JSON into a fresh, safe policy without sharing mutable defaults. */
export function normalizeBotPolicy(raw: unknown): NormalizedBotPolicy {
  if (raw === null || raw === undefined || !isRecord(raw)) return defaultPolicy();
  const policy = defaultPolicy();
  if (isChoice(raw.accessLevel, ACCESS_LEVELS)) policy.accessLevel = raw.accessLevel as AccessLevel;
  policy.allowedFolders = normalizeFolders(raw.allowedFolders);
  for (const key of BOOLEAN_KEYS) if (typeof raw[key] === "boolean") policy[key] = raw[key] as never;
  if (isChoice(raw.busyMessagePolicy, BUSY_POLICIES)) policy.busyMessagePolicy = raw.busyMessagePolicy as BusyMessagePolicy;
  if (isChoice(raw.notificationLevel, NOTIFICATIONS)) policy.notificationLevel = raw.notificationLevel as NotificationLevel;
  policy.mcpAccess = raw.mcpAccess === undefined
    ? { mode: "allowlist", servers: [] }
    : normalizeMcp(raw.mcpAccess);
  policy.memoryLimit = normalizeCap(raw.memoryLimit, 0, 10000, 1000);
  policy.maxConcurrentTasks = normalizeCap(raw.maxConcurrentTasks, 1, 16, 1);
  return policy;
}

function validateFolders(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) { errors.push("allowedFolders must be an array"); return; }
  value.forEach((item, index) => {
    if (!isRecord(item)) { errors.push(`allowedFolders[${index}] must be an object`); return; }
    if (typeof item.path !== "string" || !canonicalizePath(item.path, true)) errors.push(`allowedFolders[${index}].path must be a safe absolute path`);
    if (!isChoice(item.mode, FOLDER_MODES)) errors.push(`allowedFolders[${index}].mode is invalid`);
  });
}

function validateMcp(value: unknown, errors: string[]): void {
  if (!isRecord(value)) { errors.push("mcpAccess must be an object"); return; }
  if (!isChoice(value.mode, MCP_MODES)) errors.push("mcpAccess.mode is invalid");
  if (!Array.isArray(value.servers)) { errors.push("mcpAccess.servers must be an array"); return; }
  value.servers.forEach((server, index) => {
    if (typeof server !== "string" || server.includes("\0") || !server.trim()) errors.push(`mcpAccess.servers[${index}] must be a valid identifier`);
  });
}

function validateCap(value: unknown, key: string, errors: string[]): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`${key} must be a finite nonnegative number, or null`);
}

/** Validate supplied UI fields; missing and null whole policies use safe defaults. */
export function validateBotPolicy(raw: unknown): BotPolicyValidationResult {
  if (raw === null || raw === undefined) return { ok: true, policy: defaultPolicy() };
  if (!isRecord(raw)) return { ok: false, errors: ["botPolicy must be an object"] };
  const errors: string[] = [];
  if (raw.accessLevel !== undefined && !isChoice(raw.accessLevel, ACCESS_LEVELS)) errors.push("accessLevel is invalid");
  if (raw.allowedFolders !== undefined) validateFolders(raw.allowedFolders, errors);
  for (const key of BOOLEAN_KEYS) if (raw[key] !== undefined && typeof raw[key] !== "boolean") errors.push(`${key} must be boolean`);
  if (raw.busyMessagePolicy !== undefined && !isChoice(raw.busyMessagePolicy, BUSY_POLICIES)) errors.push("busyMessagePolicy is invalid");
  if (raw.notificationLevel !== undefined && !isChoice(raw.notificationLevel, NOTIFICATIONS)) errors.push("notificationLevel is invalid");
  if (raw.mcpAccess !== undefined) validateMcp(raw.mcpAccess, errors);
  if (raw.memoryLimit !== undefined) validateCap(raw.memoryLimit, "memoryLimit", errors);
  if (raw.maxConcurrentTasks !== undefined) validateCap(raw.maxConcurrentTasks, "maxConcurrentTasks", errors);
  return errors.length ? { ok: false, errors } : { ok: true, policy: normalizeBotPolicy(raw) };
}

function containsPath(base: CanonicalPath, target: CanonicalPath): boolean {
  if (base.flavor !== target.flavor) return false;
  const api = base.flavor === "win32" ? win32 : posix;
  const relative = api.relative(base.value, target.value);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

/**
 * Checks folder grants only; callers handle accessLevel approval and resolve symlinks
 * before actual filesystem access.
 */
export function canAgentAccessFolder(policy: NormalizedBotPolicy, targetPath: string, requiredMode: FolderMode): boolean {
  if (requiredMode !== "ro" && requiredMode !== "rw") return false;
  const target = typeof targetPath === "string" ? canonicalizePath(targetPath, false) : null;
  if (!target || !Array.isArray(policy?.allowedFolders)) return false;
  return policy.allowedFolders.some((grant) => {
    if (grant.mode !== "ro" && grant.mode !== "rw") return false;
    if (requiredMode === "rw" && grant.mode !== "rw") return false;
    const base = typeof grant.path === "string" ? canonicalizePath(grant.path, true) : null;
    return base !== null && containsPath(base, target);
  });
}

/** Compare trimmed, exact MCP identifiers; blank and null-byte names always deny. */
export function isMcpServerAllowed(policy: NormalizedBotPolicy, serverId: string): boolean {
  if (typeof serverId !== "string" || serverId.includes("\0")) return false;
  const id = serverId.trim();
  if (!id || !isRecord(policy?.mcpAccess)) return false;
  const { mode, servers } = policy.mcpAccess;
  if (!isChoice(mode, MCP_MODES) || !Array.isArray(servers) || servers.some((item) => typeof item !== "string" || item.includes("\0"))) return false;
  if (mode === "denylist" && servers.some((item) => !item.trim())) return false;
  const names = new Set(servers.map((item) => item.trim()).filter(Boolean));
  if (mode === "allow_all") return true;
  return mode === "allowlist" ? names.has(id) : !names.has(id);
}
