/**
 * Pure, deterministic synthesizer for fleet queue health (stage46 W17).
 * Combines fleet slot utilization, starvation warnings, deadlock cycles, and
 * provider cooldown count into a single operational health status with a
 * concise Korean headline. No DB or runtime side effects: every output is
 * derived only from the numeric input snapshot, so callers can unit-test and
 * render it without a live control plane.
 */

export type FleetQueueHealthLevel = "healthy" | "degraded" | "critical";

export interface FleetQueueHealthInput {
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  saturatedAgents: number;
  starvingAgents: number;
  deadlockCycles: number;
  coolingDownProviders: number;
}

export interface FleetQueueHealthDigest {
  level: FleetQueueHealthLevel;
  headline: string;
  utilizationPercent: number;
  signals: string[];
}

const LEVEL_LABEL: Record<FleetQueueHealthLevel, string> = {
  healthy: "정상",
  degraded: "저하",
  critical: "위험",
};

export function synthesizeFleetQueueHealth(input: FleetQueueHealthInput): FleetQueueHealthDigest {
  const utilizationPercent = input.totalSlots > 0
    ? Math.min(100, Math.round((input.totalRunning / input.totalSlots) * 100))
    : 0;

  const hasDeadlockCycles = input.deadlockCycles > 0;
  const hasStarvingAgents = input.starvingAgents > 0;
  const hasCoolingDownProviders = input.coolingDownProviders > 0;
  const hasSaturatedBacklog = input.saturatedAgents > 0 && input.totalQueued > 0;

  // Signals are listed in severity order so the headline can lead with the
  // most operationally urgent condition.
  const signals: string[] = [];
  if (hasDeadlockCycles) signals.push(`순환 대기 ${input.deadlockCycles}건`);
  if (hasStarvingAgents) signals.push(`장기 대기 에이전트 ${input.starvingAgents}명`);
  if (hasCoolingDownProviders) signals.push(`프로바이더 쿨다운 ${input.coolingDownProviders}곳`);
  if (hasSaturatedBacklog) signals.push(`슬롯 포화 ${input.saturatedAgents}명 · 대기 ${input.totalQueued}건`);

  const level: FleetQueueHealthLevel = hasDeadlockCycles || hasStarvingAgents
    ? "critical"
    : hasCoolingDownProviders || hasSaturatedBacklog
      ? "degraded"
      : "healthy";

  // Empty signals exactly when healthy, so the two headline branches are
  // exhaustive; extra signals are folded into an "외 N개" suffix to keep the
  // headline glanceable while the signals array carries full detail.
  const headline = signals.length === 0
    ? `큐 ${LEVEL_LABEL.healthy} — 슬롯 가동률 ${utilizationPercent}%`
    : `큐 ${LEVEL_LABEL[level]} — ${signals[0]}${signals.length > 1 ? ` 외 ${signals.length - 1}개` : ""}`;

  return { level, headline, utilizationPercent, signals };
}
