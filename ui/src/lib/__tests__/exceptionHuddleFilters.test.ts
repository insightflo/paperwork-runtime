import { describe, expect, it } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  filterAndSortExceptionHuddles,
  type FilterableExceptionHuddleItem,
} from "../exceptionHuddleFilters";

type HuddleStatus = ExceptionHuddleMetadata["status"];
type HuddleDecision = NonNullable<ExceptionHuddleMetadata["decision"]>;

function decisionFor(kind: HuddleDecision["kind"]): HuddleDecision {
  const base = {
    kind,
    rationale: `Decision rationale for ${kind}.`,
    forcedByChair: false,
  };
  switch (kind) {
    case "retry_with_guidance":
      return { ...base, kind, guidance: "Add the missing validator evidence." };
    case "accept_with_waiver":
      return { ...base, kind, waiverCondition: "Accept only with the documented waiver." };
    case "replan_remaining":
      return { ...base, kind, replanSummary: "Replan the remaining implementation steps." };
    case "escalate":
      return { ...base, kind, escalationReason: "Owner intervention is required." };
  }
}

function huddle(
  status: HuddleStatus,
  overrides: Partial<ExceptionHuddleMetadata> = {},
): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "workflow-run-1",
    sourceStepId: "step-1",
    sourceIssueId: "issue-1",
    workProductLinks: [],
    participants: {
      ownerAgentId: "owner-agent",
      producerAgentId: "producer-agent",
      validatorAgentId: "validator-agent",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-01-01T00:05:00.000Z",
    status,
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function item(
  threadId: string,
  title: string,
  status: HuddleStatus,
  updatedAt: string,
  options: { sourceStepId?: string; decision?: HuddleDecision | null } = {},
): FilterableExceptionHuddleItem {
  const decision = options.decision ?? null;
  return {
    threadId,
    channelId: "channel-1",
    title,
    updatedAt,
    huddle: huddle(status, {
      sourceStepId: options.sourceStepId ?? `step-for-${threadId}`,
      decision,
      decidedByAgentId: decision ? "owner-agent" : null,
      decidedAt: decision ? "2026-01-01T00:03:00.000Z" : null,
    }),
  };
}

const ids = (items: readonly FilterableExceptionHuddleItem[]) => items.map((item) => item.threadId);

const FILTER_ITEMS = [
  item("thread-open-old", "Validator conflict review", "open", "2026-01-02T12:00:00.000Z", {
    sourceStepId: "step-alpha",
  }),
  item("thread-timeout", "Escalation timeout", "timed_out", "2026-01-05T12:00:00.000Z", {
    sourceStepId: "step-beta",
  }),
  item("thread-decided-waiver", "waiver decision follow-up", "decided", "2026-01-04T12:00:00.000Z", {
    sourceStepId: "step-gamma",
    decision: decisionFor("accept_with_waiver"),
  }),
  item("thread-decided-retry", "retry decision follow-up", "decided", "2026-01-03T12:00:00.000Z", {
    sourceStepId: "step-delta",
    decision: decisionFor("retry_with_guidance"),
  }),
  item("thread-open-new", "Second OPEN escalation", "open", "2026-01-06T12:00:00.000Z", {
    sourceStepId: "step-epsilon",
  }),
];

describe("filterAndSortExceptionHuddles", () => {
  it("filters by exact huddle status", () => {
    const result = filterAndSortExceptionHuddles(FILTER_ITEMS, {
      status: "open",
      sortBy: "oldest",
    });

    expect(ids(result)).toEqual(["thread-open-old", "thread-open-new"]);
  });

  it("filters by exact decision kind and ignores undecided huddles", () => {
    const result = filterAndSortExceptionHuddles(FILTER_ITEMS, {
      decisionKind: "accept_with_waiver",
    });

    expect(ids(result)).toEqual(["thread-decided-waiver"]);
  });

  it("matches query case-insensitively against title, sourceStepId, and threadId", () => {
    expect(ids(filterAndSortExceptionHuddles(FILTER_ITEMS, { query: "WAIVER" }))).toEqual([
      "thread-decided-waiver",
    ]);
    expect(ids(filterAndSortExceptionHuddles(FILTER_ITEMS, { query: "STEP-BETA" }))).toEqual([
      "thread-timeout",
    ]);
    expect(ids(filterAndSortExceptionHuddles(FILTER_ITEMS, { query: "THREAD-OPEN-NEW" }))).toEqual([
      "thread-open-new",
    ]);
  });

  it("sorts urgent_first by status urgency, then newest updatedAt inside each status", () => {
    const scrambled = [
      item("decided-old", "Old decided", "decided", "2026-01-01T12:00:00.000Z"),
      item("open-old", "Old open", "open", "2026-01-02T12:00:00.000Z"),
      item("cancelled-new", "New cancelled", "cancelled", "2026-01-06T12:00:00.000Z"),
      item("timed-out-old", "Old timed out", "timed_out", "2026-01-03T12:00:00.000Z"),
      item("open-new", "New open", "open", "2026-01-04T12:00:00.000Z"),
      item("timed-out-new", "New timed out", "timed_out", "2026-01-05T12:00:00.000Z"),
      item("decided-new", "New decided", "decided", "2026-01-07T12:00:00.000Z"),
    ];

    const expected = [
      "timed-out-new",
      "timed-out-old",
      "open-new",
      "open-old",
      "decided-new",
      "decided-old",
      "cancelled-new",
    ];
    expect(ids(filterAndSortExceptionHuddles(scrambled, { sortBy: "urgent_first" }))).toEqual(expected);
    expect(ids(filterAndSortExceptionHuddles(scrambled))).toEqual(expected);
  });

  it("sorts newest by updatedAt descending", () => {
    const result = filterAndSortExceptionHuddles(FILTER_ITEMS, { sortBy: "newest" });

    expect(ids(result)).toEqual([
      "thread-open-new",
      "thread-timeout",
      "thread-decided-waiver",
      "thread-decided-retry",
      "thread-open-old",
    ]);
  });

  it("sorts oldest by updatedAt ascending", () => {
    const result = filterAndSortExceptionHuddles(FILTER_ITEMS, { sortBy: "oldest" });

    expect(ids(result)).toEqual([
      "thread-open-old",
      "thread-decided-retry",
      "thread-decided-waiver",
      "thread-timeout",
      "thread-open-new",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = Object.freeze([
      item("thread-b", "B", "open", "2026-01-02T12:00:00.000Z"),
      item("thread-a", "A", "timed_out", "2026-01-01T12:00:00.000Z"),
    ]);
    const before = JSON.stringify(input);

    const result = filterAndSortExceptionHuddles(input, { sortBy: "newest" });

    expect(result).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(ids(input)).toEqual(["thread-b", "thread-a"]);
  });
});
