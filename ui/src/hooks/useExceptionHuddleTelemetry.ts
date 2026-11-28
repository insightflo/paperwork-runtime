import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export interface ExceptionHuddleTelemetrySummaryData {
  total: number;
  byStatus: { open: number; timed_out: number; decided: number; cancelled: number };
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

export interface ExceptionHuddleTelemetryResponse {
  companyId: string;
  missionId: string | null;
  summary: ExceptionHuddleTelemetrySummaryData;
}

export function fetchExceptionHuddleTelemetry(
  companyId: string,
  missionId?: string,
): Promise<ExceptionHuddleTelemetryResponse> {
  const trimmedMissionId = missionId?.trim();
  const missionQuery = trimmedMissionId ? `?missionId=${encodeURIComponent(trimmedMissionId)}` : "";
  return api.get<ExceptionHuddleTelemetryResponse>(
    `/companies/${encodeURIComponent(companyId)}/collab-channels/huddles/telemetry${missionQuery}`,
  );
}

export function useExceptionHuddleTelemetry(
  companyId: string | undefined,
  missionId?: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["exception-huddle-telemetry", companyId, missionId ?? null],
    queryFn: () => fetchExceptionHuddleTelemetry(companyId!, missionId),
    enabled: Boolean(companyId && (opts?.enabled ?? true)),
  });
}
