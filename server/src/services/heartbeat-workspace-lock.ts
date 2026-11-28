export type WorkspaceAccessMode = "read" | "write";

export interface WorkspaceLockLease {
  runId: string;
  workspacePath: string;
  mode: WorkspaceAccessMode;
  acquiredAtMs: number;
  expiresAtMs: number;
}

export function normalizeWorkspaceLockPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return "";
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/g, "");
}

function copyLease(lease: WorkspaceLockLease): WorkspaceLockLease {
  return { ...lease };
}

export class WorkspaceLockArbiter {
  private readonly defaultTtlMs: number;
  private readonly leasesByPath = new Map<string, Map<string, WorkspaceLockLease>>();

  constructor(opts: { defaultTtlMs?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 600_000;
  }

  pruneExpired(nowMs = Date.now()): number {
    let pruned = 0;
    for (const [workspacePath, leases] of this.leasesByPath) {
      for (const [runId, lease] of leases) {
        if (lease.expiresAtMs <= nowMs) {
          leases.delete(runId);
          pruned += 1;
        }
      }
      if (leases.size === 0) this.leasesByPath.delete(workspacePath);
    }
    return pruned;
  }

  tryAcquire(input: {
    runId: string;
    workspacePath: string;
    mode: WorkspaceAccessMode;
    nowMs?: number;
    ttlMs?: number;
  }): { acquired: true; lease: WorkspaceLockLease } | { acquired: false; conflictingRunIds: string[] } {
    const nowMs = input.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    const workspacePath = normalizeWorkspaceLockPath(input.workspacePath);
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const existingLeases = this.leasesByPath.get(workspacePath);
    const conflictingRunIds = new Set<string>();

    if (existingLeases) {
      for (const lease of existingLeases.values()) {
        if (lease.runId === input.runId) continue;
        if (input.mode === "write" || lease.mode === "write") {
          conflictingRunIds.add(lease.runId);
        }
      }
    }

    if (conflictingRunIds.size > 0) {
      return { acquired: false, conflictingRunIds: [...conflictingRunIds].sort() };
    }

    let pathLeases = existingLeases;
    if (!pathLeases) {
      pathLeases = new Map<string, WorkspaceLockLease>();
      this.leasesByPath.set(workspacePath, pathLeases);
    }

    const existing = pathLeases.get(input.runId);
    if (existing) {
      existing.mode = existing.mode === "write" || input.mode === "write" ? "write" : "read";
      existing.expiresAtMs = nowMs + ttlMs;
      return { acquired: true, lease: copyLease(existing) };
    }

    const lease: WorkspaceLockLease = {
      runId: input.runId,
      workspacePath,
      mode: input.mode,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
    pathLeases.set(input.runId, lease);
    return { acquired: true, lease: copyLease(lease) };
  }

  release(runId: string): number {
    let released = 0;
    for (const [workspacePath, leases] of this.leasesByPath) {
      if (leases.delete(runId)) released += 1;
      if (leases.size === 0) this.leasesByPath.delete(workspacePath);
    }
    return released;
  }

  listActiveLeases(workspacePath?: string, nowMs = Date.now()): WorkspaceLockLease[] {
    this.pruneExpired(nowMs);
    const active: WorkspaceLockLease[] = [];

    if (workspacePath !== undefined) {
      const normalizedPath = normalizeWorkspaceLockPath(workspacePath);
      const leases = this.leasesByPath.get(normalizedPath);
      if (leases) {
        for (const lease of leases.values()) active.push(lease);
      }
    } else {
      for (const leases of this.leasesByPath.values()) {
        for (const lease of leases.values()) active.push(lease);
      }
    }

    return active
      .sort((left, right) => {
        if (left.workspacePath !== right.workspacePath) return left.workspacePath < right.workspacePath ? -1 : 1;
        if (left.runId !== right.runId) return left.runId < right.runId ? -1 : 1;
        return 0;
      })
      .map(copyLease);
  }
}
