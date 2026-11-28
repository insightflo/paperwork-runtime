import { describe, expect, it } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  computeExceptionHuddleSla,
  type ExceptionHuddleSlaSnapshot,
} from "../services/missions/exception-huddle-sla.js";

const OPENED_AT_MS = Date.parse("2026-11-28T01:00:00.000Z");
const TIMEOUT_AT = "2026-11-28T01:05:00.000Z";
const retryDecision: NonNullable<ExceptionHuddleMetadata["decision"]> = {
  kind: "retry_with_guidance",
  rationale: "The evidence needs correction",
  guidance: "Correct the evidence and retry",
  forcedByChair: false,
};

function at(elapsedMs: number): Date {
  return new Date(OPENED_AT_MS + elapsedMs);
}

function iso(elapsedMs: number): string {
  return at(elapsedMs).toISOString();
}

function metadata(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "run-1",
    sourceStepId: "step-qa",
    sourceIssueId: null,
    workProductLinks: ["work-product://draft"],
    participants: {
      ownerAgentId: "owner-1",
      producerAgentId: "producer-1",
      validatorAgentId: "validator-1",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: TIMEOUT_AT,
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function decidedAt(elapsedMs: number): Partial<ExceptionHuddleMetadata> {
  return {
    status: "decided",
    decision: retryDecision,
    decidedByAgentId: "owner-1",
    decidedAt: iso(elapsedMs),
  };
}

function expectSnapshot(
  huddle: ExceptionHuddleMetadata,
  now: Date,
  expected: ExceptionHuddleSlaSnapshot,
) {
  expect(computeExceptionHuddleSla(huddle, now)).toEqual(expected);
}

describe("computeExceptionHuddleSla", () => {
  it("reports normal urgency while more than two minutes remain", () => {
    expectSnapshot(metadata(), at(60_000), {
      elapsedMs: 60_000,
      remainingBudgetMs: 240_000,
      isBreached: false,
      urgencyLevel: "normal",
    });
  });

  it("reports warning urgency at the two-minute remaining boundary", () => {
    expectSnapshot(metadata(), at(180_000), {
      elapsedMs: 180_000,
      remainingBudgetMs: 120_000,
      isBreached: false,
      urgencyLevel: "warning",
    });
  });

  it("reports critical urgency at the one-minute remaining boundary", () => {
    expectSnapshot(metadata(), at(240_000), {
      elapsedMs: 240_000,
      remainingBudgetMs: 60_000,
      isBreached: false,
      urgencyLevel: "critical",
    });
  });

  it("treats an open huddle at its deadline as breached and critical", () => {
    expectSnapshot(metadata(), at(300_000), {
      elapsedMs: 300_000,
      remainingBudgetMs: 0,
      isBreached: true,
      urgencyLevel: "critical",
    });
  });

  it("treats a timed-out huddle as breached with no remaining budget", () => {
    expectSnapshot(metadata({ status: "timed_out" }), at(310_000), {
      elapsedMs: 310_000,
      remainingBudgetMs: 0,
      isBreached: true,
      urgencyLevel: "critical",
    });
  });

  it("settles a huddle decided before its deadline without breach", () => {
    expectSnapshot(metadata(decidedAt(180_000)), at(250_000), {
      elapsedMs: 180_000,
      remainingBudgetMs: 0,
      isBreached: false,
      urgencyLevel: "settled",
    });
  });

  it("settles a huddle decided after its deadline as breached", () => {
    expectSnapshot(metadata(decidedAt(300_001)), at(310_000), {
      elapsedMs: 300_001,
      remainingBudgetMs: 0,
      isBreached: true,
      urgencyLevel: "settled",
    });
  });

  it("does not breach a huddle decided exactly at its deadline", () => {
    expectSnapshot(metadata(decidedAt(300_000)), at(310_000), {
      elapsedMs: 300_000,
      remainingBudgetMs: 0,
      isBreached: false,
      urgencyLevel: "settled",
    });
  });

  it("settles a cancelled huddle with no remaining budget", () => {
    expectSnapshot(metadata({ status: "cancelled" }), at(200_000), {
      elapsedMs: 200_000,
      remainingBudgetMs: 0,
      isBreached: false,
      urgencyLevel: "settled",
    });
  });

  it("clamps negative clock skew elapsed time to zero", () => {
    const snapshot = computeExceptionHuddleSla(metadata(), at(-1_000));
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.remainingBudgetMs).toBe(301_000);
  });

  it("falls back to the injected clock when a decided huddle has no valid decision time", () => {
    const snapshot = computeExceptionHuddleSla(metadata({
      status: "decided",
      decision: retryDecision,
      decidedByAgentId: "owner-1",
      decidedAt: "not-a-time",
    }), at(200_000));
    expect(snapshot.elapsedMs).toBe(200_000);
    expect(snapshot.isBreached).toBe(false);
  });

  it("does not mutate frozen huddle metadata", () => {
    const huddle = metadata(decidedAt(180_000));
    Object.freeze(huddle.participants);
    Object.freeze(huddle.workProductLinks);
    Object.freeze(huddle.decision);
    Object.freeze(huddle);
    const before = JSON.stringify(huddle);

    expect(computeExceptionHuddleSla(huddle, at(200_000)).urgencyLevel).toBe("settled");
    expect(JSON.stringify(huddle)).toBe(before);
  });
});
