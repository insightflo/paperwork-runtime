export interface RunQueueSnapshotItem {
  id: string;
  agentId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  createdAt: Date | string;
  updatedAt?: Date | string | null;
  invocationSource?: string | null;
  issueId?: string | null;
}

export interface AgentSlotConfig {
  agentId: string;
  maxConcurrentRuns: number;
}

export interface AgentQueueTelemetry {
  agentId: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  utilizationRatio: number;
  saturated: boolean;
  oldestQueuedWaitMs: number;
  starvationWarning: boolean;
  distinctQueuedIssues: number;
}

export interface FleetQueueTelemetry {
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  saturatedAgents: number;
  starvingAgents: number;
  maxQueuedWaitMs: number;
  byAgent: AgentQueueTelemetry[];
}

const DEFAULT_STARVATION_WARNING_MS = 600_000;

interface AgentQueueAccumulator {
  agentId: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  oldestQueuedWaitMs: number;
  queuedIssueIds: Set<string>;
}

function normalizeMaxConcurrentRuns(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, value);
}

function toTimeMs(value: Date | string): number | null {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function createAccumulator(agentId: string, maxConcurrentRuns: number): AgentQueueAccumulator {
  return {
    agentId,
    maxConcurrentRuns,
    runningCount: 0,
    queuedCount: 0,
    oldestQueuedWaitMs: Number.NEGATIVE_INFINITY,
    queuedIssueIds: new Set<string>(),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function compareAgentIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function computeFleetQueueTelemetry(
  runs: readonly RunQueueSnapshotItem[],
  configs: readonly AgentSlotConfig[],
  opts: { now?: Date; starvationWarningMs?: number } = {},
): FleetQueueTelemetry {
  const nowMs = (opts.now ?? new Date()).getTime();
  const starvationWarningMs = opts.starvationWarningMs ?? DEFAULT_STARVATION_WARNING_MS;
  const agents = new Map<string, AgentQueueAccumulator>();

  for (const config of configs) {
    agents.set(
      config.agentId,
      createAccumulator(config.agentId, normalizeMaxConcurrentRuns(config.maxConcurrentRuns)),
    );
  }

  for (const run of runs) {
    if (run.status !== "queued" && run.status !== "running") continue;

    let agent = agents.get(run.agentId);
    if (!agent) {
      agent = createAccumulator(run.agentId, 1);
      agents.set(run.agentId, agent);
    }

    if (run.status === "running") {
      agent.runningCount += 1;
      continue;
    }

    agent.queuedCount += 1;
    const createdAtMs = toTimeMs(run.createdAt);
    if (createdAtMs !== null) {
      agent.oldestQueuedWaitMs = Math.max(agent.oldestQueuedWaitMs, nowMs - createdAtMs);
    }
    if (run.issueId != null) {
      agent.queuedIssueIds.add(run.issueId);
    }
  }

  const byAgent = Array.from(agents.values())
    .map((agent): AgentQueueTelemetry => {
      const oldestQueuedWaitMs =
        agent.queuedCount > 0 && agent.oldestQueuedWaitMs !== Number.NEGATIVE_INFINITY
          ? agent.oldestQueuedWaitMs
          : 0;
      return {
        agentId: agent.agentId,
        maxConcurrentRuns: agent.maxConcurrentRuns,
        runningCount: agent.runningCount,
        queuedCount: agent.queuedCount,
        utilizationRatio: round3(Math.min(1, agent.runningCount / agent.maxConcurrentRuns)),
        saturated: agent.runningCount >= agent.maxConcurrentRuns,
        oldestQueuedWaitMs,
        starvationWarning: agent.queuedCount > 0 && oldestQueuedWaitMs >= starvationWarningMs,
        distinctQueuedIssues: agent.queuedIssueIds.size,
      };
    })
    .sort(
      (a, b) =>
        b.queuedCount - a.queuedCount ||
        b.oldestQueuedWaitMs - a.oldestQueuedWaitMs ||
        compareAgentIds(a.agentId, b.agentId),
    );

  let totalSlots = 0;
  let totalRunning = 0;
  let totalQueued = 0;
  let saturatedAgents = 0;
  let starvingAgents = 0;
  let maxQueuedWaitMs = 0;

  for (const agent of byAgent) {
    totalSlots += agent.maxConcurrentRuns;
    totalRunning += agent.runningCount;
    totalQueued += agent.queuedCount;
    if (agent.saturated) saturatedAgents += 1;
    if (agent.starvationWarning) starvingAgents += 1;
    maxQueuedWaitMs = Math.max(maxQueuedWaitMs, agent.oldestQueuedWaitMs);
  }

  return {
    totalSlots,
    totalRunning,
    totalQueued,
    saturatedAgents,
    starvingAgents,
    maxQueuedWaitMs,
    byAgent,
  };
}
