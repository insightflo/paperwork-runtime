import { describe, expect, it } from "vitest";
import {
  classifyQueueLane,
  selectNextQueuedRuns,
  type QueuedRunCandidate,
} from "../services/heartbeat-queue-fairness.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const SAME_TIME = "2026-01-01T11:59:00.000Z";

function run(id: string, input?: Partial<QueuedRunCandidate>): QueuedRunCandidate {
  return {
    id,
    createdAt: SAME_TIME,
    ...input,
  };
}

function ids(candidates: readonly QueuedRunCandidate[]) {
  return candidates.map((candidate) => candidate.id);
}

describe("classifyQueueLane", () => {
  it("classifies interactive, recovery, workflow, and scheduled lanes", () => {
    expect(classifyQueueLane({ invocationSource: "on_demand" })).toBe("interactive");
    expect(classifyQueueLane({ triggerDetail: "operator_mention" })).toBe("interactive");
    expect(classifyQueueLane({ triggerDetail: "unblock_owner" })).toBe("recovery");
    expect(classifyQueueLane({ contextSnapshot: { wakeReason: "qa_retry" } })).toBe("recovery");
    expect(classifyQueueLane({ invocationSource: "assignment" })).toBe("workflow");
    expect(classifyQueueLane({ contextSnapshot: { missionId: "mission-1" } })).toBe("workflow");
    expect(classifyQueueLane({ invocationSource: "timer" })).toBe("scheduled");
    expect(classifyQueueLane({})).toBe("scheduled");
  });

  it("prefers recovery and workflow signals over the scheduled fallback", () => {
    expect(classifyQueueLane({ invocationSource: "timer", contextSnapshot: { retryOfRunId: "run-1" } }))
      .toBe("recovery");
    expect(classifyQueueLane({ invocationSource: "timer", contextSnapshot: { workflowRunId: "workflow-1" } }))
      .toBe("workflow");
  });
});

describe("selectNextQueuedRuns", () => {
  it("orders lanes by priority for one, two, and four available slots", () => {
    const candidates = [
      run("scheduled", { invocationSource: "timer" }),
      run("workflow", { invocationSource: "assignment" }),
      run("recovery", { triggerDetail: "handoff_recovery" }),
      run("interactive", { invocationSource: "on_demand", triggerDetail: "manual" }),
    ];

    expect(ids(selectNextQueuedRuns(candidates, { availableSlots: 1, now: NOW }))).toEqual(["interactive"]);
    expect(ids(selectNextQueuedRuns(candidates, { availableSlots: 2, now: NOW })))
      .toEqual(["interactive", "recovery"]);
    expect(ids(selectNextQueuedRuns(candidates, { availableSlots: 4, now: NOW })))
      .toEqual(["interactive", "recovery", "workflow", "scheduled"]);
  });

  it("promotes a long-waiting scheduled run ahead of a brand-new interactive run", () => {
    const scheduled = run("old-scheduled", {
      createdAt: "2026-01-01T11:50:00.000Z",
      invocationSource: "timer",
    });
    const interactive = run("new-interactive", {
      createdAt: "2026-01-01T12:00:00.000Z",
      invocationSource: "on_demand",
    });

    expect(ids(selectNextQueuedRuns([interactive, scheduled], { availableSlots: 1, now: NOW })))
      .toEqual(["old-scheduled"]);
  });

  it("serializes the same issue while independent issues fill available slots", () => {
    const candidates = [
      run("active-issue-blocked", {
        invocationSource: "on_demand",
        issueId: "issue-active",
      }),
      run("same-issue-first", {
        invocationSource: "on_demand",
        issueId: "issue-c",
      }),
      run("same-issue-second", {
        invocationSource: "on_demand",
        issueId: "issue-c",
      }),
      run("independent-workflow", {
        invocationSource: "assignment",
        issueId: "issue-b",
      }),
    ];

    expect(ids(selectNextQueuedRuns(candidates, {
      availableSlots: 2,
      now: NOW,
      activeIssueIds: new Set(["issue-active"]),
    }))).toEqual(["same-issue-first", "independent-workflow"]);

    expect(ids(selectNextQueuedRuns([
      ...candidates,
      run("independent-interactive", { invocationSource: "on_demand", issueId: "issue-d" }),
    ], {
      availableSlots: 3,
      now: NOW,
      activeIssueIds: new Set(["issue-active"]),
    }))).toEqual(["independent-interactive", "same-issue-first", "independent-workflow"]);
  });

  it("returns no runs when there are no positive slots", () => {
    const candidates = [run("interactive", { invocationSource: "on_demand" })];
    expect(selectNextQueuedRuns(candidates, { availableSlots: 0, now: NOW })).toEqual([]);
    expect(selectNextQueuedRuns(candidates, { availableSlots: -2, now: NOW })).toEqual([]);
  });

  it("breaks ties deterministically by oldest creation time and then lexical id", () => {
    const older = run("z-older", {
      createdAt: "2026-01-01T11:00:00.000Z",
      invocationSource: "on_demand",
    });
    const lexicalMiddle = run("a-middle", {
      createdAt: SAME_TIME,
      invocationSource: "on_demand",
    });
    const lexicalLast = run("b-last", {
      createdAt: SAME_TIME,
      invocationSource: "on_demand",
    });

    expect(ids(selectNextQueuedRuns([lexicalLast, lexicalMiddle, older], { availableSlots: 3, now: NOW })))
      .toEqual(["z-older", "a-middle", "b-last"]);
    expect(ids(selectNextQueuedRuns([older, lexicalLast, lexicalMiddle], { availableSlots: 3, now: NOW })))
      .toEqual(["z-older", "a-middle", "b-last"]);
  });
});
