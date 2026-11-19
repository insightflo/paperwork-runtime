/**
 * Worktree Routes
 *
 * Endpoints:
 * - GET    /companies/:companyId/worktree/rules           — List rules
 * - POST   /companies/:companyId/worktree/rules           — Create rule
 * - GET    /worktree/rules/:id                            — Get rule
 * - PATCH  /worktree/rules/:id                            — Update rule
 * - DELETE /worktree/rules/:id                            — Delete rule
 * - GET    /companies/:companyId/worktree/proposals       — List proposals
 * - POST   /companies/:companyId/worktree/proposals       — Create proposal
 * - GET    /worktree/proposals/:id                        — Get proposal
 * - PATCH  /worktree/proposals/:id/review                 — Review proposal (approve/reject)
 *
 * Hermit Gate (r60 은둔 작업 게이트) · Ops Console:
 * - /companies/:companyId/hermit-gate/*  — claims / verify / merges / audit / decisions
 * - /companies/:companyId/ops-console/*  — overview / thresholds / processes / queue
 *
 * CRITICAL: /maintenance/* routes are gated by company-kind-gate at the app level.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { ruleStore } from "../services/worktree/rule-store.js";
import { proposalStore } from "../services/worktree/proposal-store.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { getHermitGateService } from "../services/hermit-gate.js";
import {
  AuditCompleteInputSchema,
  AuditScopeInputSchema,
  ChangeVerificationInputSchema,
  ClaimRequestSchema,
  DecisionRecordSchema,
  DecisionUpdateInputSchema,
  MergeRecordInputSchema,
  QueueEditInputSchema,
  QueueReorderInputSchema,
  ThresholdsInputSchema,
} from "../services/hermit-gate-types.js";
import { operatorQueueViewService } from "../services/operator-queue-view.js";
import { opsConsoleTelemetryService } from "../services/ops-console-telemetry.js";

export function worktreeRoutes(db: Db) {
  const router = Router();
  const rules = ruleStore(db);
  const proposals = proposalStore(db);
  const gate = getHermitGateService();
  const queue = operatorQueueViewService(db);
  const telemetry = opsConsoleTelemetryService(db, gate);

  function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw badRequest("Validation error", parsed.error.issues);
    return parsed.data;
  }

  async function audit(
    req: Request,
    companyId: string,
    entityType: string,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/worktree/rules
   *
   * List rules for a company.
   * Query params: ?enabled=true&severity=MUST&sortBy=createdAt&sortOrder=asc&limit=50&offset=0
   */
  router.get("/companies/:companyId/worktree/rules", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const enabled =
      req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
    const severity = req.query.severity as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortOrder = req.query.sortOrder as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

    const result = await rules.listByCompany(companyId, {
      enabled,
      severity: severity as "MUST" | "SHOULD" | "MAY" | undefined,
      sortBy: sortBy as "createdAt" | "updatedAt" | "name" | "severity" | undefined,
      sortOrder: sortOrder as "asc" | "desc" | undefined,
      limit,
      offset,
    });
    res.json(result);
  });

  /**
   * POST /companies/:companyId/worktree/rules
   *
   * Create a new rule.
   */
  router.post("/companies/:companyId/worktree/rules", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { name, severity, action, predicate, decisionMap, message, enabled } = req.body;

    if (!name || !severity || !action || !predicate) {
      throw badRequest("name, severity, action, and predicate are required");
    }

    const actor = getActorInfo(req);

    const rule = await rules.create({
      companyId,
      name,
      severity,
      action,
      predicate,
      decisionMap: decisionMap ?? {},
      message,
      enabled,
      createdBy: actor.actorId,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_rule.created",
      entityType: "worktree_rule",
      entityId: rule.id,
      details: { name, severity, action },
    });

    res.status(201).json(rule);
  });

  /**
   * GET /worktree/rules/:id
   *
   * Get a single rule.
   */
  router.get("/worktree/rules/:id", async (req, res) => {
    const rule = await rules.getById(req.params.id);
    assertCompanyAccess(req, rule.companyId);
    res.json(rule);
  });

  /**
   * PATCH /worktree/rules/:id
   *
   * Update a rule.
   */
  router.patch("/worktree/rules/:id", async (req, res) => {
    const existing = await rules.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    const { name, severity, action, predicate, decisionMap, message, enabled } = req.body;
    const updated = await rules.update(req.params.id, {
      name,
      severity,
      action,
      predicate,
      decisionMap,
      message,
      enabled,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_rule.updated",
      entityType: "worktree_rule",
      entityId: req.params.id,
      details: req.body,
    });

    res.json(updated);
  });

  /**
   * DELETE /worktree/rules/:id
   *
   * Delete a rule.
   */
  router.delete("/worktree/rules/:id", async (req, res) => {
    const existing = await rules.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    await rules.delete(req.params.id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_rule.deleted",
      entityType: "worktree_rule",
      entityId: req.params.id,
      details: { name: existing.name },
    });

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Proposals
  // ---------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/worktree/proposals
   *
   * List proposals for a company.
   * Query params: ?status=proposed&proposedByAgentId=xxx&ruleId=xxx&sortBy=createdAt&sortOrder=desc&limit=50&offset=0
   */
  router.get("/companies/:companyId/worktree/proposals", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const status = req.query.status as string | undefined;
    const proposedByAgentId = req.query.proposedByAgentId as string | undefined;
    const ruleId = req.query.ruleId as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortOrder = req.query.sortOrder as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

    const result = await proposals.listByCompany(companyId, {
      status: status as "proposed" | "approved" | "rejected" | undefined,
      proposedByAgentId,
      ruleId,
      sortBy: sortBy as "createdAt" | "status" | undefined,
      sortOrder: sortOrder as "asc" | "desc" | undefined,
      limit,
      offset,
    });
    res.json(result);
  });

  /**
   * POST /companies/:companyId/worktree/proposals
   *
   * Create a new proposal.
   */
  router.post("/companies/:companyId/worktree/proposals", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { proposedByAgentId, ruleId, proposedChange, rationale } = req.body;

    if (!proposedByAgentId || !proposedChange || !rationale) {
      throw badRequest("proposedByAgentId, proposedChange, and rationale are required");
    }

    const proposal = await proposals.create({
      companyId,
      proposedByAgentId,
      ruleId,
      proposedChange,
      rationale,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_proposal.created",
      entityType: "worktree_proposal",
      entityId: proposal.id,
      details: { proposedByAgentId, ruleId },
    });

    res.status(201).json(proposal);
  });

  /**
   * GET /worktree/proposals/:id
   *
   * Get a single proposal.
   */
  router.get("/worktree/proposals/:id", async (req, res) => {
    const proposal = await proposals.getById(req.params.id);
    assertCompanyAccess(req, proposal.companyId);
    res.json(proposal);
  });

  /**
   * PATCH /worktree/proposals/:id/review
   *
   * Approve or reject a proposal.
   */
  router.patch("/worktree/proposals/:id/review", async (req, res) => {
    const existing = await proposals.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    const { status, reviewedByAgentId, reviewNote, reviewAcknowledged } = req.body;

    if (!status || !reviewedByAgentId) {
      throw badRequest("status and reviewedByAgentId are required");
    }
    if (status === "approved" && reviewAcknowledged !== true) {
      throw badRequest("Review the original rule, impact, and risk before approval");
    }

    const updated = await proposals.review(req.params.id, {
      status,
      reviewedByAgentId,
      reviewNote,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `worktree_proposal.${status}`,
      entityType: "worktree_proposal",
      entityId: req.params.id,
      details: { status, reviewedByAgentId },
    });

    res.json(updated);
  });

  // ---------------------------------------------------------------------------
  // Hermit Gate — 경로 클레임/변경 검증/병합 감사/중대 결정 원장 (r60)
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/hermit-gate/state", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const state = await gate.getState(companyId);
    res.json(state);
  });

  router.post("/companies/:companyId/hermit-gate/claims", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(ClaimRequestSchema, req.body);
    const result = await gate.claimPaths(companyId, input);
    if (result.ok) {
      await audit(req, companyId, "hermit_gate", "hermit_gate.claim.granted", result.claim.claimId, {
        taskId: input.taskId,
        paths: result.claim.paths,
      });
      res.status(201).json({ ok: true, claim: result.claim });
      return;
    }
    await audit(req, companyId, "hermit_gate", "hermit_gate.claim.held", input.taskId, {
      conflicts: result.conflicts,
    });
    res.status(409).json({ error: result.resumeCondition, conflicts: result.conflicts, verdict: result.verdict });
  });

  router.delete("/companies/:companyId/hermit-gate/claims/:taskId", async (req, res) => {
    const { companyId, taskId } = req.params;
    assertCompanyAccess(req, companyId);
    const released = await gate.releaseTaskClaims(companyId, taskId);
    if (released === 0) throw notFound("해제할 클레임이 없습니다");
    await audit(req, companyId, "hermit_gate", "hermit_gate.claim.released", taskId, { released });
    res.json({ ok: true, released });
  });

  router.post("/companies/:companyId/hermit-gate/verify", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(ChangeVerificationInputSchema, req.body);
    const verdict = await gate.verifyChanges(companyId, input);
    if (verdict.decision !== "proceed") {
      await audit(req, companyId, "hermit_gate", "hermit_gate.verify.held", input.taskId, {
        violations: verdict.violations,
      });
    }
    res.json(verdict);
  });

  router.post("/companies/:companyId/hermit-gate/merges", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(MergeRecordInputSchema, req.body);
    const result = await gate.recordMergedPr(companyId, input);
    await audit(req, companyId, "hermit_gate", "hermit_gate.merge.recorded", String(input.prNumber), {
      mergeSha: input.mergeSha,
      duplicate: result.duplicate,
      auditActive: result.auditState.auditActive,
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  router.post("/companies/:companyId/hermit-gate/merges/check", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(z.object({ changedPaths: z.array(z.string()), isAuditFix: z.boolean().optional() }), req.body);
    res.json(await gate.checkMergeGate(companyId, input));
  });

  router.post("/companies/:companyId/hermit-gate/audit/scope", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(AuditScopeInputSchema, req.body);
    const auditState = await gate.setAuditScope(companyId, input.blockedScopes);
    await audit(req, companyId, "hermit_gate", "hermit_gate.audit.scope_set", "audit", input);
    res.json(auditState);
  });

  router.post("/companies/:companyId/hermit-gate/audit/complete", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(AuditCompleteInputSchema, req.body);
    const auditState = await gate.completeAudit(companyId, input.auditedThroughSha);
    await audit(req, companyId, "hermit_gate", "hermit_gate.audit.completed", "audit", input);
    res.json(auditState);
  });

  router.post("/companies/:companyId/hermit-gate/decisions", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(DecisionRecordSchema, req.body);
    const decision = await gate.recordDecision(companyId, input);
    await audit(req, companyId, "hermit_gate", "hermit_gate.decision.recorded", decision.id, {
      taskId: input.taskId,
      decision: input.decision,
    });
    res.status(201).json(decision);
  });

  router.patch("/companies/:companyId/hermit-gate/decisions/:decisionId", async (req, res) => {
    const { companyId, decisionId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(DecisionUpdateInputSchema, req.body);
    const updated = await gate.updateDecision(companyId, decisionId, input.reason);
    if (!updated) throw notFound("결정 기록을 찾을 수 없습니다");
    await audit(req, companyId, "hermit_gate", "hermit_gate.decision.updated", decisionId, input);
    res.json(updated);
  });

  // ---------------------------------------------------------------------------
  // Ops Console — 리소스/프로세스/대기 큐
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/ops-console/overview", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const [resources, backgroundProcesses, openWaits] = await Promise.all([
      telemetry.getResourceSnapshot(companyId),
      telemetry.listBackgroundProcesses(companyId),
      telemetry.getOpenWaits(companyId),
    ]);
    res.json({ resources, backgroundProcesses, openWaits });
  });

  router.put("/companies/:companyId/ops-console/thresholds", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(ThresholdsInputSchema, req.body);
    const thresholds = await telemetry.updateThresholds(companyId, input);
    await audit(req, companyId, "ops_console", "ops_console.thresholds.updated", "resources", { ...thresholds });
    res.json(thresholds);
  });

  router.post("/companies/:companyId/ops-console/processes/:pid/stop", async (req, res) => {
    const { companyId, pid } = req.params;
    assertCompanyAccess(req, companyId);
    const pidNumber = Number(pid);
    if (!Number.isInteger(pidNumber)) throw badRequest("pid 는 정수여야 합니다");
    const result = await telemetry.stopBackgroundProcess(companyId, pidNumber);
    if (result.ok) {
      await audit(req, companyId, "ops_console", "ops_console.process.stopped", String(pidNumber), { pid: pidNumber });
      res.json(result);
      return;
    }
    res.status(409).json({ error: result.reason, ...result });
  });

  router.get("/companies/:companyId/ops-console/queue", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
    res.json({ items: await queue.listCompanyQueue(companyId, agentId) });
  });

  router.post("/companies/:companyId/ops-console/queue/reorder", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(QueueReorderInputSchema, req.body);
    const items = await queue.reorderQueue(companyId, input.orderedIds);
    await audit(req, companyId, "ops_console", "ops_console.queue.reordered", "queue", input);
    res.json({ items });
  });

  router.patch("/companies/:companyId/ops-console/queue/:wakeupId", async (req, res) => {
    const { companyId, wakeupId } = req.params;
    assertCompanyAccess(req, companyId);
    const input = parseBody(QueueEditInputSchema, req.body);
    const item = await queue.editQueuedWakeup(companyId, wakeupId, input);
    await audit(req, companyId, "ops_console", "ops_console.queue.edited", wakeupId, input);
    res.json(item);
  });

  router.post("/companies/:companyId/ops-console/queue/:wakeupId/cancel", async (req, res) => {
    const { companyId, wakeupId } = req.params;
    assertCompanyAccess(req, companyId);
    const cancelled = await queue.cancelQueuedWakeup(companyId, wakeupId);
    if (!cancelled) throw notFound("취소할 대기 항목을 찾을 수 없습니다");
    await audit(req, companyId, "ops_console", "ops_console.queue.cancelled", wakeupId, {});
    res.json({ ok: true });
  });

  return router;
}
