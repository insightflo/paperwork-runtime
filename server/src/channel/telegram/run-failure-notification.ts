import { agents, heartbeatRuns, issues, missions, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";

type SuppressionInput = {
  error?: unknown;
  errorMessage?: unknown;
  errorCode?: unknown;
  stderrExcerpt?: unknown;
  willRetry?: unknown;
  autoRetryScheduled?: unknown;
  fallbackScheduled?: unknown;
  retryScheduled?: unknown;
  suppressedByRetry?: unknown;
};

// Display-only filtering: this never schedules retries or changes run state.
export function shouldSuppressRunFailure(input: SuppressionInput): boolean {
  if ([input.willRetry, input.autoRetryScheduled, input.fallbackScheduled,
    input.retryScheduled, input.suppressedByRetry].some((value) => value === true)) return true;
  if (typeof input.errorCode === "string"
    && input.errorCode.trim().toLowerCase() === "adapter_failed_transient") return true;
  const overload = /\b(?:429|529)\b|\brate limit reached for requests\b|\boverloaded\b|\b503\s+service unavailable\b|\btoo many requests\b/i;
  return [input.error, input.errorMessage, input.errorCode, input.stderrExcerpt]
    .some((value) => typeof value === "string" && overload.test(value));
}

/** Compose an operator-readable failure; missing context lines are omitted. */
export function composeRunFailureNotification(input: SuppressionInput & {
  status: string;
  runId: string;
  agentName?: string | null;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
  missionTitle?: string | null;
  missionId?: string | null;
  error?: string | null;
}): string | null {
  if (shouldSuppressRunFailure(input)) return null;
  const emoji = getRunStatusEmoji(input.status);
  const statusLabel =
    input.status === "timed_out" ? "시간 초과" :
    input.status === "cancelled" ? "취소" :
    "실패";
  const runLabel = input.runId.slice(0, 8);

  const issueLine = [input.issueIdentifier ?? null, input.issueTitle ?? null]
    .filter(Boolean).join(" — ");
  const errorFirstLine = input.error?.split("\n")[0]?.trim() ?? "";
  const errorLine = errorFirstLine ? errorFirstLine.slice(0, 160) : null;
  const lines = [
    `${emoji} *런 ${statusLabel}*`,
    input.agentName ? `에이전트: ${input.agentName}` : null,
    issueLine ? `이슈: ${issueLine}` : null,
    input.missionTitle ? `미션: ${input.missionTitle}` : null,
    `런: *${runLabel}* (${input.status})`,
    errorLine ? `에러: ${errorLine}` : null,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n").slice(0, 3500);
}

/**
 * null permits the caller's minimal fallback; { message: null } suppresses it.
 * Both event metadata and durable run diagnostics can suppress notifications.
 */
export async function buildRunFailureNotification(
  db: Db,
  event: { type: string; payload?: Record<string, unknown> },
): Promise<{ message: string | null } | null> {
  if (event.type !== "heartbeat.run.status") return null;
  const status = typeof event.payload?.status === "string" ? event.payload.status.trim() : "";
  const runId = typeof event.payload?.runId === "string" ? event.payload.runId.trim() : "";
  if (!status || !runId || !["failed", "timed_out", "cancelled"].includes(status)) return null;
  if (shouldSuppressRunFailure(event.payload ?? {})) return { message: null };

  try {
    const [row] = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        agentName: agents.name,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        missionId: issues.missionId,
        missionTitle: missions.title,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(issues, eq(heartbeatRuns.issueId, issues.id))
      .leftJoin(missions, eq(issues.missionId, missions.id))
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    if (!row) return null;
    return { message: composeRunFailureNotification({ ...row, status, runId }) };
  } catch (err) {
    logger.warn({
      msg: "Failed to enrich run-failure notification; falling back to minimal format",
      runId,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }
}

export function getRunStatusEmoji(status: string): string {
  switch (status) {
    case "queued": return "\u23F3";
    case "running": return "\u{1F3D7}";
    case "succeeded": return "\u2705";
    case "failed": return "\u274C";
    case "cancelled": return "\u{1F6AB}";
    case "timed_out": return "\u23F1";
    default: return "\u2753";
  }
}
