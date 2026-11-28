import { describe, expect, it } from "vitest";
import { selectMissionFailedRunAlerts } from "../Missions";

const run = (id: string, status: string, createdAt: string, agentId = "agent-1") => ({
  id,
  agentId,
  status,
  createdAt,
});

describe("selectMissionFailedRunAlerts", () => {
  it("returns an empty selection for empty input", () => {
    expect(selectMissionFailedRunAlerts([])).toEqual({ runs: [], totalCount: 0 });
    expect(selectMissionFailedRunAlerts(undefined)).toEqual({ runs: [], totalCount: 0 });
  });

  it("excludes succeeded and running runs", () => {
    const result = selectMissionFailedRunAlerts([
      run("succeeded-run", "succeeded", "2026-04-28T10:00:00.000Z"),
      run("running-run", "running", "2026-04-28T11:00:00.000Z"),
      run("failed-run", "failed", "2026-04-28T09:00:00.000Z"),
    ]);

    expect(result.runs.map((item) => item.id)).toEqual(["failed-run"]);
    expect(result.totalCount).toBe(1);
  });

  it("includes failed and timed_out runs newest-first with exact totalCount", () => {
    const result = selectMissionFailedRunAlerts([
      run("oldest-failed", "failed", "2026-04-28T08:00:00.000Z"),
      run("newest-timed-out", "timed_out", "2026-04-28T12:00:00.000Z"),
      run("middle-failed", "failed", "2026-04-28T10:00:00.000Z"),
      run("cancelled-run", "cancelled", "2026-04-28T13:00:00.000Z"),
    ]);

    expect(result.runs.map((item) => item.id)).toEqual([
      "newest-timed-out",
      "middle-failed",
      "oldest-failed",
    ]);
    expect(result.totalCount).toBe(3);
  });

  it("caps visible runs at three while keeping the exact total count", () => {
    const result = selectMissionFailedRunAlerts([
      run("failure-1", "failed", "2026-04-28T08:00:00.000Z"),
      run("failure-2", "timed_out", "2026-04-28T09:00:00.000Z"),
      run("failure-3", "failed", "2026-04-28T10:00:00.000Z"),
      run("failure-4", "timed_out", "2026-04-28T11:00:00.000Z"),
      run("failure-5", "failed", "2026-04-28T12:00:00.000Z"),
    ]);

    expect(result.runs.map((item) => item.id)).toEqual(["failure-5", "failure-4", "failure-3"]);
    expect(result.totalCount).toBe(5);
  });
});
