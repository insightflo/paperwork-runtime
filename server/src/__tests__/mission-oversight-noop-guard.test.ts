// No-progress short-circuit for the oversight liveness lane.
// RED→GREEN: a persistent identical ghost used to re-wake the owner every 2h bucket forever.
// The guard chains only this lane's own durable claims and fails open (wake) on any doubt.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, missions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as shadow from "../services/mission-oversight-shadow.js";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const guardModule = "../services/mission-oversight-noop-guard.js";
// Keep a missing implementation inside each named RED rather than suite collection.
const loadGuard = () => import(/* @vite-ignore */ guardModule) as Promise<typeof import("../services/mission-oversight-noop-guard.js")>;
const laneModule = "../services/mission-oversight-liveness-lane.js";
const loadLane = () => import(/* @vite-ignore */ laneModule) as Promise<typeof import("../services/mission-oversight-liveness-lane.js")>;

const NOW = new Date("2026-10-16T02:30:00Z");
const BUCKET_MS = 2 * 60 * 60_000;
const WAKE_EVENT = "mission_oversight_liveness_wake";
const LAYER = "mission_owner_recovery";
const REASON = "heartbeat_stale_while_running";
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const hex16 = /^[0-9a-f]{16}$/;

describe("oversight no-progress guard (pure decision)", () => {
  const base = { ghostEntities: [{ kind: "heartbeat" as const, id: "hb-1" }], reasonCode: REASON, oldestRunningHeartbeatAt: NOW.toISOString() };

  it("fingerprint is a stable 16-hex digest, order-independent, and changes with any ghost evidence", async () => {
    const { computeOversightStateFingerprint: fp } = await loadGuard();
    const digest = fp(base);
    expect(digest).toMatch(hex16);
    expect(fp({ ...base })).toBe(digest);
    const entities = [{ kind: "step" as const, id: "s-1" }, { kind: "heartbeat" as const, id: "hb-0" }, base.ghostEntities[0]];
    expect(fp({ ...base, ghostEntities: entities })).toBe(fp({ ...base, ghostEntities: [...entities].reverse() }));
    expect(fp({ ...base, ghostEntities: [{ kind: "heartbeat", id: "hb-2" }] })).not.toBe(digest);
    expect(fp({ ...base, ghostEntities: [{ kind: "step", id: "hb-1" }] })).not.toBe(digest);
    expect(fp({ ...base, ghostEntities: [...base.ghostEntities, { kind: "step", id: "s-1" }] })).not.toBe(digest);
    expect(fp({ ...base, reasonCode: "other" })).not.toBe(digest);
    expect(fp({ ...base, oldestRunningHeartbeatAt: ago(1000).toISOString() })).not.toBe(digest);
    expect(fp({ ...base, oldestRunningHeartbeatAt: null })).not.toBe(digest);
  });

  it("chains consecutive identical wakes and short-circuits only past the limit", async () => {
    const { computeOversightStateFingerprint: fp, decideOversightNoProgressGuard: decide, DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_WAKES: max } = await loadGuard();
    expect(max).toBeGreaterThanOrEqual(2); // Delivery failure in one bucket must keep at least one retry.
    const digest = fp(base);
    const other = fp({ ...base, ghostEntities: [{ kind: "heartbeat", id: "hb-2" }] });
    const claim = (ghostFingerprint: string, consecutiveNoProgress: number) => ({ ghostFingerprint, consecutiveNoProgress });
    expect(decide({ prior: null, ghostFingerprint: digest })).toEqual({ shortCircuit: false, consecutiveNoProgress: 1 });
    expect(decide({ prior: claim(other, max), ghostFingerprint: digest })).toEqual({ shortCircuit: false, consecutiveNoProgress: 1 });
    for (let count = 1; count < max; count++) {
      expect(decide({ prior: claim(digest, count), ghostFingerprint: digest })).toEqual({ shortCircuit: false, consecutiveNoProgress: count + 1 });
    }
    expect(decide({ prior: claim(digest, max), ghostFingerprint: digest }))
      .toEqual({ shortCircuit: true, consecutiveNoProgress: max, reasonCode: "consecutive_no_progress_limit_reached" });
    expect(decide({ prior: claim(digest, max + 5), ghostFingerprint: digest }).shortCircuit).toBe(true);
    expect(decide({ prior: claim(digest, 1), ghostFingerprint: digest, maxConsecutiveNoProgressWakes: 1 }).shortCircuit).toBe(true);
    expect(decide({ prior: claim(digest, 1), ghostFingerprint: digest, maxConsecutiveNoProgressWakes: 2 }))
      .toEqual({ shortCircuit: false, consecutiveNoProgress: 2 });
  });

  it("validates the durable claim strictly: legacy or malformed payloads are not no-progress evidence", async () => {
    const { readPriorOversightWakeClaim: read } = await loadGuard();
    const valid = { schemaVersion: 1, kind: WAKE_EVENT, state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: REASON,
      computedTimestamps: {}, ghostFingerprint: "0123456789abcdef", consecutiveNoProgress: 2 };
    expect(read(valid, WAKE_EVENT)).toEqual({ ghostFingerprint: "0123456789abcdef", consecutiveNoProgress: 2 });
    const rejected = [null, "x", 7, [], {},
      { ...valid, schemaVersion: 2 }, { ...valid, schemaVersion: "1" }, { ...valid, kind: "mission_oversight_failure_wake" },
      { schemaVersion: 1, kind: WAKE_EVENT, state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: REASON, computedTimestamps: {} }, // pre-guard legacy claim
      { ...valid, ghostFingerprint: undefined }, { ...valid, ghostFingerprint: "ABCDEF0123456789" }, { ...valid, ghostFingerprint: "0123456789abcde" },
      { ...valid, ghostFingerprint: 123 }, { ...valid, consecutiveNoProgress: undefined }, { ...valid, consecutiveNoProgress: 0 },
      { ...valid, consecutiveNoProgress: -1 }, { ...valid, consecutiveNoProgress: 1.5 }, { ...valid, consecutiveNoProgress: "2" }, { ...valid, consecutiveNoProgress: NaN }];
    for (const payload of rejected) expect(read(payload, WAKE_EVENT)).toBeNull();
  });
});

describe("mission oversight liveness lane no-progress short-circuit (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("paperclip-noop-guard-"); db = createDb(pg.connectionString); }, 60_000);
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await pg?.cleanup(); } });
  beforeEach(async () => {
    await db.update(missions).set({ status: "paused" });
    await db.delete(workflowTransitionEvents);
    mocks.warn.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function world() {
    const [company] = await db.insert(companies).values({ name: "No-op guard", issuePrefix: `N${randomUUID()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Owner" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id,
      title: "No-op guard", status: "active", createdAt: ago(40 * 60_000) }).returning();
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: company.id, name: "Build",
      stepsJson: [{ id: "build", type: "agent", name: "Build" }] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: company.id, missionId: mission.id, workflowId: definition.id,
      status: "running", triggeredBy: "test", createdAt: ago(40 * 60_000), startedAt: ago(40 * 60_000) }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "build", status: "running",
      executionGeneration: 2, startedAt: ago(40 * 60_000), metadata: {} }).returning();
    const [hb] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, workflowStepRunId: step.id,
      workflowExecutionGeneration: 2, status: "running", createdAt: ago(40 * 60_000), startedAt: ago(40 * 60_000), updatedAt: ago(16 * 60_000) }).returning();
    return { company, agent, mission, run, step, hb };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const bucketKey = (f: World, at: Date) => `mission-oversight-liveness:${f.mission.id}:${Math.floor(at.getTime() / BUCKET_MS)}`;
  const markers = (f: World) => db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, f.company.id), eq(workflowTransitionEvents.missionId, f.mission.id),
    eq(workflowTransitionEvents.eventType, WAKE_EVENT))).orderBy(workflowTransitionEvents.createdAt);
  async function lane(maxConsecutiveNoProgressWakes?: number) {
    const { createMissionOversightLivenessLane } = await loadLane();
    const wake = vi.fn(async (_input: unknown) => {});
    const created = createMissionOversightLivenessLane(db, { livenessLaneIntervalMs: 20, onMissionOversightLivenessGhostWakeRequested: wake, maxConsecutiveNoProgressWakes });
    onTestFinished(() => created.stop());
    return { lane: created, wake };
  }
  async function reachLimit(f: World, max: number) {
    const first = await lane(max);
    for (let bucket = 0; bucket < max; bucket++) { vi.setSystemTime(NOW.getTime() + bucket * BUCKET_MS); await first.lane.run(); }
    expect(first.wake).toHaveBeenCalledTimes(max);
    vi.setSystemTime(NOW.getTime() + max * BUCKET_MS);
    return first;
  }

  it("a persistent identical ghost stops re-waking after the consecutive no-progress limit, durably", async () => {
    const f = await world();
    expect(await shadow.evaluateMissionOversightForMission(db, f.company.id, f.mission.id, new Date()))
      .toMatchObject({ state: "RUNNING", triggerKind: "liveness_ghost", ghostEntities: [{ kind: "heartbeat", id: f.hb.id }] });
    const { lane: fast, wake } = await reachLimit(f, 2);
    await fast.run(); await fast.run();
    const recreated = await lane(2); await recreated.lane.run(); // Restart/other process: durable, not local state.
    expect(wake).toHaveBeenCalledTimes(2); expect(recreated.wake).not.toHaveBeenCalled();
    const rows = await markers(f);
    expect(rows.map((r) => r.idempotencyKey)).toEqual([bucketKey(f, NOW), bucketKey(f, new Date(NOW.getTime() + BUCKET_MS))]);
    expect(rows.map((r) => r.payload.consecutiveNoProgress)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.payload.ghostFingerprint)).size).toBe(1);
    expect(String(rows[0].payload.ghostFingerprint)).toMatch(hex16);
    // Existing claim contract is preserved (additive payload only).
    expect(rows[0].payload).toMatchObject({ schemaVersion: 1, kind: WAKE_EVENT, state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: REASON,
      computedTimestamps: { oldest_running_heartbeat_at: f.hb.updatedAt.toISOString() } });
    expect(mocks.warn.mock.calls.map(([data]) => data)).toContainEqual(expect.objectContaining({ missionId: f.mission.id, companyId: f.company.id,
      ghostFingerprint: rows[0].payload.ghostFingerprint, consecutiveNoProgress: 2, maxConsecutiveNoProgressWakes: 2 }));
  });

  it("a changed ghost state resets the chain and wakes the owner again", async () => {
    const f = await world();
    const { wake } = await reachLimit(f, 2);
    const [next] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, workflowStepRunId: f.step.id,
      workflowExecutionGeneration: 2, status: "running", createdAt: ago(30 * 60_000), startedAt: ago(30 * 60_000), updatedAt: ago(20 * 60_000) }).returning();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: ago(9 * 60_000) }).where(eq(heartbeatRuns.id, f.hb.id));
    await wake.mockClear(); vi.setSystemTime(NOW.getTime() + 3 * BUCKET_MS);
    const capped = wake;
    const fresh = await lane(2); await fresh.lane.run();
    expect(capped).not.toHaveBeenCalled(); // The exhausted chain never revives on its own.
    expect(fresh.wake).toHaveBeenCalledTimes(1);
    expect(fresh.wake.mock.calls[0][0]).toMatchObject({ verdict: { state: "RUNNING", triggerKind: "liveness_ghost" }, idempotencyKey: bucketKey(f, new Date()) });
    const rows = await markers(f);
    expect(rows.map((r) => r.payload.consecutiveNoProgress)).toEqual([1, 2, 1]);
    expect(rows[2].payload.ghostFingerprint).not.toBe(rows[0].payload.ghostFingerprint);
    expect(String(rows[2].payload.ghostFingerprint)).toMatch(hex16);
    expect(next.id).toBeTruthy();
  });

  it("fails open: an unreadable claim store, a legacy claim, or foreign wake events never suppress a wake", async () => {
    const { readLatestOversightWakeClaim } = await loadGuard();
    const broken = { select: () => { throw new Error("claim store unavailable"); } } as unknown as Db;
    const f = await world();
    await expect(readLatestOversightWakeClaim(broken, { companyId: f.company.id, missionId: f.mission.id, eventType: WAKE_EVENT, layer: LAYER })).resolves.toBeNull();
    expect(mocks.warn.mock.calls.map(([data]) => data?.err?.message)).toContain("claim store unavailable");
    // A pre-guard claim and another lane's marker carrying an exhausted chain are both not evidence.
    await db.insert(workflowTransitionEvents).values([
      { companyId: f.company.id, missionId: f.mission.id, eventType: WAKE_EVENT, layer: LAYER, idempotencyKey: `${bucketKey(f, NOW)}:legacy`,
        payload: { schemaVersion: 1, kind: WAKE_EVENT, state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: REASON, computedTimestamps: {} } },
      { companyId: f.company.id, missionId: f.mission.id, eventType: "mission_owner_periodic_review_wake", layer: LAYER, idempotencyKey: `mission-owner-periodic-review:${f.mission.id}:1`,
        payload: { schemaVersion: 1, kind: "mission_owner_periodic_review_wake", ghostFingerprint: "0123456789abcdef", consecutiveNoProgress: 99 } },
    ]);
    const { lane: fast, wake } = await lane(1);
    await fast.run(); expect(wake).toHaveBeenCalledTimes(1);
    expect((await markers(f)).filter((r) => r.idempotencyKey === bucketKey(f, NOW)).map((r) => r.payload.consecutiveNoProgress)).toEqual([1]);
    // Operator/system markers of other kinds keep flowing: the lane never writes or reads them.
    expect(await db.select({ eventType: workflowTransitionEvents.eventType }).from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.missionId, f.mission.id))).toEqual(expect.arrayContaining([
        { eventType: WAKE_EVENT }, { eventType: "mission_owner_periodic_review_wake" }]));
  });

  it("a delivery failure still leaves the claim and counts as one wake in the chain", async () => {
    const f = await world();
    const { createMissionOversightLivenessLane } = await loadLane();
    const wake = vi.fn(async () => { throw new Error("delivery unavailable"); });
    const first = createMissionOversightLivenessLane(db, { onMissionOversightLivenessGhostWakeRequested: wake, maxConsecutiveNoProgressWakes: 1 });
    onTestFinished(() => first.stop());
    await first.run(); expect(wake).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW.getTime() + BUCKET_MS); await first.run();
    expect(wake).toHaveBeenCalledTimes(1); // Same ghost, limit reached: no second token-burning run.
    expect((await markers(f)).map((r) => r.payload.consecutiveNoProgress)).toEqual([1]);
  });
});
