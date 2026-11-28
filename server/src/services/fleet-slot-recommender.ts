export interface FleetAgentDemand {
  agentId: string;
  currentSlots: number;
  queuedCount: number;
  maxCap?: number;
}

export interface AgentSlotAllocation {
  agentId: string;
  currentSlots: number;
  recommendedSlots: number;
  delta: number;
}

interface WorkingAgentAllocation {
  inputIndex: number;
  agentId: string;
  currentSlots: number;
  queuedCount: number;
  maxCap: number;
  allocatedSlots: number;
}

function effectiveMaxCap(agent: FleetAgentDemand): number {
  return Math.max(1, agent.maxCap ?? 10);
}

function pressureOf(agent: WorkingAgentAllocation): number {
  return agent.queuedCount / agent.allocatedSlots;
}

function isHigherPressureCandidate(
  candidate: WorkingAgentAllocation,
  incumbent: WorkingAgentAllocation,
): boolean {
  const candidatePressure = pressureOf(candidate);
  const incumbentPressure = pressureOf(incumbent);
  if (candidatePressure !== incumbentPressure) {
    return candidatePressure > incumbentPressure;
  }
  if (candidate.queuedCount !== incumbent.queuedCount) {
    return candidate.queuedCount > incumbent.queuedCount;
  }
  return candidate.agentId < incumbent.agentId;
}

function compareAgentIdThenInputOrder(
  left: WorkingAgentAllocation,
  right: WorkingAgentAllocation,
): number {
  if (left.agentId < right.agentId) return -1;
  if (left.agentId > right.agentId) return 1;
  return left.inputIndex - right.inputIndex;
}

export function rebalanceFleetSlotBudget(
  agents: readonly FleetAgentDemand[],
  totalSlotBudget: number,
): AgentSlotAllocation[] {
  if (agents.length === 0) return [];

  const working = agents
    .map((agent, inputIndex): WorkingAgentAllocation => {
      const maxCap = effectiveMaxCap(agent);
      return {
        inputIndex,
        agentId: agent.agentId,
        currentSlots: agent.currentSlots,
        queuedCount: agent.queuedCount,
        maxCap,
        allocatedSlots: Math.min(1, maxCap),
      };
    })
    .sort(compareAgentIdThenInputOrder);

  let remainingSlots = Math.max(0, Math.floor(totalSlotBudget) - agents.length);
  while (remainingSlots > 0) {
    let selected: WorkingAgentAllocation | undefined;
    for (const candidate of working) {
      if (candidate.queuedCount === 0) continue;
      if (candidate.allocatedSlots >= candidate.maxCap) continue;
      if (!selected || isHigherPressureCandidate(candidate, selected)) {
        selected = candidate;
      }
    }
    if (!selected) break;
    selected.allocatedSlots += 1;
    remainingSlots -= 1;
  }

  const allocations: AgentSlotAllocation[] = new Array(agents.length);
  for (const agent of working) {
    allocations[agent.inputIndex] = {
      agentId: agent.agentId,
      currentSlots: agent.currentSlots,
      recommendedSlots: agent.allocatedSlots,
      delta: agent.allocatedSlots - agent.currentSlots,
    };
  }
  return allocations;
}
