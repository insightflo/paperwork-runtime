export interface AgentSlotTelemetryEntry {
  agentId: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  utilizationRatio: number;
  saturated: boolean;
  oldestQueuedWaitMs: number;
  starvationWarning: boolean;
}

export function indexAgentSlotTelemetry(
  entries: readonly AgentSlotTelemetryEntry[],
): ReadonlyMap<string, AgentSlotTelemetryEntry> {
  const indexed = new Map<string, AgentSlotTelemetryEntry>();
  for (const entry of entries) {
    indexed.set(entry.agentId, entry);
  }
  return indexed;
}

export function getAgentSlotUsage(
  map: ReadonlyMap<string, AgentSlotTelemetryEntry>,
  agentId: string,
  fallbackMaxSlots?: number,
): {
  runningCount: number;
  maxConcurrentRuns: number;
  queuedCount: number;
  starving: boolean;
} {
  const entry = map.get(agentId);
  if (entry) {
    return {
      runningCount: entry.runningCount,
      maxConcurrentRuns: entry.maxConcurrentRuns,
      queuedCount: entry.queuedCount,
      starving: entry.starvationWarning,
    };
  }

  return {
    runningCount: 0,
    maxConcurrentRuns: Math.max(1, fallbackMaxSlots ?? 1),
    queuedCount: 0,
    starving: false,
  };
}

function compareStringsAscending(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumbersDescending(left: number, right: number): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

export function sortAgentsByQueuePressure<T extends { id: string; name?: string }>(
  agents: readonly T[],
  map: ReadonlyMap<string, AgentSlotTelemetryEntry>,
): T[] {
  return [...agents].sort((leftAgent, rightAgent) => {
    const left = map.get(leftAgent.id);
    const right = map.get(rightAgent.id);

    const leftStarving = left?.starvationWarning ?? false;
    const rightStarving = right?.starvationWarning ?? false;
    if (leftStarving !== rightStarving) return leftStarving ? -1 : 1;

    const byQueuedCount = compareNumbersDescending(
      left?.queuedCount ?? 0,
      right?.queuedCount ?? 0,
    );
    if (byQueuedCount !== 0) return byQueuedCount;

    const byRunningCount = compareNumbersDescending(
      left?.runningCount ?? 0,
      right?.runningCount ?? 0,
    );
    if (byRunningCount !== 0) return byRunningCount;

    const byName = compareStringsAscending(
      leftAgent.name ?? leftAgent.id,
      rightAgent.name ?? rightAgent.id,
    );
    if (byName !== 0) return byName;

    return compareStringsAscending(leftAgent.id, rightAgent.id);
  });
}
