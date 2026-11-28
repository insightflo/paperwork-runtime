import { api } from "./client";

export interface AgentQueueTelemetryDto {
  agentId: string;
  agentName?: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  utilizationRatio: number;
  saturated: boolean;
  oldestQueuedWaitMs: number;
  starvationWarning: boolean;
  distinctQueuedIssues: number;
}

export interface FleetQueueTelemetryDto {
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  saturatedAgents: number;
  starvingAgents: number;
  maxQueuedWaitMs: number;
  byAgent: AgentQueueTelemetryDto[];
}

export const queueTelemetryApi = {
  getFleetSummary(companyId: string): Promise<FleetQueueTelemetryDto> {
    return api.get<FleetQueueTelemetryDto>(
      `/companies/${encodeURIComponent(companyId)}/queue-telemetry`,
    );
  },
};
