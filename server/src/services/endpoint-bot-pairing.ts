import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { posix, win32 } from "node:path";

export type FolderGrant = { path: string; mode: "ro" | "rw" };
export type DetectedCli = string | { id: string; binary: string; path: string | null; available: boolean };
type Scope = { companyId: string; deviceId: string };
type Clock = { nowMs?: number };
export type PairingCode = {
  code: string; companyId: string; botName: string; allowedFolders: FolderGrant[];
  expiresAtMs: number; consumed: boolean;
};
export type StoredEndpoint = Scope & {
  botName: string; os: string; arch: string; detectedClis: DetectedCli[]; allowedFolders: FolderGrant[];
  tokenHash: string; tokenPreview: string; lastSeenMs: number; pendingOutboxCount: number;
};
export type LocalTaskKind = "read_file" | "write_file" | "list_dir" | "shell_exec";
export type LocalTask = Scope & {
  taskId: string; kind: LocalTaskKind; targetPath: string; command?: string; args?: string[];
  status: "pending" | "completed" | "failed"; createdAtMs: number;
  completedAtMs?: number; ok?: boolean; output?: string; error?: string;
};
/** Synchronous, single-writer storage contract; shared multi-process stores need atomic transactions. */
export interface EndpointBotPairingStore {
  getCode(code: string): PairingCode | undefined;
  putCode(code: PairingCode): void;
  getEndpoint(companyId: string, deviceId: string): StoredEndpoint | undefined;
  putEndpoint(endpoint: StoredEndpoint): void;
  listEndpoints(companyId: string): StoredEndpoint[];
  getTask(companyId: string, taskId: string): LocalTask | undefined;
  putTask(task: LocalTask): void;
  listTasks(companyId: string): LocalTask[];
}

export function createMemoryEndpointBotPairingStore(): EndpointBotPairingStore {
  const codes = new Map<string, PairingCode>();
  const endpoints = new Map<string, StoredEndpoint>();
  const tasks = new Map<string, LocalTask>();
  const key = (companyId: string, id: string) => JSON.stringify([companyId, id]);
  return {
    getCode: (code) => structuredClone(codes.get(code)),
    putCode: (code) => { codes.set(code.code, structuredClone(code)); },
    getEndpoint: (company, device) => structuredClone(endpoints.get(key(company, device))),
    putEndpoint: (endpoint) => { endpoints.set(key(endpoint.companyId, endpoint.deviceId), structuredClone(endpoint)); },
    listEndpoints: (company) => structuredClone([...endpoints.values()].filter((e) => e.companyId === company)),
    getTask: (company, task) => structuredClone(tasks.get(key(company, task))),
    putTask: (task) => { tasks.set(key(task.companyId, task.taskId), structuredClone(task)); },
    listTasks: (company) => structuredClone([...tasks.values()].filter((t) => t.companyId === company)),
  };
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("non-empty string required");
}
function now(input: Clock): number {
  const value = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid timestamp");
  return value;
}
function clis(value: DetectedCli[]): DetectedCli[] {
  if (!Array.isArray(value)) throw new Error("invalid detectedClis");
  for (const cli of value) {
    if (typeof cli === "string") text(cli);
    else {
      if (!cli || typeof cli.available !== "boolean") throw new Error("invalid detectedCli");
      text(cli.id); text(cli.binary); if (cli.path !== null) text(cli.path);
    }
  }
  return structuredClone(value);
}
/** Lexical policy only. The endpoint must recheck real paths/symlinks and confine shell execution locally. */
function canonicalPath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("invalid path");
  if (value.split(/[\\/]/).includes("..")) throw new Error("path traversal forbidden");
  if (/^[a-z]:[\\/]/i.test(value)) {
    const segments = value.slice(3).split(/[\\/]/);
    if (segments.some((s) => /[:<>"|?*]|[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s))) {
      throw new Error("unsafe Windows path");
    }
    return win32.normalize(value).replaceAll("\\", "/").toLowerCase().replace(/([^:])\/$/, "$1");
  }
  if (!posix.isAbsolute(value) || value.includes("\\") || value.startsWith("//")) throw new Error("absolute local path required");
  return posix.normalize(value).replace(/(.)\/$/, "$1");
}
function view(endpoint: StoredEndpoint, at: number) {
  const { tokenHash: _secret, ...publicFields } = endpoint;
  return { ...structuredClone(publicFields), online: at - endpoint.lastSeenMs <= 60_000 };
}

export function createEndpointBotPairingService(store: EndpointBotPairingStore = createMemoryEndpointBotPairingStore()) {
  function endpoint(scope: Scope): StoredEndpoint {
    const found = store.getEndpoint(scope.companyId, scope.deviceId);
    if (!found || found.companyId !== scope.companyId || found.deviceId !== scope.deviceId) throw new Error("endpoint not found");
    return found;
  }
  return {
    issuePairingCode(input: { companyId: string; botName: string; requestedFolders: FolderGrant[]; ttlMs?: number } & Clock) {
      text(input.companyId); text(input.botName);
      const at = now(input), ttl = input.ttlMs ?? 600_000;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(at + ttl)) throw new Error("invalid TTL");
      if (!Array.isArray(input.requestedFolders)) throw new Error("invalid folders");
      const allowedFolders = input.requestedFolders.map((folder) => {
        if (!folder || (folder.mode !== "ro" && folder.mode !== "rw")) throw new Error("invalid folder mode");
        return { path: canonicalPath(folder.path), mode: folder.mode };
      });
      let code: string;
      do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); } while (store.getCode(code));
      const expiresAtMs = at + ttl;
      store.putCode({ code, companyId: input.companyId, botName: input.botName, allowedFolders, expiresAtMs, consumed: false });
      return { code, expiresAtMs };
    },
    completePairing(input: { code: string; os: string; arch: string; detectedClis: DetectedCli[] } & Clock) {
      const at = now(input), pairing = store.getCode(input.code);
      if (!pairing || pairing.consumed || at >= pairing.expiresAtMs) throw new Error("invalid or expired pairing code");
      text(input.os); text(input.arch);
      const detectedClis = clis(input.detectedClis);
      const deviceId = randomUUID(), deviceToken = randomBytes(32).toString("base64url"), tokenHash = hash(deviceToken);
      const tokenPreview = `sha256:${tokenHash.slice(0, 8)}`;
      const { botName, companyId, allowedFolders } = pairing;
      store.putCode({ ...pairing, consumed: true });
      store.putEndpoint({ companyId, deviceId, botName, allowedFolders: structuredClone(allowedFolders),
        os: input.os, arch: input.arch, detectedClis, tokenHash, tokenPreview, lastSeenMs: at, pendingOutboxCount: 0 });
      return { deviceId, botName, companyId, deviceToken, tokenPreview };
    },
    verifyDeviceToken(input: Scope & { token: string }): boolean {
      const found = store.getEndpoint(input.companyId, input.deviceId);
      const expected = Buffer.from(found?.tokenHash ?? "0".repeat(64), "hex");
      const matches = timingSafeEqual(expected, Buffer.from(hash(input.token), "hex"));
      return !!found && found.companyId === input.companyId && found.deviceId === input.deviceId && matches;
    },
    recordHeartbeat(input: Scope & { detectedClis: DetectedCli[]; pendingOutboxCount: number } & Clock) {
      const found = endpoint(input), at = now(input);
      if (!Number.isSafeInteger(input.pendingOutboxCount) || input.pendingOutboxCount < 0) throw new Error("invalid outbox count");
      const updated = { ...found, detectedClis: clis(input.detectedClis), pendingOutboxCount: input.pendingOutboxCount, lastSeenMs: at };
      store.putEndpoint(updated);
      return view(updated, at);
    },
    listEndpoints(companyId: string, nowMs?: number) {
      text(companyId);
      const at = now({ nowMs });
      return store.listEndpoints(companyId).filter((e) => e.companyId === companyId).map((e) => view(e, at));
    },
    enqueueLocalTask(input: Scope & { kind: LocalTaskKind; targetPath: string; command?: string; args?: string[] } & Clock): LocalTask {
      const found = endpoint(input), at = now(input), target = canonicalPath(input.targetPath);
      if (!["read_file", "write_file", "list_dir", "shell_exec"].includes(input.kind)) throw new Error("invalid task kind");
      const grants = found.allowedFolders.filter((folder) => {
        const root = canonicalPath(folder.path);
        return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);
      });
      const mutating = input.kind === "write_file" || input.kind === "shell_exec";
      if (!grants.length || grants.some((f) => f.mode !== "rw" && (mutating || f.mode !== "ro"))) throw new Error("folder policy denied");
      if (input.kind === "shell_exec") text(input.command);
      if (input.command !== undefined) text(input.command);
      if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((a) => typeof a !== "string" || a.includes("\0")))) {
        throw new Error("invalid task args");
      }
      const task: LocalTask = { companyId: input.companyId, deviceId: input.deviceId, taskId: randomUUID(), kind: input.kind,
        targetPath: input.targetPath, command: input.command, args: input.args && [...input.args], status: "pending", createdAtMs: at };
      store.putTask(task);
      return structuredClone(task);
    },
    /** At-least-once delivery: pending tasks remain visible until ack; callers deduplicate by taskId. */
    pollPendingTasks(input: Scope & { limit?: number }): LocalTask[] {
      endpoint(input);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid limit");
      return structuredClone(store.listTasks(input.companyId)
        .filter((t) => t.companyId === input.companyId && t.deviceId === input.deviceId && t.status === "pending")
        .sort((a, b) => a.createdAtMs - b.createdAtMs).slice(0, limit));
    },
    ackTaskResult(input: Scope & { taskId: string; ok: boolean; output?: string; error?: string } & Clock): LocalTask {
      endpoint(input);
      const task = store.getTask(input.companyId, input.taskId), at = now(input);
      if (!task || task.companyId !== input.companyId || task.deviceId !== input.deviceId) throw new Error("task not found");
      if (typeof input.ok !== "boolean" || (input.output !== undefined && typeof input.output !== "string")
        || (input.error !== undefined && typeof input.error !== "string")) throw new Error("invalid task result");
      if (task.status !== "pending") return structuredClone(task);
      const result: LocalTask = { ...task, status: input.ok ? "completed" : "failed", ok: input.ok,
        output: input.output, error: input.error, completedAtMs: at };
      store.putTask(result);
      return structuredClone(result);
    },
  };
}

export type EndpointBotPairingService = ReturnType<typeof createEndpointBotPairingService>;
export const globalEndpointBotPairingStore = createEndpointBotPairingService();
export const { issuePairingCode, completePairing, verifyDeviceToken, recordHeartbeat, listEndpoints,
  enqueueLocalTask, pollPendingTasks, ackTaskResult } = globalEndpointBotPairingStore;
