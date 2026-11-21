/**
 * Scheduler Cron Wakeup Service
 *
 * Polling loop that claims due schedules and triggers agent wakeups.
 * Uses FOR UPDATE SKIP LOCKED for safe distributed operation.
 *
 * Architecture Plan §3.4: claim-then-run pattern
 */

import type { Db } from "@paperclipai/db";
import { schedules } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { computeNextRun } from "./cron-next-run.js";
import type { ScheduleClaimResult } from "./types.js";
import { schedulerDueToWakeupLatency } from "../../routes/metrics.js";
import { withSpan } from "../../lib/tracer.js";

// The timezone-aware next-run implementation lives in ./cron-next-run.js so
// non-scheduler callers (e.g. mission schedule-horizon evaluation) can share it
// without pulling this module's metrics/tracer dependencies.
export { computeNextRun };

/**
 * Default polling interval in milliseconds (60 seconds).
 */
const SCHEDULER_POLL_INTERVAL_MS = 60_000;

/**
 * Maximum schedules to claim per polling cycle.
 */
const MAX_CLAIM_PER_CYCLE = 100;

/**
 * Claim due schedules using FOR UPDATE SKIP LOCKED pattern.
 *
 * This query:
 * 1. Finds schedules that are due (next_run_at <= now)
 * 2. Locks them with SKIP LOCKED (other concurrent workers skip these)
 * 3. Updates last_run_at and computes next_run_at
 * 4. Returns the claimed schedule data
 *
 * @param db - Database instance
 * @returns Claimed schedules with agent and mission info
 */
export async function claimDueSchedules(db: Db): Promise<ScheduleClaimResult["claimed"]> {
  const now = new Date();
  const nowIso = now.toISOString();

  // Execute the claim-then-run query
  const result = await db.execute(
    sql`
      WITH due AS (
        SELECT id
        FROM schedules
        WHERE enabled = true
          AND next_run_at <= ${nowIso}
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${MAX_CLAIM_PER_CYCLE}
      )
        UPDATE schedules s
        SET
          last_run_at = ${nowIso},
          next_run_at = NULL::timestamptz,
          updated_at = ${nowIso}
      FROM due
      WHERE s.id = due.id
      RETURNING
        s.id,
        s.company_id,
        s.agent_id,
        s.mission_id,
        s.cron_expression,
        s.timezone
    `
  );

  const rows = result as unknown as Array<{
    id: string;
    company_id: string;
    agent_id: string;
    mission_id: string | null;
    cron_expression: string;
    timezone: string;
  }>;

  // Now compute and update next_run_at for each claimed schedule
  for (const row of rows) {
    const nextRun = computeNextRun(row.cron_expression, row.timezone, now);
    await db
      .update(schedules)
      .set({ nextRunAt: nextRun })
      .where(eq(schedules.id, row.id));
  }

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    missionId: row.mission_id,
  }));
}

/**
 * Scheduler state and polling loop control.
 */
export interface SchedulerDeps {
  heartbeat: {
    enqueueWakeup: (
      agentId: string,
      opts?: {
        source?: string;
        triggerDetail?: string | null;
        missionId?: string;
        reason?: string;
      },
    ) => Promise<unknown>;
  };
}

export interface SchedulerState {
  running: boolean;
  lastPollAt: Date | null;
  activeScheduleCount: number;
  totalWakeupCount: number;
}

/**
 * Create a scheduler instance.
 *
 * @param db - Database instance
 * @param deps - Service dependencies
 * @returns Scheduler control interface
 */
export function createScheduler(db: Db, deps: SchedulerDeps) {
  let state: SchedulerState = {
    running: false,
    lastPollAt: null,
    activeScheduleCount: 0,
    totalWakeupCount: 0,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollGeneration = 0;
  const activePolls = new Set<Promise<void>>();

  function trackPoll(poll: Promise<void>): Promise<void> {
    activePolls.add(poll);
    void poll.then(
      () => activePolls.delete(poll),
      () => activePolls.delete(poll),
    );
    return poll;
  }

  /**
   * Execute a single polling cycle.
   */
  async function performPollCycle(): Promise<void> {
    const startTime = new Date();

    await withSpan("scheduler.claimAndWakeup", {}, async (span) => {
      try {
        // Claim due schedules
        const claimed = await claimDueSchedules(db);

        span.setAttribute("scheduler.claimed_count", claimed.length);

        // Update state
        state.lastPollAt = startTime;
        state.activeScheduleCount = claimed.length;

        if (claimed.length === 0) {
          return;
        }

        let wakeupSuccess = 0;
        let wakeupFailure = 0;

        // Fire wakeups for each claimed schedule
        for (const schedule of claimed) {
          const wakeupStart = Date.now();
          try {
            await deps.heartbeat.enqueueWakeup(schedule.agentId, {
              source: "scheduler",
              triggerDetail: `schedule:${schedule.id}`,
              missionId: schedule.missionId ?? undefined,
              reason: "scheduled_wakeup",
            });
            // P9-T2: observe due-to-wakeup latency (approximate: time within poll cycle)
            schedulerDueToWakeupLatency.observe((Date.now() - wakeupStart) / 1000);
            state.totalWakeupCount++;
            wakeupSuccess++;
          } catch (error) {
            // Log error but continue with other schedules
            console.error(
              `[Scheduler] Failed to wakeup agent ${schedule.agentId} for schedule ${schedule.id}:`,
              error,
            );
            wakeupFailure++;
          }
        }

        span.setAttribute("scheduler.wakeup_success", wakeupSuccess);
        span.setAttribute("scheduler.wakeup_failure", wakeupFailure);
      } catch (error) {
        console.error("[Scheduler] Poll cycle error:", error);
        throw error;
      }
    }).catch((err) => {
      // withSpan already re-throws; swallow here to match original fire-and-forget behaviour
      console.error("[Scheduler] Poll cycle span error:", err);
    });
  }

  function pollCycle(): Promise<void> {
    return trackPoll(performPollCycle());
  }

  function runAutomaticPoll(generation: number, initial = false): void {
    if (!state.running || pollGeneration !== generation) return;
    pollCycle().catch((err) => {
      console.error(initial ? "[Scheduler] Initial poll error:" : "[Scheduler] Poll error:", err);
    });
  }

  /**
   * Start the scheduler polling loop.
   */
  function start(): void {
    if (state.running) {
      console.warn("[Scheduler] Already running");
      return;
    }

    state.running = true;
    const generation = ++pollGeneration;
    console.log(`[Scheduler] Started polling every ${SCHEDULER_POLL_INTERVAL_MS}ms`);

    // Run first poll immediately
    runAutomaticPoll(generation, true);

    // Set up recurring polls
    pollTimer = setInterval(() => runAutomaticPoll(generation), SCHEDULER_POLL_INTERVAL_MS);
  }

  /**
   * Stop the scheduler polling loop.
   */
  function stop(): void {
    if (!state.running) {
      return;
    }

    state.running = false;
    pollGeneration += 1;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    console.log("[Scheduler] Stopped");
  }

  async function drain(): Promise<void> {
    while (activePolls.size > 0) {
      await Promise.allSettled([...activePolls]);
    }
  }

  /**
   * Get current scheduler state.
   */
  function getState(): SchedulerState {
    return { ...state };
  }

  return {
    start,
    stop,
    drain,
    getState,
    pollCycle,
  };
}

/**
 * Re-export types for convenience.
 */
export type { Schedule, CreateScheduleInput, UpdateScheduleInput } from "./types.js";
