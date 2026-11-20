import { stat } from "node:fs/promises";
import path from "node:path";
import { issueComments, issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import { completeLinkedWorkflowStepRunsForIssue } from "./issue-step-closeout.js";

const absolutePathError = "step_closeout_artifact_invalid";
export const stepCloseoutParamsSchema = z.object({
  issueId: z.string().trim().min(1).optional(),
  status: z.enum(["done", "in_review"]).default("done"),
  comment: z.string().trim().max(32_000).optional(),
  artifactPaths: z.array(z.string().min(1).refine(path.isAbsolute, absolutePathError)).max(16).optional(),
});

export async function executeStepCloseoutTool(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  heartbeatRunId?: string | null;
  issueId?: string | null;
  toolName: string;
  parameters: unknown;
}): Promise<CoreWorkflowToolExecutionResult> {
  const { db, companyId, toolName: tool } = input;
  const agentId = input.agentId?.trim();
  const heartbeatRunId = input.heartbeatRunId?.trim();
  const fail = (status: 403 | 404 | 422, error: string): CoreWorkflowToolExecutionResult =>
    ({ status, body: { error, tool, source: "core" } });
  if (!agentId || !heartbeatRunId) return fail(403, "step_closeout_identity_required");

  const parsed = stepCloseoutParamsSchema.safeParse(input.parameters);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.every((issue) => issue.message === absolutePathError)
      ? absolutePathError : "invalid_step_closeout_request");
  }
  const { status, comment, artifactPaths = [] } = parsed.data;
  const issueId = parsed.data.issueId ?? input.issueId?.trim();
  if (!issueId) return fail(422, "step_closeout_issue_required");

  const verifiedArtifacts: { path: string; sizeBytes: number }[] = [];
  for (const artifactPath of artifactPaths) {
    try {
      const stats = await stat(artifactPath);
      if (!stats.isFile() || stats.size <= 0) return fail(422, absolutePathError);
      verifiedArtifacts.push({ path: artifactPath, sizeBytes: stats.size });
    } catch {
      return fail(422, absolutePathError);
    }
  }

  return db.transaction(async (tx): Promise<CoreWorkflowToolExecutionResult> => {
    const issueScope = and(eq(issues.id, issueId), eq(issues.companyId, companyId));
    // Keep the assignee check and the update serialized against reassignment.
    const [issue] = await tx.select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues).where(issueScope).limit(1).for("update");
    if (!issue) return fail(404, "issue_not_found");
    if (issue.assigneeAgentId && issue.assigneeAgentId !== agentId) {
      return fail(403, "issue_assignee_mismatch");
    }

    const now = new Date();
    let commentId: string | null = null;
    if (comment !== undefined) {
      const [inserted] = await tx.insert(issueComments)
        .values({ companyId, issueId, authorAgentId: agentId, body: comment })
        .returning({ id: issueComments.id });
      commentId = inserted.id;
    }
    await tx.update(issues).set({ status, updatedAt: now, ...(status === "done" ? { completedAt: now } : {}) })
      .where(issueScope);
    const completedStepRunIds = status === "done"
      ? await completeLinkedWorkflowStepRunsForIssue({
          db: tx, issueId, completedAt: now, source: "workflow_issue_closeout", heartbeatRunId,
        })
      : [];
    const result = { issueId, status, commentId, verifiedArtifacts, completedStepRunIds };
    return { status: 200, body: { content: JSON.stringify(result), data: result, tool, source: "core" } };
  });
}
