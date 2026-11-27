// ui/src/pages/workflows/workflow-harness-status.ts
//
// [파일 목적] 선택된 워크플로 실행(run)과 stepRuns만으로 하네스 상태 바의 표시 props를 계산한다(순수 함수 — 뮤테이션 없음).
//   계산 결과는 표시 상태일 뿐이며 실행 제어(retry/wakeup/escalation)의 근거로 쓰지 않는다.
// [연결] mount: workflow-run-detail-panel.tsx → <WorkflowHarnessStatusBar />.
import type {
  HarnessAdvisorGate,
  HarnessRoute,
  HarnessStallStatus,
} from "../../components/workflows/WorkflowHarnessStatusBar.js";
import type { WorkflowRunDetailData } from "./workflow-page-types.js";

/** Running step with no progress for this long is shown as stalled. */
export const STALL_WARN_MS = 5 * 60 * 1000;
/** Running step with no progress for this long is shown as timed out. */
export const STALL_TIMEOUT_MS = 15 * 60 * 1000;
/** Failed/cancelled step runs at or above this count route to ESCALATE. */
export const ESCALATE_FAILURE_COUNT = 2;

const RUNNING_STATUSES = new Set(["running", "in_progress", "active", "queued"]);
const RETRYABLE_FAILURE_STATUSES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);
const SUCCEEDED_STATUSES = new Set(["completed", "complete", "succeeded", "success", "done"]);

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function parseEpochMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRework(step: WorkflowRunDetailData["stepRuns"][number]): boolean {
  return Boolean(step.lastDispatchErrorAt || step.lastDispatchErrorSummary);
}

/** Latest "progress" timestamp for a step: completion, last accepted dispatch, or start. */
function lastProgressMs(step: WorkflowRunDetailData["stepRuns"][number]): number | null {
  const candidates = [step.completedAt, step.lastDispatchAcceptedAt, step.startedAt]
    .map(parseEpochMs)
    .filter((value): value is number => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Watchdog state for the run. While the run is in flight, the longest-idle running step decides
 * between healthy / stalled / timed out. A finished run has nothing in flight, so it is healthy.
 */
export function deriveStallStatus(
  run: WorkflowRunDetailData["run"],
  stepRuns: WorkflowRunDetailData["stepRuns"],
  nowMs: number = Date.now(),
): { stallStatus: HarnessStallStatus; idleMs: number } {
  const runStatus = normalizeStatus(run.status);
  if (!RUNNING_STATUSES.has(runStatus)) {
    return { stallStatus: "healthy", idleMs: 0 };
  }

  let maxIdleMs = 0;
  for (const step of stepRuns) {
    if (!RUNNING_STATUSES.has(normalizeStatus(step.status))) continue;
    const progressMs = lastProgressMs(step);
    maxIdleMs = Math.max(maxIdleMs, progressMs === null ? 0 : Math.max(0, nowMs - progressMs));
  }

  if (maxIdleMs >= STALL_TIMEOUT_MS) return { stallStatus: "timed_out", idleMs: maxIdleMs };
  if (maxIdleMs >= STALL_WARN_MS) return { stallStatus: "stalled", idleMs: maxIdleMs };
  return { stallStatus: "healthy", idleMs: maxIdleMs };
}

/** Probability-gated routing badge: any failure → SPLIT, repeated failure or rework-heavy → ESCALATE. */
export function deriveRoute(stepRuns: WorkflowRunDetailData["stepRuns"]): HarnessRoute {
  const failures = stepRuns.filter((step) => RETRYABLE_FAILURE_STATUSES.has(normalizeStatus(step.status))).length;
  if (failures >= ESCALATE_FAILURE_COUNT) return "escalate";
  if (failures > 0) return "split";
  return "sharp";
}

/** Completed-with-success vs. every non-pending step. null while there is nothing measured yet. */
export function deriveSuccessRatePct(stepRuns: WorkflowRunDetailData["stepRuns"]): number | null {
  const settled = stepRuns.filter((step) => {
    const status = normalizeStatus(step.status);
    return SUCCEEDED_STATUSES.has(status) || RETRYABLE_FAILURE_STATUSES.has(status);
  });
  if (settled.length === 0) return null;
  const succeeded = settled.filter((step) => SUCCEEDED_STATUSES.has(normalizeStatus(step.status))).length;
  return (succeeded / settled.length) * 100;
}

/**
 * Advisor gate to surface: the most recent step that is still awaiting a verdict runs (pending);
 * otherwise the latest settled step with a recorded dispatch error (challenge); otherwise pass.
 */
export function deriveAdvisorGate(stepRuns: WorkflowRunDetailData["stepRuns"]): HarnessAdvisorGate | null {
  if (stepRuns.length === 0) return null;
  const reversed = [...stepRuns].reverse();
  const errorStep = reversed.find((step) => isRework(step) || RETRYABLE_FAILURE_STATUSES.has(normalizeStatus(step.status)));
  if (errorStep) {
    return {
      gate: "g2",
      verdict: "challenge",
      reason: errorStep.lastDispatchErrorSummary || errorStep.stepTitle || errorStep.stepId,
    };
  }
  const last = reversed[0];
  const lastStatus = normalizeStatus(last.status);
  if (RUNNING_STATUSES.has(lastStatus)) {
    return { gate: "g1", verdict: "pending", reason: last.stepTitle || last.stepId };
  }
  if (SUCCEEDED_STATUSES.has(lastStatus)) {
    return { gate: "g3", verdict: "pass", reason: last.stepTitle || last.stepId };
  }
  return null;
}

export interface HarnessStatusProps {
  route: HarnessRoute;
  stallStatus: HarnessStallStatus;
  idleMs: number;
  advisorGate: HarnessAdvisorGate | null;
  successRatePct: number | null;
}

/** All display props for the harness status bar, derived only from the selected run's detail. */
export function deriveHarnessStatus(
  detail: WorkflowRunDetailData,
  nowMs: number = Date.now(),
): HarnessStatusProps {
  const { run, stepRuns } = detail;
  return {
    route: deriveRoute(stepRuns),
    ...deriveStallStatus(run, stepRuns, nowMs),
    advisorGate: deriveAdvisorGate(stepRuns),
    successRatePct: deriveSuccessRatePct(stepRuns),
  };
}
