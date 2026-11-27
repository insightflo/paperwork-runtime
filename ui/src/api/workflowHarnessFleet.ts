// ui/src/api/workflowHarnessFleet.ts
//
// [파일 목적] 회사 단위 워크플로 하네스 플릿 지표 조회 클라이언트.
//   응답 형태가 계약과 다르면 null로 실패 닫힘(fail-closed)하며, HTTP/네트워크 오류는 그대로 전파한다.
import { api } from "./client";

export const WORKFLOW_HARNESS_FLEET_METRICS_PATH = "workflows/harness-fleet";

/** Company-scoped aggregate over recent workflow-harness runs. Mirrors the server fleet summary. */
export interface WorkflowHarnessFleetMetrics {
  totalRuns: number;
  healthyRuns: number;
  stalledRuns: number;
  timedOutRuns: number;
  sharpRuns: number;
  splitRuns: number;
  escalatedRuns: number;
  pendingAdvisorGates: number;
  challengedAdvisorGates: number;
  /** null when no completed runs are in the window. */
  avgSuccessRatePct: number | null;
  /** null when no run is stalled. */
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
] as const satisfies readonly (keyof WorkflowHarnessFleetMetrics)[];

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isWorkflowHarnessFleetMetrics(v: unknown): v is WorkflowHarnessFleetMetrics {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (!COUNT_KEYS.every((key) => isNonNegativeFiniteNumber(m[key]))) return false;
  if (!isNonNegativeFiniteNumber(m.maxIdleMs)) return false;
  if (m.avgSuccessRatePct !== null && !isNonNegativeFiniteNumber(m.avgSuccessRatePct)) return false;
  if (m.worstStallRunId !== null && (typeof m.worstStallRunId !== "string" || m.worstStallRunId === "")) {
    return false;
  }
  return true;
}

/**
 * GET /api/companies/:companyId/workflows/harness-fleet
 * (server/src/routes/workflow-harness-fleet.ts)
 * Returns null (without a network call) for an empty companyId, and null when the
 * payload does not match the metrics contract. Transport/HTTP errors propagate.
 */
export async function fetchCompanyWorkflowHarnessFleet(
  companyId: string,
): Promise<WorkflowHarnessFleetMetrics | null> {
  if (typeof companyId !== "string" || companyId.trim() === "") return null;
  const payload: unknown = await api.get<unknown>(
    `/companies/${encodeURIComponent(companyId)}/${WORKFLOW_HARNESS_FLEET_METRICS_PATH}`,
  );
  return isWorkflowHarnessFleetMetrics(payload) ? payload : null;
}
