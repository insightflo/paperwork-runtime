export interface AgentQueueTelemetryRow {
  agentId: string;
  agentName: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  utilizationRatio: number;
  saturated: boolean;
  oldestQueuedWaitMs: number;
  starvationWarning: boolean;
  distinctQueuedIssues: number;
}

export interface FleetQueueTelemetryResponse {
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  saturatedAgents: number;
  starvingAgents: number;
  maxQueuedWaitMs: number;
  byAgent: AgentQueueTelemetryRow[];
}

const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const MAX_CONCURRENT_RUNS_LIMIT = 10;
const DEFAULT_STARVATION_WARNING_MS = 600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundTo3Decimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function timestampMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function queuedWaitMs(createdAt: Date | string, nowMs: number): number {
  const createdMs = timestampMs(createdAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, nowMs - createdMs);
}

export function extractMaxConcurrentRuns(runtimeConfig: unknown): number {
  if (!isRecord(runtimeConfig) || !isRecord(runtimeConfig.heartbeat)) {
    return DEFAULT_MAX_CONCURRENT_RUNS;
  }
  const value = runtimeConfig.heartbeat.maxConcurrentRuns;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_CONCURRENT_RUNS;
  }
  return Math.max(
    DEFAULT_MAX_CONCURRENT_RUNS,
    Math.min(MAX_CONCURRENT_RUNS_LIMIT, Math.floor(value)),
  );
}

export function buildFleetQueueTelemetryResponse(input: {
  agents: ReadonlyArray<{ id: string; name: string; status: string; runtimeConfig: unknown }>;
  activeRuns: ReadonlyArray<{
    id: string;
    agentId: string;
    status: string;
    createdAt: Date | string;
    issueId?: string | null;
  }>;
  now?: Date;
  starvationWarningMs?: number;
}): FleetQueueTelemetryResponse {
  const nowMs = (input.now ?? new Date()).getTime();
  const starvationWarningMs = input.starvationWarningMs ?? DEFAULT_STARVATION_WARNING_MS;
  const runsByAgent = new Map<string, {
    runningCount: number;
    queuedCount: number;
    oldestQueuedWaitMs: number;
    queuedIssueIds: Set<string>;
  }>();

  for (const run of input.activeRuns) {
    if (run.status !== "running" && run.status !== "queued") continue;
    let aggregate = runsByAgent.get(run.agentId);
    if (!aggregate) {
      aggregate = {
        runningCount: 0,
        queuedCount: 0,
        oldestQueuedWaitMs: 0,
        queuedIssueIds: new Set<string>(),
      };
      runsByAgent.set(run.agentId, aggregate);
    }

    if (run.status === "running") {
      aggregate.runningCount += 1;
      continue;
    }

    aggregate.queuedCount += 1;
    aggregate.oldestQueuedWaitMs = Math.max(
      aggregate.oldestQueuedWaitMs,
      queuedWaitMs(run.createdAt, nowMs),
    );
    if (run.issueId) aggregate.queuedIssueIds.add(run.issueId);
  }

  let totalSlots = 0;
  const byAgent = input.agents.flatMap((agent): AgentQueueTelemetryRow[] => {
    const aggregate = runsByAgent.get(agent.id);
    const runningCount = aggregate?.runningCount ?? 0;
    const queuedCount = aggregate?.queuedCount ?? 0;
    const oldestQueuedWaitMs = aggregate?.oldestQueuedWaitMs ?? 0;
    const maxConcurrentRuns = extractMaxConcurrentRuns(agent.runtimeConfig);
    if (agent.status === "terminated" && runningCount === 0 && queuedCount === 0) return [];
    totalSlots += maxConcurrentRuns;

    return [{
      agentId: agent.id,
      agentName: agent.name,
      maxConcurrentRuns,
      runningCount,
      queuedCount,
      utilizationRatio: roundTo3Decimals(Math.min(1, runningCount / maxConcurrentRuns)),
      saturated: runningCount >= maxConcurrentRuns,
      oldestQueuedWaitMs,
      starvationWarning: queuedCount > 0 && oldestQueuedWaitMs >= starvationWarningMs,
      distinctQueuedIssues: aggregate?.queuedIssueIds.size ?? 0,
    }];
  });

  byAgent.sort((left, right) =>
    right.queuedCount - left.queuedCount
    || right.oldestQueuedWaitMs - left.oldestQueuedWaitMs
    || left.agentName.localeCompare(right.agentName)
    || left.agentId.localeCompare(right.agentId)
  );

  return {
    totalSlots,
    totalRunning: byAgent.reduce((total, row) => total + row.runningCount, 0),
    totalQueued: byAgent.reduce((total, row) => total + row.queuedCount, 0),
    saturatedAgents: byAgent.filter((row) => row.saturated).length,
    starvingAgents: byAgent.filter((row) => row.starvationWarning).length,
    maxQueuedWaitMs: byAgent.reduce((max, row) => Math.max(max, row.oldestQueuedWaitMs), 0),
    byAgent,
  };
}
