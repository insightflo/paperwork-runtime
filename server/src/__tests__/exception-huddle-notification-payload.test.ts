import { describe, expect, it } from "vitest";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import {
  buildExceptionHuddleNotificationPayload,
  type ExceptionHuddleNotificationEvent,
} from "../services/missions/exception-huddle-notification-payload.js";

type Decision = NonNullable<ExceptionHuddleMetadata["decision"]>;

function decisionFor(kind: Decision["kind"], actionText = `Action for ${kind}`): Decision {
  const common = { rationale: `Rationale for ${kind}`, forcedByChair: false };
  switch (kind) {
    case "retry_with_guidance":
      return { ...common, kind, guidance: actionText };
    case "accept_with_waiver":
      return { ...common, kind, waiverCondition: actionText };
    case "replan_remaining":
      return { ...common, kind, replanSummary: actionText };
    case "escalate":
      return { ...common, kind, escalationReason: actionText };
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

function payloadFor(
  event: ExceptionHuddleNotificationEvent,
  huddle: ExceptionHuddleMetadata,
  overrides: { threadId?: string; channelId?: string; missionTitle?: string } = {},
) {
  return buildExceptionHuddleNotificationPayload({
    event,
    threadId: overrides.threadId ?? "thread-1",
    channelId: overrides.channelId ?? "channel-1",
    huddle,
    missionTitle: overrides.missionTitle ?? "Mission Alpha",
  });
}

describe("buildExceptionHuddleNotificationPayload", () => {
  it.each([
    ["convened", "warning", "Exception huddle convened", null],
    ["timed_out", "urgent", "Exception huddle timed out", null],
    ["decided", "info", "Exception huddle decided", "retry_with_guidance"],
    ["cancelled", "info", "Exception huddle cancelled", null],
  ] as const)("builds the %s event contract", (event, severity, titlePrefix, decisionKind) => {
    const huddle = metadata({
      status: event === "convened" ? "open" : event,
      decision: decisionKind ? decisionFor(decisionKind) : null,
    });

    const payload = payloadFor(event, huddle);

    expect(payload).toMatchObject({
      event,
      severity,
      deepLinkPath:
        event === "timed_out"
          ? "/channels?channelId=channel-1&threadId=thread-1&focus=huddle-decision"
          : "/channels?channelId=channel-1&threadId=thread-1",
    });
    expect(payload.title).toBe(`${titlePrefix}: Mission Alpha`);
    expect(payload.body).toContain("Mission mission-1; step step-qa; round 1 of 2.");
    expect(payload.metadata).toEqual({
      missionId: "mission-1",
      sourceStepId: "step-qa",
      threadId: "thread-1",
      channelId: "channel-1",
      round: 1,
      maxRounds: 2,
      decisionKind,
    });
  });

  it("uses urgent severity for timed_out and for an escalate decision", () => {
    expect(payloadFor("timed_out", metadata({ status: "timed_out" })).severity).toBe("urgent");
    expect(payloadFor("decided", metadata({
      status: "decided",
      decision: decisionFor("escalate"),
    }))).toMatchObject({
      severity: "urgent",
      metadata: { decisionKind: "escalate" },
    });
    expect(payloadFor("decided", metadata({
      status: "decided",
      decision: decisionFor("retry_with_guidance"),
    })).severity).toBe("info");
  });

  it.each([
    ["retry_with_guidance", "Retry with the corrected evidence"],
    ["accept_with_waiver", "Accept only for this mission"],
    ["replan_remaining", "Replan the remaining workflow"],
    ["escalate", "Owner judgment is required"],
  ] as const)("includes the %s action detail without reparsing text", (kind, actionText) => {
    const payload = payloadFor("decided", metadata({
      status: "decided",
      decision: decisionFor(kind, actionText),
    }));

    expect(payload.body).toContain(`Decision: ${kind}`);
    expect(payload.body).toContain(actionText);
    expect(payload.body).toContain(`Rationale for ${kind}`);
  });

  it("URL-encodes identifiers and adds the decision focus only for timed_out", () => {
    const threadId = "thread/with spaces?&=";
    const channelId = "channel#with unicode 한글";
    const encodedThread = encodeURIComponent(threadId);
    const encodedChannel = encodeURIComponent(channelId);
    const timedOut = payloadFor("timed_out", metadata({ status: "timed_out" }), { threadId, channelId });
    const decided = payloadFor("decided", metadata({
      status: "decided",
      decision: decisionFor("retry_with_guidance"),
    }), { threadId, channelId });

    expect(timedOut.deepLinkPath).toBe(
      `/channels?channelId=${encodedChannel}&threadId=${encodedThread}&focus=huddle-decision`,
    );
    expect(decided.deepLinkPath).toBe(`/channels?channelId=${encodedChannel}&threadId=${encodedThread}`);
    expect(decided.deepLinkPath).not.toContain("focus=huddle-decision");
  });

  it("truncates a very long mission title at the title boundary", () => {
    const missionTitle = `Mission ${"x".repeat(300)}`;

    const payload = payloadFor("convened", metadata(), { missionTitle });

    expect(payload.title).toHaveLength(140);
    expect(payload.title.endsWith("...")).toBe(true);
    expect(payload.body.length).toBeLessThanOrEqual(400);
  });

  it("truncates very long decision guidance at the body boundary", () => {
    const guidance = `Fix the evidence ${"x".repeat(500)}`;

    const payload = payloadFor("decided", metadata({
      status: "decided",
      decision: decisionFor("retry_with_guidance", guidance),
    }));

    expect(payload.body).toHaveLength(400);
    expect(payload.body.endsWith("...")).toBe(true);
  });

  it("does not mutate frozen input or nested huddle metadata", () => {
    const decision = decisionFor("escalate");
    const huddle = metadata({ status: "decided", decision });
    const input = {
      event: "decided" as const,
      threadId: "thread-frozen",
      channelId: "channel-frozen",
      huddle,
      missionTitle: "Frozen mission",
    };
    Object.freeze(decision);
    Object.freeze(huddle.participants);
    Object.freeze(huddle.workProductLinks);
    Object.freeze(huddle);
    Object.freeze(input);
    const before = JSON.stringify(input);

    const payload = buildExceptionHuddleNotificationPayload(input);

    expect(payload.metadata.decisionKind).toBe("escalate");
    expect(JSON.stringify(input)).toBe(before);
  });
});
