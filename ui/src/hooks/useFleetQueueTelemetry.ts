import { useQuery } from "@tanstack/react-query";
import { queueTelemetryApi } from "../api/queueTelemetry";

export function fleetQueueTelemetryQueryKey(companyId: string | null | undefined) {
  return ["queue-telemetry", companyId ?? ""] as const;
}

export function useFleetQueueTelemetry(
  companyId: string | null | undefined,
  opts?: { enabled?: boolean; refetchIntervalMs?: number },
) {
  return useQuery({
    queryKey: fleetQueueTelemetryQueryKey(companyId),
    queryFn: () => queueTelemetryApi.getFleetSummary(companyId!),
    enabled: Boolean(companyId) && (opts?.enabled ?? true),
    refetchInterval: opts?.refetchIntervalMs ?? 15_000,
    retry: false,
    staleTime: 10_000,
  });
}
