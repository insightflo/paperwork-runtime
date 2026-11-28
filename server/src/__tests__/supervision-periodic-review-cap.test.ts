import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  MAX_PERIODIC_OVERSIGHT_RUNS,
  maybeDispatchMissionOwnerPeriodicReview,
} from "../services/missions/supervision-periodic-review.js";

type Input = Parameters<typeof maybeDispatchMissionOwnerPeriodicReview>[0];
type Unit = Input["executionSnapshot"]["units"][number];

const NOW = new Date("2026-11-29T02:00:00.000Z");
const mission = {
  id: "mission-1",
  companyId: "company-1",
  status: "active",
  createdAt: new Date(NOW.getTime() - 31 * 60_000),
} as unknown as Input["mission"];

function unit(status: string, id = `unit-${status}`): Unit {
  return {
    id,
    kind: "native_workflow_run",
    status,
    sourceRef: {
      type: "native_workflow_run",
      id,
      workflowRunId: null,
      stepId: null,
      issueId: null,
      pluginId: null,
      externalId: null,
    },
  } as unknown as Unit;
}

function harness(units: Unit[], oversightRunCount?: number, missionHasActiveHeartbeat = false) {
  const returning = vi.fn(async () => [{ id: "event-1" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const onWake = vi.fn(async () => {});
  const input: Input = {
    db: { insert } as unknown as Db,
    deps: { onMissionOwnerPeriodicReviewWakeRequested: onWake },
    mission,
    oversightIssueId: "oversight-1",
    missionIssues: [],
    executionSnapshot: { missionId: mission.id, companyId: mission.companyId, units, runtimes: [] },
    missionHasActiveHeartbeat,
    ...(oversightRunCount === undefined ? {} : { oversightRunCount }),
    now: NOW,
    findings: [],
  };
  return { input, insert, onWake };
}

describe("maybeDispatchMissionOwnerPeriodicReview zero-LLM suppression", () => {
  it("suppresses at the five-run cap even when a problem unit exists", async () => {
    const { input, insert, onWake } = harness([unit("failed")], MAX_PERIODIC_OVERSIGHT_RUNS);

    await maybeDispatchMissionOwnerPeriodicReview(input);

    expect(onWake).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("suppresses healthy in-flight execution during heartbeat handoff gaps", async () => {
    const { input, insert, onWake } = harness([unit("running")], undefined, false);

    await maybeDispatchMissionOwnerPeriodicReview(input);

    expect(onWake).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("still wakes below the cap for a failed unit and catches callback failures", async () => {
    const { input, insert, onWake } = harness([unit("failed")], MAX_PERIODIC_OVERSIGHT_RUNS - 1);
    onWake.mockRejectedValueOnce(new Error("wake failed"));

    await expect(maybeDispatchMissionOwnerPeriodicReview(input)).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});
