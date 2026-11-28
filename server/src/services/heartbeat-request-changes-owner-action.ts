import { heartbeatRuns, issues, missions, workflowRuns, type Db } from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { canCreateMissionOwnerUnblockForRequestChanges } from "./heartbeat-mission-owner-context.js";
import { buildRequestChangesOwnerActionDescription, type RequestChangesVerdict } from "./heartbeat-validation-presentation.js";
import type { WakeupOptions } from "./heartbeat-wake-context.js";
import { buildMissionExecutionDigest } from "./missions/mission-execution-digest.js";
import { createOwnerActions } from "./missions/owner-actions.js";
import { isIneligibleUnblockSourceIssue, loadIneligibleUnblockRunIds, MAX_SOURCE_ANCHORS } from "./missions/unblock-source-eligibility.js";

export function createRequestChangesOwnerAction({ db, enqueueWakeup }: {
  db: Db;
  enqueueWakeup: (agentId: string, options: WakeupOptions) => Promise<unknown>;
}) {
  return async function ensureRequestChangesOwnerActionIssue(input: {
    sourceIssue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "identifier" | "title" | "originKind" | "status" | "assigneeAgentId" | "parentId">;
    run: typeof heartbeatRuns.$inferSelect;
    verdict: RequestChangesVerdict;
  }) {
    if (!input.sourceIssue.missionId || isIneligibleUnblockSourceIssue(input.sourceIssue)) return null;
    if (!canCreateMissionOwnerUnblockForRequestChanges(input.sourceIssue)) return null;
    const result = await db.transaction(async (tx) => {
      const [mission] = await tx.select().from(missions).where(and(
        eq(missions.id, input.sourceIssue.missionId!), eq(missions.companyId, input.sourceIssue.companyId))).for("update");
      if (!mission?.ownerAgentId || ["completed", "cancelled"].includes(mission.status)) return null;
      const [observed] = await tx.select().from(issues).where(and(
        eq(issues.id, input.sourceIssue.id), eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id)));
      if (!observed || observed.hiddenAt) return null;
      if (observed.originRunId) await tx.select().from(workflowRuns).where(and(
        sql`${workflowRuns.id}::text = ${observed.originRunId}`, eq(workflowRuns.companyId, mission.companyId),
        eq(workflowRuns.missionId, mission.id))).for("update");
      const [source] = await tx.select().from(issues).where(eq(issues.id, observed.id)).for("update");
      if (!source || source.hiddenAt || source.originRunId !== observed.originRunId
        || source.companyId !== mission.companyId || source.missionId !== mission.id
        || isIneligibleUnblockSourceIssue(source) || !canCreateMissionOwnerUnblockForRequestChanges(source)) return null;
      const ineligibleRunIds = await loadIneligibleUnblockRunIds(tx as unknown as Db, {
        companyId: mission.companyId, missionId: mission.id,
      });
      if (ineligibleRunIds.has(source.originRunId ?? "")) return null;
      const anchors = await tx.select().from(issues).where(and(
        eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, source.id),
        sql`${issues.hiddenAt} is null`)).orderBy(asc(issues.createdAt), asc(issues.id));
      const existing = anchors.find((row) => !["done", "cancelled"].includes(row.status));
      if (!existing && anchors.length >= MAX_SOURCE_ANCHORS) {
        return { mission, ownerAction: anchors[anchors.length - 1]!, wake: false };
      }
      let missionExecutionDigest: string[] = [];
      try {
        missionExecutionDigest = await tx.transaction((nested) => buildMissionExecutionDigest(nested as unknown as Db, {
          mission, blockedIssue: source,
        }));
      } catch (err) {
        logger.warn(
          { err, missionId: source.missionId, issueId: source.id },
          "failed to build mission execution digest for REQUEST_CHANGES owner action",
        );
        missionExecutionDigest = ["Mission execution digest could not be built; inspect workflow runs, step runs, work products, and source issue comments manually."];
      }

      const sourceLabel = source.identifier ?? source.id;
      const nextDescription = buildRequestChangesOwnerActionDescription({
        ...input,
        sourceIssue: source,
        mission,
        missionExecutionDigest,
      });
      if (existing && !(existing.description ?? "").includes("Mission execution digest:")) {
        await tx
          .update(issues)
          .set({ description: nextDescription, updatedAt: new Date() })
          .where(eq(issues.id, existing.id));
        existing.description = nextDescription;
      }
      const ownerActionParentId = source.parentId ? undefined : source.id;
      const ownerAction = existing ?? await createOwnerActions({ db: tx as unknown as Db, deps: {} }).createMissionOwnerActionIssue(source.companyId, {
        assigneeAgentId: mission.ownerAgentId,
        description: nextDescription,
        missionId: source.missionId,
        originKind: "mission_main_executor_unblock",
        originId: source.id,
        parentId: ownerActionParentId,
        priority: "high",
        status: "todo",
        title: `[Unblock] ${sourceLabel}: ${source.title}`,
      });

      return { mission, ownerAction, wake: true };
    });
    if (!result) return null;
    const { mission, ownerAction } = result;
    if (!result.wake) return ownerAction;

    try {
      await enqueueWakeup(mission.ownerAgentId, {
        source: "automation",
        triggerDetail: "mission_validation_request_changes",
        reason: "mission_validation_request_changes",
        idempotencyKey: `mission-validation-request-changes:${input.run.id}:${ownerAction.id}`,
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
        payload: {
          issueId: ownerAction.id,
          sourceIssueId: input.sourceIssue.id,
          sourceRunId: input.run.id,
          verdict: "REQUEST_CHANGES",
        },
        contextSnapshot: {
          taskKey: `issue:${ownerAction.id}`,
          issueId: ownerAction.id,
          missionId: input.sourceIssue.missionId,
          sourceIssueId: input.sourceIssue.id,
          sourceRunId: input.run.id,
          wakeReason: "mission_validation_request_changes",
        },
      });
    } catch (err) {
      logger.warn(
        { err, missionId: input.sourceIssue.missionId, issueId: ownerAction.id, sourceIssueId: input.sourceIssue.id },
        "failed to wake mission owner after REQUEST_CHANGES validation gate",
      );
    }

    return ownerAction;
  };
}
