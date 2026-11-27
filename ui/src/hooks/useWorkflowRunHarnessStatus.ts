// ui/src/hooks/useWorkflowRunHarnessStatus.ts
//
// [purpose] 워크플로 실행(run) 단위 하네스 요약을 React Query로 읽는 live 훅.
//   fetchWorkflowRunHarnessStatus(runId)를 그대로 감싸며, runId가 비어 있으면 조회하지 않고,
//   실행 중(isRunning)일 때만 15초 간격으로 재조회한다. 요약은 표시 상태일 뿐이며
//   실행 제어(retry/wakeup/escalation)의 근거로 쓰지 않는다.
//   - retry: false — 폴링 주기가 곧 재시도이므로 기본 retry 정책을 겹치지 않게 한다.
//   - 실패 시 error를 노출하고 summary는 null로 닫는다(fail closed). UI는 error를 함께 표시해야 한다.
import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import {
  fetchWorkflowRunHarnessStatus,
  type WorkflowRunHarnessSummary,
} from "../api/workflowHarness";

/** Poll interval while the run is live; matches the inbox live-runs cadence. */
export const HARNESS_STATUS_POLL_MS = 15_000;

/**
 * Local key: `lib/queryKeys` has no harness-status entry yet. Mirrors the
 * REST path shape so future invalidation by prefix (`["workflow-runs", id]`) works.
 */
export function workflowRunHarnessStatusKey(runId: string) {
  return ["workflow-runs", runId, "harness-status"] as const;
}

/**
 * Query options for one run's harness status. `enabled` is false for a null,
 * undefined, or blank `runId`; `refetchInterval` is only set while the run is
 * running. Exported so the polling/enabled contract can be tested without React.
 */
export function workflowRunHarnessStatusOptions(
  runId: string | null | undefined,
  isRunning: boolean,
): UseQueryOptions<WorkflowRunHarnessSummary | null> {
  const enabled = Boolean(runId && runId.trim());
  return {
    queryKey: workflowRunHarnessStatusKey(runId ?? "none"),
    queryFn: () => fetchWorkflowRunHarnessStatus(runId!),
    enabled,
    refetchInterval: enabled && isRunning ? HARNESS_STATUS_POLL_MS : false,
    retry: false,
  };
}

export interface UseWorkflowRunHarnessStatusResult {
  /** Parsed summary, or `null` while disabled, loading, failed, or malformed. */
  summary: WorkflowRunHarnessSummary | null;
  /** True only for the first load of an enabled query (not background refetches). */
  isLoading: boolean;
  /** Last fetch error (`null` when none). Kept separate from `summary` so failures are not hidden. */
  error: UseQueryResult["error"];
  isFetching: boolean;
  refetch: UseQueryResult["refetch"];
}

/**
 * Live harness status for one workflow run.
 *
 * The harness summary carries no run status, so the caller — which already
 * knows the run's status from the workflow-runs list — passes `isRunning`.
 * It defaults to `true` so a run detail view polls by default; pass `false`
 * for terminal runs to stop polling.
 */
export function useWorkflowRunHarnessStatus(
  runId: string | null | undefined,
  { isRunning = true }: { isRunning?: boolean } = {},
): UseWorkflowRunHarnessStatusResult {
  const query = useQuery(workflowRunHarnessStatusOptions(runId, isRunning));
  return {
    summary: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus === "fetching",
    error: query.error,
    isFetching: query.fetchStatus === "fetching",
    refetch: query.refetch,
  };
}
