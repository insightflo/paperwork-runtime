import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceLockPath,
  WorkspaceLockArbiter,
} from "../services/heartbeat-workspace-lock.js";

describe("normalizeWorkspaceLockPath", () => {
  it("trims whitespace, collapses duplicate slashes, and removes trailing slashes", () => {
    expect(normalizeWorkspaceLockPath("  /tmp//paperwork///workspace/  ")).toBe("/tmp/paperwork/workspace");
    expect(normalizeWorkspaceLockPath("relative//path/")).toBe("relative/path");
  });

  it("preserves the root path", () => {
    expect(normalizeWorkspaceLockPath("/")).toBe("/");
    expect(normalizeWorkspaceLockPath("  ////  ")).toBe("/");
  });
});

describe("WorkspaceLockArbiter", () => {
  it("allows concurrent readers on the same normalized path", () => {
    const arbiter = new WorkspaceLockArbiter();
    const first = arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo//", mode: "read", nowMs: 100 });
    const second = arbiter.tryAcquire({ runId: "run-b", workspacePath: "/repo", mode: "read", nowMs: 110 });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(arbiter.listActiveLeases("/repo/", 120)).toHaveLength(2);
  });

  it("blocks a writer when another run holds a read or write lease", () => {
    const arbiter = new WorkspaceLockArbiter();
    arbiter.tryAcquire({ runId: "reader", workspacePath: "/repo", mode: "read", nowMs: 100 });

    const blockedByReader = arbiter.tryAcquire({ runId: "writer", workspacePath: "/repo", mode: "write", nowMs: 110 });
    expect(blockedByReader).toEqual({ acquired: false, conflictingRunIds: ["reader"] });

    arbiter.release("reader");
    expect(arbiter.tryAcquire({ runId: "writer", workspacePath: "/repo", mode: "write", nowMs: 120 }).acquired).toBe(true);

    const blockedByWriter = arbiter.tryAcquire({ runId: "other-writer", workspacePath: "/repo", mode: "write", nowMs: 130 });
    expect(blockedByWriter).toEqual({ acquired: false, conflictingRunIds: ["writer"] });
  });

  it("blocks a reader when another run holds a write lease", () => {
    const arbiter = new WorkspaceLockArbiter();
    arbiter.tryAcquire({ runId: "writer", workspacePath: "/repo", mode: "write", nowMs: 100 });

    const result = arbiter.tryAcquire({ runId: "reader", workspacePath: "/repo/", mode: "read", nowMs: 110 });

    expect(result).toEqual({ acquired: false, conflictingRunIds: ["writer"] });
  });

  it("allows independent paths in parallel", () => {
    const arbiter = new WorkspaceLockArbiter();
    const first = arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo-a", mode: "write", nowMs: 100 });
    const second = arbiter.tryAcquire({ runId: "run-b", workspacePath: "/repo-b", mode: "write", nowMs: 100 });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(arbiter.listActiveLeases(undefined, 110)).toHaveLength(2);
  });

  it("refreshes same-run leases and upgrades read mode to write mode", () => {
    const arbiter = new WorkspaceLockArbiter();
    const initial = arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo", mode: "read", nowMs: 100, ttlMs: 50 });
    const refreshed = arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo", mode: "write", nowMs: 120, ttlMs: 80 });

    expect(initial.acquired && initial.lease.mode).toBe("read");
    expect(refreshed.acquired).toBe(true);
    if (refreshed.acquired) {
      expect(refreshed.lease.mode).toBe("write");
      expect(refreshed.lease.acquiredAtMs).toBe(100);
      expect(refreshed.lease.expiresAtMs).toBe(200);
    }
    expect(arbiter.listActiveLeases("/repo", 121)).toHaveLength(1);
  });

  it("keeps write mode when the same run re-acquires as a reader", () => {
    const arbiter = new WorkspaceLockArbiter();
    arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo", mode: "write", nowMs: 100, ttlMs: 50 });
    const refreshed = arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo", mode: "read", nowMs: 110, ttlMs: 50 });

    expect(refreshed.acquired).toBe(true);
    if (refreshed.acquired) expect(refreshed.lease.mode).toBe("write");
  });

  it("releases all leases held by a run", () => {
    const arbiter = new WorkspaceLockArbiter();
    arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo-a", mode: "write", nowMs: 100 });
    arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo-b", mode: "read", nowMs: 100 });
    arbiter.tryAcquire({ runId: "run-b", workspacePath: "/repo-c", mode: "write", nowMs: 100 });

    expect(arbiter.release("run-a")).toBe(2);
    expect(arbiter.listActiveLeases(undefined, 101)).toHaveLength(1);
    expect(arbiter.release("run-a")).toBe(0);
  });

  it("expires leases using their ttl and prunes them deterministically", () => {
    const arbiter = new WorkspaceLockArbiter({ defaultTtlMs: 100 });
    arbiter.tryAcquire({ runId: "run-a", workspacePath: "/repo-a", mode: "write", nowMs: 100 });
    arbiter.tryAcquire({ runId: "run-b", workspacePath: "/repo-b", mode: "read", nowMs: 150, ttlMs: 50 });

    expect(arbiter.pruneExpired(199)).toBe(0);
    expect(arbiter.pruneExpired(200)).toBe(2);

    const acquired = arbiter.tryAcquire({ runId: "run-c", workspacePath: "/repo-a", mode: "write", nowMs: 200 });
    expect(acquired.acquired).toBe(true);
  });
});
