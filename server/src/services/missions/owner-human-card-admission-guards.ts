import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";

type SelectDb = Pick<Db, "select">;

const MIN_HUMAN_CARD_TEXT_LENGTH = 3;

export function hasConcreteHumanCardContent(input: {
  reason?: string | null;
  nextAction?: string | null;
}): boolean {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const nextAction = typeof input.nextAction === "string" ? input.nextAction.trim() : "";
  return reason.length >= MIN_HUMAN_CARD_TEXT_LENGTH || nextAction.length >= MIN_HUMAN_CARD_TEXT_LENGTH;
}

export async function findActiveMissionReworkStep(
  db: SelectDb,
  companyId: string,
  missionId: string,
): Promise<{ workflowRunId: string; stepRunId: string; stepId: string } | null> {
  const rows = await db
    .select({
      workflowRunId: workflowStepRuns.workflowRunId,
      stepRunId: workflowStepRuns.id,
      stepId: workflowStepRuns.stepId,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(
      and(
        eq(workflowRuns.companyId, companyId),
        eq(workflowRuns.missionId, missionId),
        inArray(workflowRuns.status, ["running", "queued"]),
        eq(workflowStepRuns.status, "running"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findNewerActiveWorkflowRun(
  db: SelectDb,
  companyId: string,
  missionId: string,
  workflowRunId: string,
): Promise<{ newerWorkflowRunId: string; status: string } | null> {
  const targetRows = await db
    .select({
      id: workflowRuns.id,
      createdAt: workflowRuns.createdAt,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.id, workflowRunId),
        eq(workflowRuns.companyId, companyId),
        eq(workflowRuns.missionId, missionId),
      ),
    )
    .limit(1);
  const target = targetRows[0];
  if (!target) return null;

  const newerRows = await db
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.companyId, companyId),
        eq(workflowRuns.missionId, missionId),
        ne(workflowRuns.id, workflowRunId),
        inArray(workflowRuns.status, ["running", "queued"]),
        gte(workflowRuns.createdAt, target.createdAt),
      ),
    )
    .limit(1);
  const newer = newerRows[0];
  if (!newer) return null;
  return { newerWorkflowRunId: newer.id, status: newer.status };
}
