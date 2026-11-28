import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export const EXCEPTION_HUDDLE_TIMEOUT_CHAIR_REASON = "exception_huddle_timeout_chair_decision_required" as const;

export interface ExceptionHuddleTimeoutChairWakeup {
  agentId: string;
  idempotencyKey: string;
  reason: typeof EXCEPTION_HUDDLE_TIMEOUT_CHAIR_REASON;
}

export type ExceptionHuddleTimeoutEvaluation =
  | { expired: false }
  | {
      expired: true;
      nextState: ExceptionHuddleMetadata;
      chairWakeup: ExceptionHuddleTimeoutChairWakeup;
    };

type MaybePromise<T> = T | Promise<T>;

export interface ExceptionHuddleTimeoutSweepDeps {
  listOpenHuddles: () => MaybePromise<readonly ExceptionHuddleMetadata[]>;
  markTimedOut: (nextState: ExceptionHuddleMetadata) => MaybePromise<boolean>;
  enqueueChairWakeup: (wakeup: ExceptionHuddleTimeoutChairWakeup) => MaybePromise<unknown>;
}

export interface ExceptionHuddleTimeoutSweepResult {
  scanned: number;
  timedOut: number;
  wakeupsEnqueued: number;
  skipped: number;
}

export function evaluateHuddleTimeout(
  huddle: ExceptionHuddleMetadata,
  now: Date,
): ExceptionHuddleTimeoutEvaluation {
  if (huddle.status !== "open" || now.getTime() < Date.parse(huddle.timeoutAt)) {
    return { expired: false };
  }
  return {
    expired: true,
    nextState: { ...huddle, status: "timed_out" },
    chairWakeup: {
      agentId: huddle.participants.ownerAgentId,
      idempotencyKey: `huddle-timeout-chair:${huddle.workflowRunId}:${huddle.sourceStepId}:${huddle.timeoutAt}`,
      reason: EXCEPTION_HUDDLE_TIMEOUT_CHAIR_REASON,
    },
  };
}

export async function sweepTimedOutExceptionHuddles(
  deps: ExceptionHuddleTimeoutSweepDeps,
  now: Date,
): Promise<ExceptionHuddleTimeoutSweepResult> {
  const result: ExceptionHuddleTimeoutSweepResult = {
    scanned: 0,
    timedOut: 0,
    wakeupsEnqueued: 0,
    skipped: 0,
  };
  const openHuddles = await deps.listOpenHuddles();
  for (const huddle of openHuddles) {
    result.scanned += 1;
    const evaluation = evaluateHuddleTimeout(huddle, now);
    if (!evaluation.expired) {
      result.skipped += 1;
      continue;
    }
    const transitioned = await deps.markTimedOut(evaluation.nextState);
    if (!transitioned) {
      result.skipped += 1;
      continue;
    }
    result.timedOut += 1;
    await deps.enqueueChairWakeup(evaluation.chairWakeup);
    result.wakeupsEnqueued += 1;
  }
  return result;
}
