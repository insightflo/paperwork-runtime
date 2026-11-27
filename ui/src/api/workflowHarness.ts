// ui/src/api/workflowHarness.ts
//
// [purpose] 워크플로 실행(run) 단위 하네스 요약(read-only) 실물 HTTP 클라이언트.
//   서버 server/src/services/workflow/harness-summary.ts의 WorkflowRunHarnessSummary와
//   GET /workflow-runs/:runId/harness-status 응답(봉투 없음, 본문 곧 요약)을 미러한다.
//   기존 api client(/api 프리픽스, JSON, credentials 포함, 타임아웃)를 그대로 사용한다.
//   응답은 런타임 가드로 검증하며, 형식이 맞지 않으면 실패를 닫아(null) 돌려준다.
//   이 결과는 표시 상태일 뿐이며 실행 제어(retry/wakeup/escalation)의 근거로 쓰지 않는다.
import { api } from "./client";

/** Mirror of server WorkflowStepStallStatus (harness-watchdog.ts). */
export type WorkflowRunHarnessStallStatus = "healthy" | "stalled" | "timed_out";
/** Mirror of server WorkflowRunHarnessRoute — probability-gated backprop route. */
export type WorkflowRunHarnessRoute = "sharp" | "split" | "escalate";
/** Mirror of server WorkflowRunHarnessAdvisorGate. */
export type WorkflowRunHarnessAdvisorGate = "g1_pending" | "g2_challenge" | "g3_pass" | "none";

export interface WorkflowRunHarnessSummary {
  runId: string;
  stallStatus: WorkflowRunHarnessStallStatus;
  /** Idle time (ms) of the running step that decided `stallStatus`; `0` when nothing runs. */
  idleMs: number;
  route: WorkflowRunHarnessRoute;
  advisorGate: WorkflowRunHarnessAdvisorGate;
  /** `completed / (completed + failed)` as a percentage, or `null` without terminal evidence. */
  successRatePct: number | null;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  stalledSteps: number;
  /** ISO timestamp of the server-side evaluation. */
  evaluatedAt: string;
}

const STALL_STATUSES: ReadonlySet<string> = new Set<WorkflowRunHarnessStallStatus>(["healthy", "stalled", "timed_out"]);
const ROUTES: ReadonlySet<string> = new Set<WorkflowRunHarnessRoute>(["sharp", "split", "escalate"]);
const ADVISOR_GATES: ReadonlySet<string> = new Set<WorkflowRunHarnessAdvisorGate>([
  "g1_pending",
  "g2_challenge",
  "g3_pass",
  "none",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): value is T {
  return typeof value === "string" && allowed.has(value);
}

/**
 * Fail-closed runtime guard for one harness summary. Every field is required and
 * type-checked; enum fields must be known literals, counters must be finite and
 * non-negative, `successRatePct` must be `null` or within [0, 100], and
 * `evaluatedAt` must parse as a date. Partial or malformed payloads return `false`.
 */
export function isWorkflowRunHarnessSummary(value: unknown): value is WorkflowRunHarnessSummary {
  if (!isRecord(value)) return false;
  if (typeof value.runId !== "string" || value.runId.length === 0) return false;
  if (!isOneOf<WorkflowRunHarnessStallStatus>(value.stallStatus, STALL_STATUSES)) return false;
  if (!isNonNegativeFinite(value.idleMs)) return false;
  if (!isOneOf<WorkflowRunHarnessRoute>(value.route, ROUTES)) return false;
  if (!isOneOf<WorkflowRunHarnessAdvisorGate>(value.advisorGate, ADVISOR_GATES)) return false;
  if (value.successRatePct !== null && !(isNonNegativeFinite(value.successRatePct) && value.successRatePct <= 100)) {
    return false;
  }
  if (!isNonNegativeFinite(value.totalSteps)) return false;
  if (!isNonNegativeFinite(value.completedSteps)) return false;
  if (!isNonNegativeFinite(value.failedSteps)) return false;
  if (!isNonNegativeFinite(value.stalledSteps)) return false;
  return typeof value.evaluatedAt === "string" && !Number.isNaN(Date.parse(value.evaluatedAt));
}

function harnessStatusPath(runId: string): string {
  return `/workflow-runs/${encodeURIComponent(runId)}/harness-status`;
}

/**
 * GET /workflow-runs/:runId/harness-status → WorkflowRunHarnessSummary.
 *
 * - Returns `null` (fail closed) when `runId` is blank, the body is not a valid
 *   summary, or the body's `runId` does not match the requested run.
 * - HTTP failures (404/403/5xx, 408 timeout) and network errors still reject with
 *   the client's `ApiError`/underlying error; callers surface them rather than
 *   treating them as "no harness status".
 */
export async function fetchWorkflowRunHarnessStatus(runId: string): Promise<WorkflowRunHarnessSummary | null> {
  if (typeof runId !== "string" || runId.trim().length === 0) return null;
  const payload: unknown = await api.get<unknown>(harnessStatusPath(runId));
  if (!isWorkflowRunHarnessSummary(payload) || payload.runId !== runId) return null;
  return payload;
}
