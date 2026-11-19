/**
 * Hermit Gate + Ops Console 검증 (r60 시나리오 5종 + 큐/텔레메트리 안전).
 *  1. 경로 겹침·동시 클레임 직렬화  2. 커밋 전 변경/이름변경/딥 import 검증
 *  3. 25-PR 누적 감사 경합·멱등성  4. 중대 결정 원장·상태 재로드
 *  5. 텔레메트리 안전(보호 PID 거부·임계치 클램프) + 큐 뷰 로직(DB)
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { createHermitGateService, normalizeRepoPath, pathsOverlap } from "../services/hermit-gate.js";
import {
  buildPromptPreview,
  operatorQueueViewService,
  QUEUED_WAKEUP_STATUSES,
} from "../services/operator-queue-view.js";
import { opsConsoleTelemetryService } from "../services/ops-console-telemetry.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("hermit gate — paths", () => {
  it("normalizes repo paths and detects ancestor/descendant overlap", () => {
    expect(normalizeRepoPath("/server//src/")).toBe("server/src");
    expect(normalizeRepoPath("./server/src")).toBe("server/src");
    expect(normalizeRepoPath("a/./b")).toBe("a/b");
    expect(() => normalizeRepoPath("/")).toThrow();
    expect(() => normalizeRepoPath("//./")).toThrow();
    expect(() => normalizeRepoPath("../etc/passwd")).toThrow();
    expect(pathsOverlap("server/src", "server/src/routes/worktree.ts")).toBe(true);
    expect(pathsOverlap("server/src/routes/worktree.ts", "server/src")).toBe(true);
    expect(pathsOverlap("ui/src", "server/src")).toBe(false);
  });
});

describe("r60 scenario 1 — overlap & claim serialization", () => {
  it("grants exactly one of two overlapping concurrent claims; disjoint task proceeds", async () => {
    const dir = tempDir("hg-overlap-");
    const gate = createHermitGateService({ stateDir: dir });
    const results = await Promise.all([
      gate.claimPaths("co-1", { taskId: "A", worktreeName: "wt-a", paths: ["server/src/routes"] }),
      gate.claimPaths("co-1", { taskId: "B", worktreeName: "wt-b", paths: ["server/src/routes/worktree.ts"] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const held = results.find((r) => !r.ok)!;
    expect(held.verdict).toBe("hold_action");
    expect(held.conflicts.every((c) => c.kind === "overlap")).toBe(true);
    expect(held.resumeCondition).toContain("선행 task");
    const disjoint = await gate.claimPaths("co-1", { taskId: "C", worktreeName: "wt-c", paths: ["ui/src/pages"] });
    expect(disjoint.ok).toBe(true);
    const state = await gate.getState("co-1");
    expect(state.claims.map((c) => c.taskId).sort()).toEqual(["A", "C"].sort());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("r60 scenario 2 — pre-commit change verification", () => {
  it("catches out-of-scope paths, renames, and deep internal imports; clean changes proceed", async () => {
    const dir = tempDir("hg-verify-");
    const gate = createHermitGateService({ stateDir: dir });
    await gate.claimPaths("co-2", { taskId: "T", worktreeName: "wt", paths: ["server/src/services"] });
    const verdict = await gate.verifyChanges("co-2", {
      taskId: "T",
      mode: "commit",
      changes: [
        { path: "ui/src/pages/home.tsx" },
        { path: "server/src/services/new.ts", previousPath: "crates/legacy.rs" },
        { path: "server/src/services/x.ts", addedImports: ["@paperclipai/db/src/internal/secret"] },
      ],
    });
    expect(verdict.decision).toBe("hold_action");
    expect(verdict.resumeCondition).toBeTruthy();
    expect(verdict.violations.map((v) => v.kind).sort()).toEqual([
      "internal_deep_import",
      "out_of_scope",
      "rename_out_of_scope",
    ]);
    const clean = await gate.verifyChanges("co-2", {
      taskId: "T",
      mode: "pr",
      changes: [{ path: "server/src/services/hermit-gate.ts", addedImports: ["zod"] }],
    });
    expect(clean.decision).toBe("proceed");
    expect(clean.violations).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("r60 scenario 3 — 25-PR cumulative merge audit", () => {
  it("triggers the audit exactly once under a duplicate replay race and preserves audit-window merges", async () => {
    const dir = tempDir("hg-audit-");
    const gate = createHermitGateService({ stateDir: dir });
    for (let i = 1; i <= 24; i += 1) {
      await gate.recordMergedPr("co-3", { prNumber: i, mergeSha: `sha-${i}`, changedPaths: [`p/${i}`] });
    }
    expect((await gate.getState("co-3")).auditState.auditActive).toBe(false);
    const [a, b] = await Promise.all([
      gate.recordMergedPr("co-3", { prNumber: 25, mergeSha: "sha-25", changedPaths: ["p/25"] }),
      gate.recordMergedPr("co-3", { prNumber: 25, mergeSha: "sha-25", changedPaths: ["p/25"] }),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    const after = (await gate.getState("co-3")).auditState;
    expect(after.auditActive).toBe(true);
    expect(after.mergedPrsSinceAudit).toHaveLength(25);
    expect((await gate.checkMergeGate("co-3", { changedPaths: ["ui/src/x"] })).decision).toBe("hold_action");
    await gate.setAuditScope("co-3", ["crates/"]);
    expect((await gate.checkMergeGate("co-3", { changedPaths: ["ui/src/x"] })).decision).toBe("proceed");
    expect((await gate.checkMergeGate("co-3", { changedPaths: ["crates/run-log/src/lib.rs"] })).decision).toBe("hold_action");
    expect(
      (await gate.checkMergeGate("co-3", { changedPaths: ["crates/run-log/src/lib.rs"], isAuditFix: true })).decision,
    ).toBe("proceed");
    await gate.recordMergedPr("co-3", { prNumber: 26, mergeSha: "sha-26", changedPaths: ["p/26"] });
    await expect(gate.completeAudit("co-3", "nonexistent-sha")).rejects.toThrow(/감사 기준 커밋/);
    expect((await gate.getState("co-3")).auditState.mergedPrsSinceAudit).toHaveLength(26);
    const completed = await gate.completeAudit("co-3", "sha-25");
    expect(completed.lastAuditMergeSha).toBe("sha-25");
    expect(completed.auditActive).toBe(false);
    expect(completed.mergedPrsSinceAudit.map((e) => e.prNumber)).toEqual([26]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("r60 scenario 4 — consequential decision ledger", () => {
  it("records the 4 required fields, appends updates, and survives a state reload", async () => {
    const dir = tempDir("hg-decide-");
    const gate = createHermitGateService({ stateDir: dir });
    const decision = await gate.recordDecision("co-4", {
      taskId: "T2",
      decision: "DB 마이그레이션 도입",
      rationaleAndAssumption: "쓰기 병목 가설 — 근거: 대기열 지표",
      impact: "스키마 호환성 영향",
      whereToChange: "packages/db/src/schema",
    });
    expect(decision.id).toBeTruthy();
    const updated = await gate.updateDecision("co-4", decision.id, "가설 일부 수정");
    expect(updated?.updatedReason).toBe("가설 일부 수정");
    expect(updated?.updatedAt).toBeTruthy();
    const reloaded = createHermitGateService({ stateDir: dir });
    const decisions = await reloaded.listDecisions("co-4");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: decision.id,
      decision: "DB 마이그레이션 도입",
      rationaleAndAssumption: "쓰기 병목 가설 — 근거: 대기열 지표",
      impact: "스키마 호환성 영향",
      whereToChange: "packages/db/src/schema",
      updatedReason: "가설 일부 수정",
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("r60 scenario 5a — ops console telemetry safety & gate TTL/audit hardening", () => {
  const dir = tempDir("hg-tel-");
  const gate = createHermitGateService({ stateDir: dir });
  const telemetry = opsConsoleTelemetryService({} as unknown as Db, gate);

  it("rejects stopping pid 1 and the server's own pid", async () => {
    expect((await telemetry.stopBackgroundProcess("co-5", 1)).ok).toBe(false);
    expect((await telemetry.stopBackgroundProcess("co-5", process.pid)).ok).toBe(false);
  });

  it("rejects sentinel 'audit-head' or empty-window completeAudit and prunes expired TTL claims", async () => {
    await expect(gate.completeAudit("co-empty", "audit-head")).rejects.toThrow();
    await expect(gate.completeAudit("co-empty", "deadbeef")).rejects.toThrow(/누적 병합/);

    const claimed = await gate.claimPaths("co-ttl", {
      taskId: "stale-task",
      worktreeName: "wt-stale",
      paths: ["ui/src/pages"],
      ttlMinutes: 1,
    });
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(claimed.claim.expiresAt).toBeTruthy();

    const stateFile = path.join(dir, "hermit-gate-co-ttl.json");
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as { claims: Array<{ expiresAt?: string }> };
    parsed.claims[0].expiresAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(stateFile, JSON.stringify(parsed, null, 2), "utf8");

    const fresh = await gate.claimPaths("co-ttl", {
      taskId: "fresh-task",
      worktreeName: "wt-fresh",
      paths: ["ui/src/pages/Dashboard.tsx"],
    });
    expect(fresh.ok).toBe(true);
    expect((await gate.getState("co-ttl")).claims.map((c) => c.taskId)).toEqual(["fresh-task"]);
  });

  it("clamps thresholds to [10, 99] and snapshots reflect them", async () => {
    const saved = await telemetry.updateThresholds("co-5", { cpuPct: 5, memPct: 150, diskPct: 42.6 });
    expect(saved).toEqual({ cpuPct: 10, memPct: 99, diskPct: 43 });
    const snapshot = await telemetry.getResourceSnapshot("co-5");
    expect(snapshot.thresholds).toEqual(saved);
    expect(snapshot.cpuPct).toBeGreaterThanOrEqual(0);
    expect(snapshot.cpuPct).toBeLessThanOrEqual(100);
  });

  it("validates operator-queue-view exports and prompt preview logic", () => {
    expect(typeof operatorQueueViewService).toBe("function");
    expect(QUEUED_WAKEUP_STATUSES).toEqual(["queued", "held_fanout"]);
    expect(buildPromptPreview({ prompt: "x".repeat(400) }, null)).toHaveLength(300);
    expect(buildPromptPreview({ message: "m" }, "r")).toBe("m");
    expect(buildPromptPreview(null, "reason")).toBe("reason");
    expect(buildPromptPreview({}, undefined)).toBe("");
  });

  it("queue/telemetry sources never write run-status tables (chokepoint mirror)", () => {
    const sources = ["../services/operator-queue-view.ts", "../services/ops-console-telemetry.ts"].map((rel) =>
      readFileSync(new URL(`${rel}`, import.meta.url), "utf8"),
    );
    for (const src of sources) {
      expect(src).not.toMatch(/\.update\(\s*(schema\.)?heartbeatRuns/);
      expect(src).not.toMatch(/\.update\(\s*(schema\.)?workflowRuns/);
      expect(src).not.toMatch(/\bupdate\s+(heartbeat_runs|workflow_runs)\b/i);
    }
  });
});

describeDb("r60 scenario 5b — operator queue view & process tenant isolation (db)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let otherCompanyId = "";
  let agentId = "";
  let queue: ReturnType<typeof operatorQueueViewService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hermit-queue-");
    db = createDb(tempDb.connectionString);
    queue = operatorQueueViewService(db);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: `HG Co ${companyId.slice(0, 8)}`,
        issuePrefix: `HG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        timezone: "UTC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: `HG Other ${otherCompanyId.slice(0, 8)}`,
        issuePrefix: `HO${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        timezone: "UTC",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "hermit-agent" });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWakeup(payload: Record<string, unknown> | null, status: string): Promise<string> {
    const [row] = await db
      .insert(agentWakeupRequests)
      .values({ companyId, agentId, source: "test", reason: "seed reason", payload, status })
      .returning({ id: agentWakeupRequests.id });
    return row.id;
  }

  it("lists, reorders, edits, and cancels queued wakeups safely across malformed queueOrder", async () => {
    const legacy = await seedWakeup({ prompt: "legacy" }, "queued");
    const badOrder = await seedWakeup({ prompt: "bad-order", queueOrder: "high" }, "queued");
    const second = await seedWakeup({ prompt: "second", queueOrder: 2 }, "queued");
    const first = await seedWakeup({ prompt: "first", queueOrder: 1 }, "held_fanout");
    const completed = await seedWakeup({ prompt: "done" }, "completed");

    let items = await queue.listCompanyQueue(companyId);
    expect(items.map((i) => i.promptPreview)).toEqual(["first", "second", "legacy", "bad-order"]);

    // Partial orderedIds rewrites all active company rows sequentially (no stale queueOrder collision).
    items = await queue.reorderQueue(companyId, [legacy, second]);
    expect(items.map((i) => i.queueOrder)).toEqual([1, 2, 3, 4]);
    expect(items.slice(0, 2).map((i) => i.id)).toEqual([legacy, second]);

    const edited = await queue.editQueuedWakeup(companyId, second, { prompt: "  edited prompt  " });
    expect(edited.promptPreview).toBe("edited prompt");
    await expect(queue.editQueuedWakeup(companyId, completed, { prompt: "nope" })).rejects.toThrow();

    expect(await queue.cancelQueuedWakeup(companyId, first)).toBe(true);
    expect(await queue.cancelQueuedWakeup(companyId, first)).toBe(false);
    expect(await queue.cancelQueuedWakeup(companyId, badOrder)).toBe(true);
    const remaining = (await queue.listCompanyQueue(companyId)).map((i) => i.id).sort();
    expect(remaining).toEqual([legacy, second].sort());
  });

  it("rejects stopping a PID owned by another company", async () => {
    const fakeChildPid = 424242;
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      processPid: fakeChildPid,
    });
    const gate = createHermitGateService({ stateDir: tempDir("hg-tenant-") });
    const telemetry = opsConsoleTelemetryService(db, gate);
    const denied = await telemetry.stopBackgroundProcess(otherCompanyId, fakeChildPid);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("소유 프로세스가 아닙니다");
    expect(await telemetry.listBackgroundProcesses(otherCompanyId)).toEqual([]);
  });
});
