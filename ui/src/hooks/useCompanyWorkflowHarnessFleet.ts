// ui/src/hooks/useCompanyWorkflowHarnessFleet.ts
//
// [파일 목적] 회사 단위 워크플로 하네스 플릿 요약을 30초 폴링하는 React Query 훅.
//   GET /api/companies/:companyId/workflows/harness-fleet (server/src/routes/workflow-harness-fleet.ts).
//   - companyId가 비어 있으면 조회하지 않는다(enabled false).
//   - 숫자 필드가 계약과 다르면 null로 실패 닫힘(fail-closed)한다. HTTP/네트워크 오류는 error로 전달한다.
import { useQuery, type QueryObserverOptions } from "@tanstack/react-query";
import { api } from "../api/client";

export const WORKFLOW_HARNESS_FLEET_PATH = "workflows/harness-fleet";
export const WORKFLOW_HARNESS_FLEET_POLL_MS = 30_000;

/** Aggregate over recent workflow-harness runs. Mirrors the server's WorkflowHarnessFleetSummary. */
export interface WorkflowHarnessFleetSummary {
  totalRuns: number;
  healthyRuns: number;
  /** Runs whose worst running step is healthy / stalled / timed out. */
  stalledRuns: number;
  timedOutRuns: number;
  /** Backprop route counts (sharp / split / escalate). */
  sharpRuns: number;
  splitRuns: number;
  escalatedRuns: number;
  /** Advisor gates awaiting a human (`g1_pending`) or a challenge (`g2_challenge`). */
  pendingAdvisorGates: number;
  challengedAdvisorGates: number;
  /** Mean of non-null `successRatePct`; `null` when no run has terminal evidence. */
  avgSuccessRatePct: number | null;
  /** Worst stalled or timed-out run; `null` when every run is healthy. */
  worstStallRunId: string | null;
  maxIdleMs: number;
}

const COUNT_KEYS = [
  "totalRuns",
  "healthyRuns",
  "stalledRuns",
  "timedOutRuns",
  "sharpRuns",
  "splitRuns",
  "escalatedRuns",
  "pendingAdvisorGates",
  "challengedAdvisorGates",
] as const satisfies readonly (keyof WorkflowHarnessFleetSummary)[];

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Returns the summary when every numeric field is a valid count, otherwise `null`. */
export function parseWorkflowHarnessFleetSummary(payload: unknown): WorkflowHarnessFleetSummary | null {
  if (typeof payload !== "object" || payload === null) return null;
  const summary = payload as Record<string, unknown>;
  if (!COUNT_KEYS.every((key) => isCount(summary[key]))) return null;
  if (!isCount(summary.maxIdleMs)) return null;
  if (summary.avgSuccessRatePct !== null && !isCount(summary.avgSuccessRatePct)) return null;
  if (summary.worstStallRunId !== null && (typeof summary.worstStallRunId !== "string" || summary.worstStallRunId === "")) {
    return null;
  }
  return summary as unknown as WorkflowHarnessFleetSummary;
}

export function companyWorkflowHarnessFleetQueryOptions(
  companyId: string | null | undefined,
): QueryObserverOptions<WorkflowHarnessFleetSummary | null> {
  const enabled = Boolean(companyId?.trim());
  return {
    queryKey: ["workflows", "harness-fleet", companyId ?? "__none__"],
    queryFn: async () => {
      const payload: unknown = await api.get<unknown>(
        `/companies/${encodeURIComponent(companyId!.trim())}/${WORKFLOW_HARNESS_FLEET_PATH}`,
      );
      return parseWorkflowHarnessFleetSummary(payload);
    },
    enabled,
    refetchInterval: WORKFLOW_HARNESS_FLEET_POLL_MS,
    retry: false,
  };
}

/**
 * Poll the company's workflow harness fleet summary.
 * `data` is `undefined` while disabled/loading, `null` when the payload is malformed.
 */
export function useCompanyWorkflowHarnessFleet(companyId: string | null | undefined) {
  const { data, isLoading, error } = useQuery(companyWorkflowHarnessFleetQueryOptions(companyId));
  return { data, isLoading, error };
}
