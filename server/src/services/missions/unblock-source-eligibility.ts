import { workflowRuns, type Db } from "@paperclipai/db";
import { and, eq, exists, gt, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

// Shared circuit breaker for the card runaway: one anchor per human decision
// round, at most five visible anchors even if every previous round is terminal.
export const MAX_SOURCE_ANCHORS = 5;

export function isIneligibleUnblockSourceIssue(issue: { originKind: string | null; title?: string | null }) {
  // Note: mission_main_executor_oversight is intentionally preserved as the
  // canonical synthetic anchor source for issue-less tool-step recovery.
  return ["mission_main_executor_unblock", "mission_main_executor_plan"]
    .includes(issue.originKind ?? "") || /^\s*\[(unblock|plan)\]/i.test(issue.title ?? "");
}

// Read native run identity, including runs without step rows. Legacy/plugin run
// identifiers do not resolve here and retain their existing recovery behavior.
export async function loadIneligibleUnblockRunIds(db: Db, scope: { companyId: string; missionId: string }) {
  const newer = alias(workflowRuns, "newer_unblock_run");
  // Compare timestamps in PostgreSQL to retain sub-millisecond precision.
  const supersedingRun = db.select({ id: newer.id }).from(newer).where(and(
    eq(newer.companyId, workflowRuns.companyId), eq(newer.missionId, workflowRuns.missionId),
    ne(newer.status, "cancelled"), gt(newer.createdAt, workflowRuns.createdAt)));
  const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, scope.companyId), eq(workflowRuns.missionId, scope.missionId),
    or(inArray(workflowRuns.status, ["completed", "cancelled"]),
      and(eq(workflowRuns.status, "failed"), exists(supersedingRun)))));
  return new Set(runs.map((run) => run.id));
}
