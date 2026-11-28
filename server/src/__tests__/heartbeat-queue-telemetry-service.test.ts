import { describe, expect, it } from "vitest";
import {
  buildFleetQueueTelemetryResponse,
  extractMaxConcurrentRuns,
} from "../services/heartbeat-queue-telemetry-service.js";

describe("extractMaxConcurrentRuns", () => {
  it.each<[string, unknown, number]>([
    ["missing", {}, 1],
    ["zero", { heartbeat: { maxConcurrentRuns: 0 } }, 1],
    ["negative", { heartbeat: { maxConcurrentRuns: -4 } }, 1],
    ["in range", { heartbeat: { maxConcurrentRuns: 4 } }, 4],
    ["above limit", { heartbeat: { maxConcurrentRuns: 25 } }, 10],
    ["NaN", { heartbeat: { maxConcurrentRuns: Number.NaN } }, 1],
  ])("clamps %s values", (_label, runtimeConfig, expected) => {
    expect(extractMaxConcurrentRuns(runtimeConfig)).toBe(expected);
  });
});

describe("buildFleetQueueTelemetryResponse", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");

  it("aggregates single-slot and multi-slot agents with saturation, starvation, and queue details", () => {
    const response = buildFleetQueueTelemetryResponse({
      now,
      agents: [
        { id: "agent-single", name: "Single", status: "running", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
        { id: "agent-multi", name: "Multi", status: "running", runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } } },
      ],
      activeRuns: [
        { id: "run-single-active", agentId: "agent-single", status: "running", createdAt: "2026-01-01T00:08:00.000Z", issueId: "issue-running" },
        { id: "run-single-old", agentId: "agent-single", status: "queued", createdAt: "2026-01-01T00:00:00.000Z", issueId: "issue-shared" },
        { id: "run-single-new", agentId: "agent-single", status: "queued", createdAt: "2026-01-01T00:05:00.000Z", issueId: "issue-shared" },
        { id: "run-multi-active-1", agentId: "agent-multi", status: "running", createdAt: "2026-01-01T00:07:00.000Z", issueId: "issue-multi-1" },
        { id: "run-multi-active-2", agentId: "agent-multi", status: "running", createdAt: "2026-01-01T00:07:30.000Z", issueId: "issue-multi-2" },
        { id: "run-multi-queued", agentId: "agent-multi", status: "queued", createdAt: "2026-01-01T00:09:00.000Z", issueId: "issue-multi-queued" },
      ],
    });

    const single = response.byAgent.find((row) => row.agentId === "agent-single");
    const multi = response.byAgent.find((row) => row.agentId === "agent-multi");

    expect(single).toMatchObject({
      agentName: "Single",
      maxConcurrentRuns: 1,
      runningCount: 1,
      queuedCount: 2,
      utilizationRatio: 1,
      saturated: true,
      oldestQueuedWaitMs: 600_000,
      starvationWarning: true,
      distinctQueuedIssues: 1,
    });
    expect(multi).toMatchObject({
      maxConcurrentRuns: 4,
      runningCount: 2,
      queuedCount: 1,
      utilizationRatio: 0.5,
      saturated: false,
      oldestQueuedWaitMs: 60_000,
      starvationWarning: false,
      distinctQueuedIssues: 1,
    });
    expect(response).toMatchObject({
      totalSlots: 5,
      totalRunning: 3,
      totalQueued: 3,
      saturatedAgents: 1,
      starvingAgents: 1,
      maxQueuedWaitMs: 600_000,
    });
  });

  it("excludes idle terminated agents from slot totals but keeps active terminated agents counted", () => {
    const response = buildFleetQueueTelemetryResponse({
      now,
      agents: [
        { id: "agent-live", name: "Live", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
        { id: "agent-terminated-idle", name: "Terminated idle", status: "terminated", runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } } },
        { id: "agent-terminated-active", name: "Terminated active", status: "terminated", runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } },
      ],
      activeRuns: [
        { id: "run-terminated", agentId: "agent-terminated-active", status: "queued", createdAt: now, issueId: "issue-terminated" },
      ],
    });

    expect(response.totalSlots).toBe(3);
    expect(response.totalQueued).toBe(1);
    expect(response.byAgent.map((row) => row.agentId)).not.toContain("agent-terminated-idle");
    expect(response.byAgent.map((row) => row.agentId)).toContain("agent-terminated-active");
  });

  it("orders rows by queued count, oldest wait, then agent name deterministically", () => {
    const response = buildFleetQueueTelemetryResponse({
      now,
      agents: [
        { id: "agent-z", name: "Zulu", status: "idle", runtimeConfig: {} },
        { id: "agent-a", name: "Alpha", status: "idle", runtimeConfig: {} },
        { id: "agent-long-wait", name: "Long wait", status: "idle", runtimeConfig: {} },
        { id: "agent-most", name: "Most queued", status: "idle", runtimeConfig: {} },
      ],
      activeRuns: [
        { id: "run-most-1", agentId: "agent-most", status: "queued", createdAt: "2026-01-01T00:09:00.000Z" },
        { id: "run-most-2", agentId: "agent-most", status: "queued", createdAt: "2026-01-01T00:09:30.000Z" },
        { id: "run-long", agentId: "agent-long-wait", status: "queued", createdAt: "2026-01-01T00:05:00.000Z" },
        { id: "run-alpha", agentId: "agent-a", status: "queued", createdAt: "2026-01-01T00:09:00.000Z" },
        { id: "run-zulu", agentId: "agent-z", status: "queued", createdAt: "2026-01-01T00:09:00.000Z" },
      ],
    });

    expect(response.byAgent.map((row) => row.agentId)).toEqual([
      "agent-most",
      "agent-long-wait",
      "agent-a",
      "agent-z",
    ]);
  });

  it("accepts a custom starvation threshold and ignores terminal runs", () => {
    const response = buildFleetQueueTelemetryResponse({
      now,
      starvationWarningMs: 30_000,
      agents: [{ id: "agent-1", name: "Agent", status: "idle", runtimeConfig: {} }],
      activeRuns: [
        { id: "run-terminal", agentId: "agent-1", status: "succeeded", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "run-queued", agentId: "agent-1", status: "queued", createdAt: "2026-01-01T00:09:00.000Z" },
      ],
    });

    expect(response.totalRunning).toBe(0);
    expect(response.totalQueued).toBe(1);
    expect(response.byAgent[0]?.starvationWarning).toBe(true);
  });
});
