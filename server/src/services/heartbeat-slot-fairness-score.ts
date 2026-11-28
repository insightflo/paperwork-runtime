export interface AgentThroughputSample {
  agentId: string;
  completedRuns: number;
  queuedRuns: number;
}

export interface FleetFairnessScore {
  jainIndex: number;
  rating: "balanced" | "skewed" | "monopolized";
  dominantAgentId: string | null;
  starvedAgentIds: string[];
}

export function computeJainFairnessIndex(values: readonly number[]): number {
  if (values.length === 0) return 1;

  const normalized = values.map((value) => Math.max(0, value));
  const sum = normalized.reduce((total, value) => total + value, 0);
  if (sum === 0) return 1;

  const sumOfSquares = normalized.reduce((total, value) => total + value * value, 0);
  const index = (sum * sum) / (normalized.length * sumOfSquares);
  return Math.round(index * 1000) / 1000;
}

export function evaluateFleetFairness(samples: readonly AgentThroughputSample[]): FleetFairnessScore {
  const jainIndex = computeJainFairnessIndex(samples.map((sample) => sample.completedRuns));
  const rating = jainIndex >= 0.8 ? "balanced" : jainIndex >= 0.5 ? "skewed" : "monopolized";

  let dominantAgentId: string | null = null;
  let dominantCompletedRuns = 0;
  for (const sample of samples) {
    if (sample.completedRuns <= 0) continue;
    if (
      sample.completedRuns > dominantCompletedRuns ||
      (sample.completedRuns === dominantCompletedRuns &&
        (dominantAgentId === null || sample.agentId < dominantAgentId))
    ) {
      dominantAgentId = sample.agentId;
      dominantCompletedRuns = sample.completedRuns;
    }
  }

  const starvedAgentIds = samples
    .filter((sample) => sample.completedRuns === 0 && sample.queuedRuns > 0)
    .map((sample) => sample.agentId)
    .sort();

  return {
    jainIndex,
    rating,
    dominantAgentId,
    starvedAgentIds,
  };
}
