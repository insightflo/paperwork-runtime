import { describe, expect, it } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  escapeCsvCell,
  exportExceptionHuddlesToCsv,
  type ExceptionHuddleCsvRow,
} from "../services/missions/exception-huddle-csv-export.js";

const HEADER = "threadId,channelId,missionId,sourceStepId,status,round,maxRounds,decisionKind,title,updatedAt";

type Decision = NonNullable<ExceptionHuddleMetadata["decision"]>;
type Status = ExceptionHuddleMetadata["status"];

function decisionFor(kind: Decision["kind"]): Decision {
  const common = { rationale: `Rationale for ${kind}`, forcedByChair: false };
  switch (kind) {
    case "retry_with_guidance":
      return { ...common, kind, guidance: "Correct the evidence and retry" };
    case "accept_with_waiver":
      return { ...common, kind, waiverCondition: "Accept only for this mission" };
    case "replan_remaining":
      return { ...common, kind, replanSummary: "Replan the remaining workflow" };
    case "escalate":
      return { ...common, kind, escalationReason: "Owner judgment is required" };
  }
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
    timeoutAt: "2026-11-28T01:05:00.000Z",
    status: "open",
    decision: null,
    decidedByAgentId: null,
    decidedAt: null,
    ...overrides,
  };
}

function rowFor(
  suffix: string,
  status: Status,
  decision: Decision | null,
  currentRound = 1,
): ExceptionHuddleCsvRow {
  return {
    threadId: `thread-${suffix}`,
    channelId: `channel-${suffix}`,
    title: `Review ${suffix}`,
    updatedAt: `2026-11-28T02:00:${suffix.length.toString().padStart(2, "0")}.000Z`,
    huddle: metadata({
      missionId: `mission-${suffix}`,
      sourceStepId: `step-${suffix}`,
      status,
      currentRound,
      decision,
    }),
  };
}

describe("escapeCsvCell", () => {
  it.each([
    ["plain", "plain"],
    ["comma,value", '"comma,value"'],
    ['quote"value', '"quote""value"'],
    ["line\nbreak", '"line\nbreak"'],
    ["carriage\rreturn", '"carriage\rreturn"'],
    ["crlf\r\nbreak", '"crlf\r\nbreak"'],
  ])("RFC 4180 escapes %j", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it.each([
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+cmd", "'+cmd"],
    ["-1+1", "'-1+1"],
    ["@HYPERLINK", "'@HYPERLINK"],
    ["\t=cmd", "'\t=cmd"],
    ["\r=cmd", "\"'\r=cmd\""],
  ])("neutralizes spreadsheet formula input %j", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it("serializes empty and primitive values", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell(0)).toBe("0");
    expect(escapeCsvCell(false)).toBe("false");
  });
});

describe("exportExceptionHuddlesToCsv", () => {
  it("emits only the CRLF-terminated header for empty rows", () => {
    expect(exportExceptionHuddlesToCsv([])).toBe(`${HEADER}\r\n`);
  });

  it("exports statuses, rounds, and decision kinds in the specified column order", () => {
    const rows = [
      rowFor("open", "open", null),
      rowFor("timeout", "timed_out", null, 2),
      rowFor("cancel", "cancelled", null, 2),
      rowFor("retry", "decided", decisionFor("retry_with_guidance"), 2),
      rowFor("waive", "decided", decisionFor("accept_with_waiver"), 1),
      rowFor("replan", "decided", decisionFor("replan_remaining"), 2),
      rowFor("escalate", "decided", decisionFor("escalate"), 1),
    ];

    expect(exportExceptionHuddlesToCsv(rows).split("\r\n")).toEqual([
      HEADER,
      "thread-open,channel-open,mission-open,step-open,open,1,2,,Review open,2026-11-28T02:00:04.000Z",
      "thread-timeout,channel-timeout,mission-timeout,step-timeout,timed_out,2,2,,Review timeout,2026-11-28T02:00:07.000Z",
      "thread-cancel,channel-cancel,mission-cancel,step-cancel,cancelled,2,2,,Review cancel,2026-11-28T02:00:06.000Z",
      "thread-retry,channel-retry,mission-retry,step-retry,decided,2,2,retry_with_guidance,Review retry,2026-11-28T02:00:05.000Z",
      "thread-waive,channel-waive,mission-waive,step-waive,decided,1,2,accept_with_waiver,Review waive,2026-11-28T02:00:05.000Z",
      "thread-replan,channel-replan,mission-replan,step-replan,decided,2,2,replan_remaining,Review replan,2026-11-28T02:00:06.000Z",
      "thread-escalate,channel-escalate,mission-escalate,step-escalate,decided,1,2,escalate,Review escalate,2026-11-28T02:00:08.000Z",
      "",
    ]);
  });

  it("preserves embedded commas, quotes, and newlines inside quoted cells", () => {
    const row: ExceptionHuddleCsvRow = {
      threadId: 'thread,"one"',
      channelId: "channel\none",
      title: 'title, "quoted"\nnext',
      updatedAt: "2026-11-28T03:04:05.000Z",
      huddle: metadata({
        missionId: "mission-escape",
        sourceStepId: "step\r\nqa",
      }),
    };

    expect(exportExceptionHuddlesToCsv([row])).toBe(
      `${HEADER}\r\n` +
      '"thread,""one""","channel\none",mission-escape,"step\r\nqa",open,1,2,,' +
      '"title, ""quoted""\nnext",2026-11-28T03:04:05.000Z\r\n',
    );
  });

  it("neutralizes formula-leading values in every exported cell", () => {
    const row: ExceptionHuddleCsvRow = {
      threadId: "=thread",
      channelId: "+channel",
      title: "@title",
      updatedAt: "-updated",
      huddle: metadata({
        missionId: "=mission",
        sourceStepId: "+step",
      }),
    };

    expect(exportExceptionHuddlesToCsv([row])).toBe(
      `${HEADER}\r\n'=thread,'+channel,'=mission,'+step,open,1,2,,'@title,'-updated\r\n`,
    );
  });

  it("does not mutate frozen rows or nested huddle metadata", () => {
    const row = rowFor("frozen", "decided", decisionFor("escalate"), 2);
    const rows = Object.freeze([row]);
    Object.freeze(row.huddle.participants);
    Object.freeze(row.huddle.workProductLinks);
    Object.freeze(row.huddle.decision);
    Object.freeze(row.huddle);
    Object.freeze(row);
    const before = JSON.stringify(rows);

    expect(exportExceptionHuddlesToCsv(rows)).toContain("thread-frozen");
    expect(JSON.stringify(rows)).toBe(before);
  });
});
