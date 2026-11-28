import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export interface ExceptionHuddleTelemetrySummary {
  total: number;
  byStatus: {
    open: number;
    timed_out: number;
    decided: number;
    cancelled: number;
  };
  byDecisionKind: {
    retry_with_guidance: number;
    accept_with_waiver: number;
    replan_remaining: number;
    escalate: number;
  };
  byFailureKind: Record<string, number>;
  averageRoundsOnDecided: number | null;
  timeoutRate: number;
  chairForcedDecisionCount: number;
  resolutionRate: number;
}

type StructuredFailureFields = {
  failureKind?: unknown;
  triggerKind?: unknown;
};

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function failureKindKey(huddle: ExceptionHuddleMetadata): string | null {
  const fields = huddle as ExceptionHuddleMetadata & StructuredFailureFields;
  for (const value of [fields.failureKind, fields.triggerKind]) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

export function computeExceptionHuddleTelemetry(
  huddles: readonly ExceptionHuddleMetadata[],
): ExceptionHuddleTelemetrySummary {
  const byStatus = { open: 0, timed_out: 0, decided: 0, cancelled: 0 };
  const byDecisionKind = {
    retry_with_guidance: 0,
    accept_with_waiver: 0,
    replan_remaining: 0,
    escalate: 0,
  };
  const failureCounts = new Map<string, number>();
  let decidedRounds = 0;
  let chairForcedDecisionCount = 0;

  for (const huddle of huddles) {
    byStatus[huddle.status] += 1;

    const failureKey = failureKindKey(huddle);
    if (failureKey) failureCounts.set(failureKey, (failureCounts.get(failureKey) ?? 0) + 1);

    if (huddle.status !== "decided") continue;
    decidedRounds += huddle.currentRound;
    if (!huddle.decision) continue;
    byDecisionKind[huddle.decision.kind] += 1;
    if (huddle.decision.forcedByChair) chairForcedDecisionCount += 1;
  }

  const total = huddles.length;
  const decided = byStatus.decided;
  return {
    total,
    byStatus,
    byDecisionKind,
    byFailureKind: Object.fromEntries(failureCounts),
    averageRoundsOnDecided: decided === 0 ? null : roundTo(decidedRounds / decided, 2),
    timeoutRate: total === 0 ? 0 : roundTo(byStatus.timed_out / total, 4),
    chairForcedDecisionCount,
    resolutionRate: total === 0 ? 0 : roundTo(decided / total, 4),
  };
}
