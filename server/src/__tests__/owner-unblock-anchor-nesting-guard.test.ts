import { companies, createDb, issues, missions, workflowRuns, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { anchors, seedAnchors, sourceRun, unblockWorld, type UnblockWorld } from "./helpers/unblock-nesting-fixture.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { createRequestChangesOwnerAction } from "../services/heartbeat-request-changes-owner-action.js";
import { isIneligibleUnblockSourceIssue, MAX_SOURCE_ANCHORS } from "../services/missions/unblock-source-eligibility.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

describe("unblock source guards across both producers", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("s41-unblock-guard-");
    db = createDb(database.connectionString); other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 }); await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });
  const owner = (w: UnblockWorld, connection = db) => createOwnerActions({ db: connection, deps: {} })
    .ensureMainExecutorUnblockIssue(w.mission, w.source);
  const request = (w: UnblockWorld, wake = vi.fn(async () => {}), connection = db) =>
    createRequestChangesOwnerAction({ db: connection, enqueueWakeup: wake })({
      sourceIssue: w.source, run: w.heartbeat, verdict: { excerpt: "REQUEST_CHANGES" },
    });

  it.each([
    ["manual", "[Unblock] QA source"], ["manual", "  [uNbLoCk] QA source"],
    ["manual", " [pLaN] QA source"], ["mission_main_executor_plan", "QA source"],
    ["mission_main_executor_unblock", "QA source"], ["mission_main_executor_oversight", "QA source"],
  ])("blocks origin=%s title=%s without writes or wakes", async (originKind, title) => {
    const w = await unblockWorld(db, { originKind, title }), wake = vi.fn(async () => {});
    expect(isIneligibleUnblockSourceIssue(w.source)).toBe(true);
    await expect(owner(w)).rejects.toMatchObject({ status: 409, details: { reason: "owner_unblock_source_ineligible" } });
    expect(await request(w, wake)).toBeNull();
    expect(await anchors(db, w)).toHaveLength(0); expect(wake).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, w.source.id)))[0]).toEqual(w.source);
  });

  it.each(["completed", "cancelled"])("rejects new anchors for a %s run and reuses history", async (status) => {
    const w = await unblockWorld(db), wake = vi.fn(async () => {});
    await sourceRun(db, w, status);
    await expect(owner(w)).rejects.toMatchObject({ status: 409, details: { reason: "owner_unblock_source_run_ineligible" } });
    expect(await request(w, wake)).toBeNull(); expect(await anchors(db, w)).toHaveLength(0);
    const previous = await seedAnchors(db, w, 2);
    expect((await owner(w)).id).toBe(previous[1]!.id);
    expect(await request(w, wake)).toBeNull(); expect(wake).not.toHaveBeenCalled();
    expect(await anchors(db, w)).toHaveLength(2);
  });

  it.each(["pending", "running", "failed", "completed"])("skips a failed run superseded by a newer %s run", async (status) => {
    const w = await unblockWorld(db), run = await sourceRun(db, w, "failed"), wake = vi.fn(async () => {});
    await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId,
      workflowId: w.definition.id, status, triggeredBy: "test", createdAt: new Date(run.createdAt.getTime() + 1) });
    await expect(owner(w)).rejects.toMatchObject({ details: { reason: "owner_unblock_source_run_ineligible" } });
    expect(await request(w, wake)).toBeNull(); expect(wake).not.toHaveBeenCalled();
    expect(await anchors(db, w)).toHaveLength(0);
  });

  it.each(["owner", "heartbeat"])("keeps latest failed run recoverable via %s (newer cancelled / equal-time runs do not supersede)", async (producer) => {
    const w = await unblockWorld(db), run = await sourceRun(db, w, "failed");
    await db.insert(workflowRuns).values([
      { companyId: w.companyId, missionId: w.missionId, workflowId: w.definition.id,
        status: "running", triggeredBy: "test", createdAt: run.createdAt },
      { companyId: w.companyId, missionId: w.missionId, workflowId: w.definition.id,
        status: "cancelled", triggeredBy: "test", createdAt: new Date(run.createdAt.getTime() + 1) },
    ]);
    const result = producer === "owner" ? await owner(w) : await request(w);
    expect(result).toMatchObject({ originId: w.source.id, status: "todo" });
    expect(await anchors(db, w)).toHaveLength(1);
  });

  it("uses database timestamp precision to reject even a one-microsecond-newer replacement", async () => {
    const w = await unblockWorld(db), run = await sourceRun(db, w, "failed");
    const [newer] = await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId,
      workflowId: w.definition.id, status: "running", triggeredBy: "test", createdAt: run.createdAt }).returning();
    await db.update(workflowRuns).set({ createdAt: sql`${workflowRuns.createdAt} + interval '1 microsecond'` })
      .where(eq(workflowRuns.id, newer!.id));
    await expect(owner(w)).rejects.toMatchObject({ details: { reason: "owner_unblock_source_run_ineligible" } });
    expect(await request(w)).toBeNull(); expect(await anchors(db, w)).toHaveLength(0);
  });

  it("ignores newer runs outside the source mission or company", async () => {
    const w = await unblockWorld(db), foreign = await unblockWorld(db);
    await sourceRun(db, w, "failed");
    const [otherMission] = await db.insert(missions).values({ companyId: w.companyId, ownerAgentId: w.agentId,
      title: "Other mission" }).returning();
    await db.insert(workflowRuns).values([
      { companyId: foreign.companyId, missionId: foreign.missionId, workflowId: foreign.definition.id, triggeredBy: "test" },
      { companyId: w.companyId, missionId: otherMission!.id, workflowId: w.definition.id, triggeredBy: "test" },
    ]);
    expect(await request(w)).toMatchObject({ originId: w.source.id });
  });

  it("preserves legacy plugin source run IDs", async () => {
    const w = await unblockWorld(db, { originRunId: "legacy-plugin-run" });
    expect(await request(w)).toMatchObject({ originId: w.source.id });
  });

  it("rechecks the stored source instead of trusting an eligible heartbeat snapshot", async () => {
    const w = await unblockWorld(db), wake = vi.fn(async () => {});
    await db.update(issues).set({ title: "[PLAN] QA source" }).where(eq(issues.id, w.source.id));
    expect(await request(w, wake)).toBeNull();
    await expect(owner(w)).rejects.toMatchObject({ details: { reason: "owner_unblock_source_ineligible" } });
    expect(wake).not.toHaveBeenCalled(); expect(await anchors(db, w)).toHaveLength(0);
  });

  it("caps repeated heartbeat creation including done/cancelled anchors and never wakes capped history", async () => {
    const w = await unblockWorld(db), wake = vi.fn(async () => {});
    let latest: string | null = null;
    for (let round = 0; round < MAX_SOURCE_ANCHORS + 3; round++) {
      const action = await request(w, wake);
      expect(action).not.toBeNull();
      if (round < MAX_SOURCE_ANCHORS) {
        expect(action!.id).not.toBe(latest); latest = action!.id;
        await db.update(issues).set({ status: round % 2 ? "done" : "cancelled" }).where(eq(issues.id, latest!));
      } else expect(action!.id).toBe(latest);
    }
    expect(await anchors(db, w)).toHaveLength(5); expect(wake).toHaveBeenCalledTimes(5);
  });

  it("does not count hidden history against the visible cap", async () => {
    const w = await unblockWorld(db), old = await seedAnchors(db, w, 5);
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, old[0]!.id));
    expect(await request(w)).toMatchObject({ status: "todo" });
    expect((await anchors(db, w)).filter((row) => !row.hiddenAt)).toHaveLength(5);
  });

  it("serializes concurrent heartbeat and canonical producers at the shared cap", async () => {
    const w = await unblockWorld(db); await seedAnchors(db, w, 4);
    const [a, b, c] = await Promise.all([request(w), owner(w, other), request(w, vi.fn(async () => {}), other)]);
    expect(a!.id).toBe(b.id); expect(c!.id).toBe(b.id);
    expect(await anchors(db, w)).toHaveLength(5);
  });

  it("rolls back heartbeat creation and the company counter without waking on write failure", async () => {
    const w = await unblockWorld(db), wake = vi.fn(async () => {});
    const company = () => db.select().from(companies).where(eq(companies.id, w.companyId));
    const before = await company();
    await db.execute(sql.raw(`alter table issues add constraint s41_unblock_write_failure
      check (company_id <> '${w.companyId}' or origin_kind <> 'mission_main_executor_unblock') not valid`));
    try { await expect(request(w, wake)).rejects.toThrow(); }
    finally { await db.execute(sql.raw("alter table issues drop constraint s41_unblock_write_failure")); }
    expect(await company()).toEqual(before); expect(await anchors(db, w)).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes only after the heartbeat anchor is committed and preserves request context", async () => {
    const w = await unblockWorld(db);
    const wake = vi.fn(async (_agentId: string, options: { payload?: Record<string, unknown> | null }) => {
      const stored = await anchors(other, w);
      expect(stored).toHaveLength(1); expect(stored[0]!.id).toBe(options.payload?.issueId);
    });
    const result = await createRequestChangesOwnerAction({ db, enqueueWakeup: wake })({
      sourceIssue: w.source, run: w.heartbeat, verdict: { excerpt: "REQUEST_CHANGES: fix evidence" },
    });
    expect(result?.description).toContain("REQUEST_CHANGES: fix evidence");
    expect(wake).toHaveBeenCalledTimes(1);
    await expect(wake.mock.results[0]!.value).resolves.toBeUndefined();
  });
});
