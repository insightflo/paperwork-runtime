import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export type ExceptionHuddleNotificationEvent = "convened" | "timed_out" | "decided" | "cancelled";

export interface ExceptionHuddleNotificationPayload {
  event: ExceptionHuddleNotificationEvent;
  severity: "info" | "warning" | "urgent";
  title: string;
  body: string;
  deepLinkPath: string;
  metadata: {
    missionId: string;
    sourceStepId: string;
    threadId: string;
    channelId: string;
    round: number;
    maxRounds: number;
    decisionKind: string | null;
  };
}

type ExceptionHuddleDecision = NonNullable<ExceptionHuddleMetadata["decision"]>;

const TITLE_MAX_LENGTH = 140;
const BODY_MAX_LENGTH = 400;

const eventTitles: Record<ExceptionHuddleNotificationEvent, string> = {
  convened: "Exception huddle convened",
  timed_out: "Exception huddle timed out",
  decided: "Exception huddle decided",
  cancelled: "Exception huddle cancelled",
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function severityFor(
  event: ExceptionHuddleNotificationEvent,
  decision: ExceptionHuddleMetadata["decision"],
): ExceptionHuddleNotificationPayload["severity"] {
  if (event === "timed_out" || decision?.kind === "escalate") return "urgent";
  if (event === "convened") return "warning";
  return "info";
}

function decisionAction(decision: ExceptionHuddleDecision): string | null {
  switch (decision.kind) {
    case "retry_with_guidance":
      return decision.guidance ? `Guidance: ${decision.guidance}` : null;
    case "accept_with_waiver":
      return decision.waiverCondition ? `Waiver condition: ${decision.waiverCondition}` : null;
    case "replan_remaining":
      return decision.replanSummary ? `Replan summary: ${decision.replanSummary}` : null;
    case "escalate":
      return decision.escalationReason ? `Escalation reason: ${decision.escalationReason}` : null;
  }
}

function decisionDetail(decision: ExceptionHuddleDecision): string {
  return [
    `Decision: ${decision.kind}`,
    decisionAction(decision),
    `Rationale: ${decision.rationale}`,
  ].filter((part): part is string => part !== null).join(". ");
}

function eventSentence(event: ExceptionHuddleNotificationEvent): string {
  switch (event) {
    case "convened":
      return "The owner chair must submit a structured decision before the huddle timeout.";
    case "timed_out":
      return "The huddle timed out and the owner chair must submit a structured decision now.";
    case "decided":
      return "The huddle has a structured decision.";
    case "cancelled":
      return "The huddle is cancelled.";
  }
}

export function buildExceptionHuddleNotificationPayload(input: {
  event: ExceptionHuddleNotificationEvent;
  threadId: string;
  channelId: string;
  huddle: ExceptionHuddleMetadata;
  missionTitle?: string;
}): ExceptionHuddleNotificationPayload {
  const { event, threadId, channelId, huddle } = input;
  const label = normalizeText(input.missionTitle ?? "") || huddle.missionId;
  const decision = huddle.decision;
  const detail = decision ? decisionDetail(decision) : null;
  const bodySource = [
    `Mission ${huddle.missionId}; step ${huddle.sourceStepId}; round ${huddle.currentRound} of ${huddle.maxRounds}.`,
    eventSentence(event),
    detail,
  ].filter((part): part is string => part !== null).join(" ");
  const focus = event === "timed_out" ? "&focus=huddle-decision" : "";

  return {
    event,
    severity: severityFor(event, decision),
    title: boundedText(`${eventTitles[event]}: ${label}`, TITLE_MAX_LENGTH),
    body: boundedText(bodySource, BODY_MAX_LENGTH),
    deepLinkPath: `/channels?channelId=${encodeURIComponent(channelId)}&threadId=${encodeURIComponent(threadId)}${focus}`,
    metadata: {
      missionId: huddle.missionId,
      sourceStepId: huddle.sourceStepId,
      threadId,
      channelId,
      round: huddle.currentRound,
      maxRounds: huddle.maxRounds,
      decisionKind: decision?.kind ?? null,
    },
  };
}
