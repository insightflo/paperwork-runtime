import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import { getExceptionHuddleTelemetrySummary } from "../services/missions/exception-huddle-summary-service.js";

type SnapshotRow = {
  threadId: string;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

const baseMetadataInput = {
  schemaVersion: "workflow.exception-huddle.v1",
  missionId: "mission-1",
  workflowRunId: "run-1",
  sourceStepId: "qa-step",
  sourceIssueId: "issue-1",
  workProductLinks: ["work-product://draft-report"],
  participants: { ownerAgentId: "chair", producerAgentId: "writer", validatorAgentId: "reviewer" },
  maxRounds: 2,
  currentRound: 1,
  timeoutAt: "2026-11-28T01:05:00.000Z",
  status: "open",
  decision: null,
  decidedByAgentId: null,
  decidedAt: null,
};

function huddleMetadata(overrides: Record<string, unknown> = {}): ExceptionHuddleMetadata {
  return exceptionHuddleMetadataSchema.parse({ ...baseMetadataInput, ...overrides });
}

function snapshotMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...huddleMetadata(overrides),
    roundTurns: { "1": [], "2": [] },
    failureSummary: "QA rejected unsupported claims in the draft",
  };
}

function nestedSnapshotMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    exceptionHuddle: snapshotMetadata(overrides),
  };
}

function retryDecision() {
  return {
    kind: "retry_with_guidance",
    rationale: "Evidence needs correction",
    guidance: "Fix the evidence",
  };
}

function row(threadId: string, createdAt: string, metadata: Record<string, unknown> | null): SnapshotRow {
  return { threadId, createdAt: new Date(createdAt), metadata };
}

function mockDb(rows: SnapshotRow[]): Db {
  const query = {
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  };
  return { select: () => query } as unknown as Db;
}

describe("getExceptionHuddleTelemetrySummary", () => {
  it("deduplicates snapshots per thread and keeps the latest valid huddle metadata", async () => {
    const older = row("thread-1", "2026-11-28T01:00:00.000Z", snapshotMetadata({
      missionId: "mission-dedupe",
      status: "open",
    }));
    const newer = row("thread-1", "2026-11-28T01:04:00.000Z", snapshotMetadata({
      missionId: "mission-dedupe",
      status: "decided",
      currentRound: 2,
      decision: retryDecision(),
      decidedByAgentId: "chair",
      decidedAt: "2026-11-28T01:04:00.000Z",
    }));
    const otherThread = row("thread-2", "2026-11-28T01:02:00.000Z", snapshotMetadata({
      missionId: "mission-other",
      status: "open",
    }));

    const summary = await getExceptionHuddleTelemetrySummary(mockDb([older, newer, otherThread]), {
      companyId: "company-1",
    });

    expect(summary.total).toBe(2);
    expect(summary.byStatus).toStrictEqual({ open: 1, timed_out: 0, decided: 1, cancelled: 0 });
    expect(summary.byDecisionKind.retry_with_guidance).toBe(1);
    expect(summary.averageRoundsOnDecided).toBe(2);
    expect(summary.resolutionRate).toBe(0.5);
  });

  it("skips malformed metadata rows safely", async () => {
    const missingMissionId = snapshotMetadata({ missionId: "mission-valid-shape" });
    delete missingMissionId.missionId;
    const rows = [
      row("thread-missing-mission", "2026-11-28T01:00:00.000Z", missingMissionId),
      row("thread-bad-status", "2026-11-28T01:01:00.000Z", {
        ...snapshotMetadata({ missionId: "mission-bad-status" }),
        status: "stuck",
      }),
      row("thread-null-metadata", "2026-11-28T01:02:00.000Z", null),
      row("thread-valid", "2026-11-28T01:03:00.000Z", snapshotMetadata({
        missionId: "mission-valid",
        status: "timed_out",
        currentRound: 2,
      })),
    ];

    const summary = await getExceptionHuddleTelemetrySummary(mockDb(rows), { companyId: "company-1" });

    expect(summary.total).toBe(1);
    expect(summary.byStatus).toStrictEqual({ open: 0, timed_out: 1, decided: 0, cancelled: 0 });
    expect(summary.timeoutRate).toBe(1);
  });

  it("scopes the summary to the requested missionId across flat and nested metadata", async () => {
    const rows = [
      row("thread-other-mission", "2026-11-28T01:00:00.000Z", snapshotMetadata({
        missionId: "mission-other",
        status: "decided",
        currentRound: 2,
        decision: retryDecision(),
        decidedByAgentId: "chair",
        decidedAt: "2026-11-28T01:03:00.000Z",
      })),
      row("thread-open", "2026-11-28T01:01:00.000Z", snapshotMetadata({
        missionId: "mission-filter",
        status: "open",
      })),
      row("thread-nested-timeout", "2026-11-28T01:02:00.000Z", nestedSnapshotMetadata({
        missionId: "mission-filter",
        status: "timed_out",
        currentRound: 2,
      })),
    ];

    const summary = await getExceptionHuddleTelemetrySummary(mockDb(rows), {
      companyId: "company-1",
      missionId: "mission-filter",
    });

    expect(summary.total).toBe(2);
    expect(summary.byStatus).toStrictEqual({ open: 1, timed_out: 1, decided: 0, cancelled: 0 });
    expect(summary.resolutionRate).toBe(0);
    expect(summary.timeoutRate).toBe(0.5);
  });

  it("returns the zeroed telemetry summary for an empty result set", async () => {
    const summary = await getExceptionHuddleTelemetrySummary(mockDb([]), { companyId: "company-1" });

    expect(summary).toStrictEqual({
      total: 0,
      byStatus: { open: 0, timed_out: 0, decided: 0, cancelled: 0 },
      byDecisionKind: {
        retry_with_guidance: 0,
        accept_with_waiver: 0,
        replan_remaining: 0,
        escalate: 0,
      },
      byFailureKind: {},
      averageRoundsOnDecided: null,
      timeoutRate: 0,
      chairForcedDecisionCount: 0,
      resolutionRate: 0,
    });
  });
});
