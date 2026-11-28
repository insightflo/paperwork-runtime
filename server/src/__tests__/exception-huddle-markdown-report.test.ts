import { describe, expect, it } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  renderExceptionHuddleGovernanceReport,
  type ExceptionHuddleReportItem,
} from "../services/missions/exception-huddle-markdown-report.js";

function metadata(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return {
    schemaVersion: "workflow.exception-huddle.v1",
    missionId: "mission-1",
    workflowRunId: "run-1",
    sourceStepId: "step-1",
    sourceIssueId: null,
    workProductLinks: [],
    participants: {
      ownerAgentId: "owner-agent",
      producerAgentId: "producer-agent",
      validatorAgentId: "validator-agent",
    },
    maxRounds: 2,
    currentRound: 1,
    timeoutAt: "2026-11-28T01:05:00.000Z",
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function item(index: number, overrides: Partial<ExceptionHuddleReportItem> = {}): ExceptionHuddleReportItem {
  return {
    threadId: `thread-${index}`,
    title: `Huddle ${index}`,
    updatedAt: `2026-11-28T01:${String(index).padStart(2, "0")}:00.000Z`,
    huddle: metadata(),
    ...overrides,
  };
}

describe("renderExceptionHuddleGovernanceReport", () => {
  it("renders the exact heading, zero counts, and empty notice without a table", () => {
    expect(renderExceptionHuddleGovernanceReport({ items: [] })).toBe([
      "# Exception Huddle Governance Summary",
      "",
      "Total: 0 | Open: 0 | Timed Out: 0 | Decided: 0 | Cancelled: 0",
      "",
      "No exception huddles recorded.",
    ].join("\n"));
  });

  it("includes the mission title and exact mixed status and decision counts", () => {
    const report = renderExceptionHuddleGovernanceReport({
      missionTitle: "Recover workflow",
      items: [
        item(1),
        item(2, { huddle: metadata({ status: "timed_out", currentRound: 2 }) }),
        item(3, {
          huddle: metadata({
            status: "decided",
            decision: {
              kind: "retry_with_guidance",
              rationale: "The evidence needs one correction.",
              guidance: "Correct the evidence reference.",
              forcedByChair: false,
            },
            decidedByAgentId: "owner-agent",
            decidedAt: "2026-11-28T01:03:00.000Z",
          }),
        }),
        item(4, {
          huddle: metadata({
            status: "decided",
            decision: {
              kind: "escalate",
              rationale: "The conflict needs an operator.",
              escalationReason: "The evidence conflict remains unresolved.",
              forcedByChair: true,
            },
            decidedByAgentId: "owner-agent",
            decidedAt: "2026-11-28T01:04:00.000Z",
          }),
        }),
        item(5, { huddle: metadata({ status: "cancelled" }) }),
      ],
    });

    expect(report).toContain("# Exception Huddle Governance Summary");
    expect(report).toContain("Mission: Recover workflow");
    expect(report).toContain("Total: 5 | Open: 1 | Timed Out: 1 | Decided: 2 | Cancelled: 1");
    expect(report).toContain("| Thread | Status | Round | Decision | Updated |");
    expect(report).toContain("| Huddle 1 (thread-1) | open | 1/2 | - | 2026-11-28T01:01:00.000Z |");
    expect(report).toContain("| Huddle 2 (thread-2) | timed_out | 2/2 | - | 2026-11-28T01:02:00.000Z |");
    expect(report).toContain("| Huddle 3 (thread-3) | decided | 1/2 | retry_with_guidance | 2026-11-28T01:03:00.000Z |");
    expect(report).toContain("| Huddle 4 (thread-4) | decided | 1/2 | escalate | 2026-11-28T01:04:00.000Z |");
    expect(report).toContain("| Huddle 5 (thread-5) | cancelled | 1/2 | - | 2026-11-28T01:05:00.000Z |");
  });

  it("escapes pipes and replaces newlines inside table titles", () => {
    const report = renderExceptionHuddleGovernanceReport({
      items: [item(1, { title: "Bad | title\nwith newline\r\nand more" })],
    });

    expect(report).toContain("Bad \\| title<br>with newline<br>and more (thread-1)");
    expect(report).not.toContain("Bad | title");
    const row = report.split("\n").find((line) => line.includes("Bad"));
    expect(row).toBeDefined();
    expect(row?.startsWith("| ")).toBe(true);
    expect(row?.endsWith(" |")).toBe(true);
  });

  it("caps rows at maxItems and reports the exact overflow count", () => {
    const report = renderExceptionHuddleGovernanceReport({
      items: [item(1), item(2), item(3)],
      maxItems: 2,
    });

    expect(report).toContain("Huddle 1 (thread-1)");
    expect(report).toContain("Huddle 2 (thread-2)");
    expect(report).not.toContain("Huddle 3 (thread-3)");
    expect(report).toContain("... and 1 more");
  });

  it("uses the default cap of fifty rows", () => {
    const report = renderExceptionHuddleGovernanceReport({
      items: Array.from({ length: 51 }, (_, index) => item(index + 1)),
    });

    expect(report).toContain("Huddle 50 (thread-50)");
    expect(report).not.toContain("Huddle 51 (thread-51)");
    expect(report).toContain("... and 1 more");
  });

  it("does not mutate frozen input, items, or huddle metadata", () => {
    const huddle = Object.freeze(metadata({
      status: "decided",
      decision: Object.freeze({
        kind: "escalate" as const,
        rationale: "Owner escalation is required.",
        escalationReason: "The evidence conflict remains unresolved.",
        forcedByChair: true,
      }),
    }));
    const reportItem = Object.freeze(item(1, { huddle }));
    const items = Object.freeze([reportItem]);
    const input = Object.freeze({ missionTitle: "Frozen", items, maxItems: 1 });
    const before = JSON.stringify(input);

    const report = renderExceptionHuddleGovernanceReport(input);

    expect(report).toContain("escalate");
    expect(JSON.stringify(input)).toBe(before);
  });
});
