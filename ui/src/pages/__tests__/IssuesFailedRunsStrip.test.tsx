// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { HeartbeatRunAttentionItem } from "@paperclipai/shared";
import { selectWorkFailedRuns, WORK_FAILED_RUN_PREVIEW_LIMIT } from "../Issues";

function attentionItem(
  status: HeartbeatRunAttentionItem["status"],
  runId: string,
  createdAt: string,
  error: string | null = null,
): HeartbeatRunAttentionItem {
  return {
    runId,
    agentId: `agent-${runId}`,
    status,
    issueId: null,
    createdAt: new Date(createdAt),
    error,
    errorCode: null,
  };
}

describe("selectWorkFailedRuns", () => {
  it("returns an empty list when there are no attention items", () => {
    expect(selectWorkFailedRuns([])).toEqual([]);
    expect(selectWorkFailedRuns(undefined)).toEqual([]);
  });

  it("surfaces only failed and timed_out runs with formatted inspection links", () => {
    const rows = selectWorkFailedRuns([
      attentionItem("cancelled", "run-cancelled", "2026-01-04T00:00:00.000Z"),
      attentionItem("failed", "run-failed", "2026-01-02T00:00:00.000Z", "first line\nsecond line"),
      attentionItem("timed_out", "run-timeout", "2026-01-03T00:00:00.000Z"),
      attentionItem("succeeded", "run-succeeded", "2026-01-05T00:00:00.000Z"),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["run-timeout", "run-failed"]);
    expect(rows[0]).toMatchObject({
      href: "/agents/agent-run-timeout/runs/run-timeout",
      statusLabel: "시간 초과",
    });
    expect(rows[1]).toMatchObject({
      href: "/agents/agent-run-failed/runs/run-failed",
      statusLabel: "실패",
      detail: "first line",
    });
  });

  it("limits the Work preview to the three most recent failed runs", () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      attentionItem("failed", `run-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`),
    );

    const rows = selectWorkFailedRuns(items, WORK_FAILED_RUN_PREVIEW_LIMIT);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id)).toEqual(["run-4", "run-3", "run-2"]);
  });
});
