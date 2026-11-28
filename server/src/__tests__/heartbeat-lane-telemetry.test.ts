import { describe, expect, it } from "vitest";
import {
  computeFleetQueueTelemetry,
  type RunQueueSnapshotItem,
} from "../services/heartbeat-lane-telemetry.js";

const NOW = new Date("2026-11-28T12:00:00.000Z");

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function snapshotRun(input: RunQueueSnapshotItem): RunQueueSnapshotItem {
  return input;
}

describe("computeFleetQueueTelemetry", () => {
  it("returns zeroed fleet telemetry for empty input", () => {
    expect(computeFleetQueueTelemetry([], [], { now: NOW })).toEqual({
      totalSlots: 0,
      totalRunning: 0,
      totalQueued: 0,
      saturatedAgents: 0,
      starvingAgents: 0,
      maxQueuedWaitMs: 0,
      byAgent: [],
    });
  });

  it("includes configured idle agents in capacity and clamps slot counts to at least one", () => {
    const result = computeFleetQueueTelemetry(
      [],
      [
        { agentId: "agent-zero", maxConcurrentRuns: 0 },
        { agentId: "agent-four", maxConcurrentRuns: 4 },
      ],
      { now: NOW },
    );

    expect(result.totalSlots).toBe(5);
    expect(result.totalRunning).toBe(0);
    expect(result.totalQueued).toBe(0);
    expect(result.byAgent).toHaveLength(2);
    expect(result.byAgent.find((agent) => agent.agentId === "agent-zero")).toMatchObject({
      maxConcurrentRuns: 1,
      runningCount: 0,
      queuedCount: 0,
      utilizationRatio: 0,
      saturated: false,
      oldestQueuedWaitMs: 0,
      starvationWarning: false,
      distinctQueuedIssues: 0,
    });
  });

  it("measures a saturated single-slot agent and the default starvation threshold", () => {
    const result = computeFleetQueueTelemetry(
      [
        snapshotRun({
          id: "run-running",
          agentId: "agent-1",
          status: "running",
          createdAt: isoMinutesAgo(20),
        }),
        snapshotRun({
          id: "run-queued",
          agentId: "agent-1",
          status: "queued",
          createdAt: isoMinutesAgo(10),
          issueId: "issue-1",
        }),
      ],
      [{ agentId: "agent-1", maxConcurrentRuns: 1 }],
      { now: NOW },
    );

    expect(result).toMatchObject({
      totalSlots: 1,
      totalRunning: 1,
      totalQueued: 1,
      saturatedAgents: 1,
      starvingAgents: 1,
      maxQueuedWaitMs: 600_000,
    });
    expect(result.byAgent).toHaveLength(1);
    expect(result.byAgent[0]).toMatchObject({
      agentId: "agent-1",
      maxConcurrentRuns: 1,
      runningCount: 1,
      queuedCount: 1,
      utilizationRatio: 1,
      saturated: true,
      oldestQueuedWaitMs: 600_000,
      starvationWarning: true,
      distinctQueuedIssues: 1,
    });
  });

  it("measures multi-slot utilization without saturation", () => {
    const result = computeFleetQueueTelemetry(
      [
        snapshotRun({ id: "run-1", agentId: "agent-4", status: "running", createdAt: isoMinutesAgo(8) }),
        snapshotRun({ id: "run-2", agentId: "agent-4", status: "running", createdAt: isoMinutesAgo(7) }),
        snapshotRun({ id: "run-3", agentId: "agent-4", status: "running", createdAt: isoMinutesAgo(6) }),
        snapshotRun({
          id: "run-4",
          agentId: "agent-4",
          status: "queued",
          createdAt: isoMinutesAgo(2),
          issueId: "issue-2",
        }),
      ],
      [{ agentId: "agent-4", maxConcurrentRuns: 4 }],
      { now: NOW },
    );

    expect(result.totalSlots).toBe(4);
    expect(result.totalRunning).toBe(3);
    expect(result.totalQueued).toBe(1);
    expect(result.saturatedAgents).toBe(0);
    expect(result.byAgent[0]).toMatchObject({
      runningCount: 3,
      queuedCount: 1,
      utilizationRatio: 0.75,
      saturated: false,
      oldestQueuedWaitMs: 120_000,
      starvationWarning: false,
    });
  });

  it("defaults unconfigured agents to one slot and ignores terminal statuses", () => {
    const result = computeFleetQueueTelemetry(
      [
        snapshotRun({ id: "run-running", agentId: "agent-new", status: "running", createdAt: NOW }),
        snapshotRun({ id: "run-succeeded", agentId: "agent-new", status: "succeeded", createdAt: NOW }),
        snapshotRun({ id: "run-failed", agentId: "agent-new", status: "failed", createdAt: NOW }),
        snapshotRun({ id: "run-cancelled", agentId: "agent-new", status: "cancelled", createdAt: NOW }),
      ],
      [],
      { now: NOW },
    );

    expect(result.totalSlots).toBe(1);
    expect(result.totalRunning).toBe(1);
    expect(result.totalQueued).toBe(0);
    expect(result.byAgent).toEqual([
      expect.objectContaining({
        agentId: "agent-new",
        maxConcurrentRuns: 1,
        runningCount: 1,
        queuedCount: 0,
        utilizationRatio: 1,
        saturated: true,
      }),
    ]);
  });

  it("rounds utilization ratios to three decimals", () => {
    const result = computeFleetQueueTelemetry(
      [
        snapshotRun({ id: "run-1", agentId: "agent-3", status: "running", createdAt: NOW }),
        snapshotRun({ id: "run-2", agentId: "agent-3", status: "running", createdAt: NOW }),
      ],
      [{ agentId: "agent-3", maxConcurrentRuns: 3 }],
      { now: NOW },
    );

    expect(result.byAgent[0]?.utilizationRatio).toBe(0.667);
  });

  it("counts distinct queued issue ids without counting runs missing an issue", () => {
    const result = computeFleetQueueTelemetry(
      [
        snapshotRun({
          id: "run-1",
          agentId: "agent-1",
          status: "queued",
          createdAt: isoMinutesAgo(1),
          issueId: "issue-1",
        }),
        snapshotRun({
          id: "run-2",
          agentId: "agent-1",
          status: "queued",
          createdAt: isoMinutesAgo(1),
          issueId: "issue-1",
        }),
        snapshotRun({
          id: "run-3",
          agentId: "agent-1",
          status: "queued",
          createdAt: isoMinutesAgo(1),
          issueId: "issue-2",
        }),
        snapshotRun({
          id: "run-4",
          agentId: "agent-1",
          status: "queued",
          createdAt: isoMinutesAgo(1),
          issueId: null,
        }),
      ],
      [{ agentId: "agent-1", maxConcurrentRuns: 4 }],
      { now: NOW },
    );

    expect(result.byAgent[0]).toMatchObject({
      queuedCount: 4,
      distinctQueuedIssues: 2,
    });
  });

  it("uses a custom starvation warning threshold when provided", () => {
    const runs = [
      snapshotRun({
        id: "run-queued",
        agentId: "agent-1",
        status: "queued",
        createdAt: isoMinutesAgo(5),
      }),
    ];
    const configs = [{ agentId: "agent-1", maxConcurrentRuns: 1 }];

    const defaultResult = computeFleetQueueTelemetry(runs, configs, { now: NOW });
    const customResult = computeFleetQueueTelemetry(runs, configs, {
      now: NOW,
      starvationWarningMs: 300_000,
    });

    expect(defaultResult.byAgent[0]?.starvationWarning).toBe(false);
    expect(defaultResult.starvingAgents).toBe(0);
    expect(customResult.byAgent[0]?.starvationWarning).toBe(true);
    expect(customResult.starvingAgents).toBe(1);
  });

  it("sorts agents by queued count, oldest queued wait, then agent id", () => {
    const fiveMinutesAgo = isoMinutesAgo(5);
    const result = computeFleetQueueTelemetry(
      [
        snapshotRun({ id: "zeta-1", agentId: "zeta", status: "queued", createdAt: fiveMinutesAgo }),
        snapshotRun({ id: "alpha-1", agentId: "alpha", status: "queued", createdAt: fiveMinutesAgo }),
        snapshotRun({ id: "gamma-1", agentId: "gamma", status: "queued", createdAt: isoMinutesAgo(10) }),
        snapshotRun({ id: "beta-1", agentId: "beta", status: "queued", createdAt: isoMinutesAgo(1) }),
        snapshotRun({ id: "beta-2", agentId: "beta", status: "queued", createdAt: isoMinutesAgo(2) }),
      ],
      [],
      { now: NOW },
    );

    expect(result.byAgent.map((agent) => agent.agentId)).toEqual(["beta", "gamma", "alpha", "zeta"]);
  });
});
