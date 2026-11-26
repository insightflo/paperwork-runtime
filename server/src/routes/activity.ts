import { Router } from "express";
import { z } from "zod";
import { activityLog, issues, type Db } from "@paperclipai/db";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import { operatorDecisionRoutes } from "./operator-decisions.js";
import { startOperatorDecisionRuntime } from "../services/operator-decision-runtime.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

const DEFAULT_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_LIMIT = 500;

function parseActivityLimit(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_ACTIVITY_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

function parseActivityOffset(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);
  router.use(operatorDecisionRoutes(db));
  if (process.env.NODE_ENV !== "test") startOperatorDecisionRuntime(db);

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const agentId = req.query.agentId as string | undefined;
    const entityType = req.query.entityType as string | undefined;
    const entityId = req.query.entityId as string | undefined;
    const limit = parseActivityLimit(req.query.limit);
    const offset = parseActivityOffset(req.query.offset);
    const canUseBoundedQuery = typeof (db as { execute?: unknown }).execute === "function";
    if (!canUseBoundedQuery) {
      const result = await svc.list({ companyId, agentId, entityType, entityId });
      res.json(result);
      return;
    }
    const issueIdAsUuid = sql`case when ${activityLog.entityType} = 'issue' and ${activityLog.entityId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then ${activityLog.entityId}::uuid else null end`;
    const conditions = [eq(activityLog.companyId, companyId)];
    if (agentId) conditions.push(eq(activityLog.agentId, agentId));
    if (entityType) conditions.push(eq(activityLog.entityType, entityType));
    if (entityId) conditions.push(eq(activityLog.entityId, entityId));

    const rows = await db
      .select({ activityLog })
      .from(activityLog)
      .leftJoin(issues, sql`${issues.id} = ${issueIdAsUuid}`)
      .where(and(...conditions, or(ne(activityLog.entityType, "issue"), isNull(issues.hiddenAt))))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(limit)
      .offset(offset);
    res.json(rows.map((row) => row.activityLog));
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
