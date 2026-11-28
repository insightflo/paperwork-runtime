import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export interface ActiveHuddleCandidate {
  threadId: string;
  channelId: string;
  huddle: ExceptionHuddleMetadata;
}

export type ExceptionHuddleReopenDecision =
  | { allowed: true }
  | {
    allowed: false;
    reason: "duplicate_active_huddle";
    existingThreadId: string;
    existingChannelId: string;
    existingStatus: "open" | "timed_out";
  };

type ActiveStatusHuddleCandidate = ActiveHuddleCandidate & {
  huddle: ExceptionHuddleMetadata & { status: "open" | "timed_out" };
};

function isActiveStatusCandidate(candidate: ActiveHuddleCandidate): candidate is ActiveStatusHuddleCandidate {
  return candidate.huddle.status === "open" || candidate.huddle.status === "timed_out";
}

function matchesTarget(
  target: { missionId: string; sourceStepId: string; workflowRunId?: string },
  candidate: ActiveHuddleCandidate,
): boolean {
  const huddle = candidate.huddle;
  return huddle.missionId === target.missionId
    && huddle.sourceStepId === target.sourceStepId
    && (target.workflowRunId === undefined || huddle.workflowRunId === target.workflowRunId);
}

function duplicateActiveHuddle(candidate: ActiveStatusHuddleCandidate): ExceptionHuddleReopenDecision {
  return {
    allowed: false,
    reason: "duplicate_active_huddle",
    existingThreadId: candidate.threadId,
    existingChannelId: candidate.channelId,
    existingStatus: candidate.huddle.status,
  };
}

export function evaluateExceptionHuddleReopenGuard(
  target: { missionId: string; sourceStepId: string; workflowRunId?: string },
  existing: readonly ActiveHuddleCandidate[],
): ExceptionHuddleReopenDecision {
  let firstOpen: ActiveStatusHuddleCandidate | undefined;
  for (const candidate of existing) {
    if (!matchesTarget(target, candidate) || !isActiveStatusCandidate(candidate)) continue;
    if (candidate.huddle.status === "timed_out") return duplicateActiveHuddle(candidate);
    firstOpen ??= candidate;
  }
  return firstOpen ? duplicateActiveHuddle(firstOpen) : { allowed: true };
}
