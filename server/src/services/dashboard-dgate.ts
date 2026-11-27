import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  costEvents,
  heartbeatRuns,
  issues,
  operatorDecisions,
  worktreeRuleProposals,
} from "@paperclipai/db";
import type {
  ControlPlaneEvent,
  ControlPlaneGateItem,
  ControlPlaneSeverity,
  ControlPlaneSnapshotResponse,
  ControlPlaneWorker,
} from "@paperclipai/shared";

const WORKERS_LIMIT = 25;
const GATES_PER_KIND_LIMIT = 20;
const RECENT_EVENTS_LIMIT = 20;
const OUTCOME_WINDOW_HOURS = 24;
const OUTCOME_WINDOW_MS = OUTCOME_WINDOW_HOURS * 60 * 60 * 1000;

export interface ControlPlaneAgentCountRow {
  status: string;
  count: number;
}

export interface ControlPlaneWorkerRunRow {
  runId: string;
  status: string;
  agentId: string;
  agentName: string | null;
  agentRole: string | null;
  adapterType: string | null;
  adapterConfig: Record<string, unknown> | null;
  usageJson: Record<string, unknown> | null;
  invocationSource: string;
  triggerDetail: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface ControlPlaneRunModelRow {
  heartbeatRunId: string | null;
  model: string | null;
}

export interface ControlPlaneOutcomeRow {
  status: string;
  adapterType: string | null;
  count: number;
}

export interface ControlPlaneProviderCountRow {
  provider: string | null;
  count: number;
}

export interface ControlPlaneApprovalRow {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ControlPlaneDecisionRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
}

export interface ControlPlaneWorktreeProposalRow {
  id: string;
  rationale: string;
  status: string;
  createdAt: Date;
}

export interface ControlPlaneBudgetIncidentRow {
  id: string;
  scopeType: string;
  metric: string;
  thresholdType: string;
  amountLimit: number;
  amountObserved: number;
  status: string;
  createdAt: Date;
}

export interface ControlPlaneActivityRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pickSafeText(obj: Record<string, unknown> | null | undefined, keys: string[], maxLen = 120): string | null {
  if (!obj || !isPlainObject(obj)) return null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
      }
    }
  }
  return null;
}

function normalizeSeverity(raw: string | null | undefined, fallback: ControlPlaneSeverity = "medium"): ControlPlaneSeverity {
  if (raw === "critical" || raw === "high" || raw === "medium" || raw === "low") {
    return raw;
  }
  return fallback;
}

function formatApprovalSeverity(type: string): ControlPlaneSeverity {
  const lower = type.toLowerCase();
  if (lower.includes("budget") || lower.includes("deploy") || lower.includes("secret")) {
    return "critical";
  }
  return "high";
}

function formatContextLabel(run: ControlPlaneWorkerRunRow): string {
  if (run.issueIdentifier && run.issueTitle) {
    const title = run.issueTitle.trim();
    return `${run.issueIdentifier} · ${title.length > 72 ? `${title.slice(0, 71)}…` : title}`;
  }
  if (run.issueIdentifier) return run.issueIdentifier;
  if (run.issueTitle?.trim()) {
    const title = run.issueTitle.trim();
    return title.length > 80 ? `${title.slice(0, 79)}…` : title;
  }
  if (run.triggerDetail?.trim()) return run.triggerDetail.trim();
  return run.invocationSource || "heartbeat";
}

function formatActivitySummary(row: ControlPlaneActivityRow): string {
  const detailHint = pickSafeText(row.details, ["title", "name", "identifier", "status", "reason"], 80);
  const base = `${row.action} (${row.entityType})`;
  return detailHint ? `${base}: ${detailHint}` : base;
}

export function buildControlPlaneSnapshotFromRows(input: {
  now: Date;
  agentCounts: ControlPlaneAgentCountRow[];
  workerRuns: ControlPlaneWorkerRunRow[];
  runModels: ControlPlaneRunModelRow[];
  activeRunCounts: { running: number; queued: number };
  outcomeRows: ControlPlaneOutcomeRow[];
  providerRows: ControlPlaneProviderCountRow[];
  pendingApprovalsCount: number;
  pendingDecisionsCount: number;
  openBudgetIncidentsCount: number;
  pendingWorktreeProposalsCount: number;
  approvalRows: ControlPlaneApprovalRow[];
  decisionRows: ControlPlaneDecisionRow[];
  worktreeProposalRows: ControlPlaneWorktreeProposalRow[];
  budgetIncidentRows: ControlPlaneBudgetIncidentRow[];
  activityRows: ControlPlaneActivityRow[];
}): ControlPlaneSnapshotResponse {
  const nowMs = input.now.getTime();

  let totalAgents = 0;
  let activeAgents = 0;
  for (const row of input.agentCounts) {
    const count = Number(row.count ?? 0);
    totalAgents += count;
    if (row.status === "running" || row.status === "idle" || row.status === "active") {
      activeAgents += count;
    }
  }

  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let timedOut = 0;
  let running24h = 0;
  let queued24h = 0;
  const byAdapter: Record<string, number> = {};

  for (const row of input.outcomeRows) {
    const count = Number(row.count ?? 0);
    if (count <= 0) continue;
    switch (row.status) {
      case "succeeded":
        succeeded += count;
        break;
      case "failed":
        failed += count;
        break;
      case "cancelled":
        cancelled += count;
        break;
      case "timed_out":
        timedOut += count;
        break;
      case "running":
        running24h += count;
        break;
      case "queued":
        queued24h += count;
        break;
      default:
        break;
    }
    const adapterKey = row.adapterType?.trim() || "process";
    byAdapter[adapterKey] = (byAdapter[adapterKey] ?? 0) + count;
  }

  const byProvider: Record<string, number> = {};
  for (const row of input.providerRows) {
    const count = Number(row.count ?? 0);
    if (count <= 0) continue;
    const providerKey = row.provider?.trim() || "unknown";
    byProvider[providerKey] = (byProvider[providerKey] ?? 0) + count;
  }

  const terminalForPassRate = succeeded + failed + timedOut;
  const passRatePct =
    terminalForPassRate > 0 ? round1((succeeded / terminalForPassRate) * 100) : 0;

  const modelByRunId = new Map<string, string>();
  for (const row of input.runModels) {
    if (row.heartbeatRunId && row.model?.trim()) {
      modelByRunId.set(row.heartbeatRunId, row.model.trim());
    }
  }

  const workers: ControlPlaneWorker[] = input.workerRuns.map((run) => {
    const usageModel = pickSafeText(run.usageJson, ["model"], 80);
    const configModel = pickSafeText(run.adapterConfig, ["model"], 80);
    const model = modelByRunId.get(run.runId) ?? usageModel ?? configModel ?? null;

    const startedMs = run.startedAt ? run.startedAt.getTime() : null;
    const finishedMs = run.finishedAt ? run.finishedAt.getTime() : null;
    const durationMs =
      startedMs !== null ? Math.max(0, (finishedMs ?? nowMs) - startedMs) : 0;

    return {
      agentId: run.agentId,
      agentName: run.agentName?.trim() || run.agentId,
      role: run.agentRole?.trim() || "general",
      adapterType: run.adapterType?.trim() || "process",
      model,
      status: run.status,
      runId: run.runId,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      durationMs,
      contextLabel: formatContextLabel(run),
    };
  });

  const approvalGates: ControlPlaneGateItem[] = input.approvalRows.map((row) => {
    const payloadTitle = pickSafeText(row.payload, ["title", "name", "summary", "action"], 100);
    return {
      id: row.id,
      kind: "approval",
      title: payloadTitle ? `${row.type}: ${payloadTitle}` : `Approval: ${row.type}`,
      status: row.status,
      severity: formatApprovalSeverity(row.type),
      createdAt: row.createdAt.toISOString(),
      linkPath: `/approvals/${row.id}`,
    };
  });

  const decisionGates: ControlPlaneGateItem[] = input.decisionRows.map((row) => ({
    id: row.id,
    kind: "operator_decision",
    title: row.title.trim() || "Operator decision",
    status: row.status,
    severity: normalizeSeverity(row.priority, "medium"),
    createdAt: row.createdAt.toISOString(),
    linkPath: `/decisions/${row.id}`,
  }));

  const worktreeGates: ControlPlaneGateItem[] = input.worktreeProposalRows.map((row) => {
    const rationale = row.rationale.trim();
    return {
      id: row.id,
      kind: "worktree_proposal",
      title: rationale.length > 120 ? `${rationale.slice(0, 119)}…` : rationale || "Worktree rule proposal",
      status: row.status,
      severity: "medium",
      createdAt: row.createdAt.toISOString(),
      linkPath: "/worktrees",
    };
  });

  const budgetGates: ControlPlaneGateItem[] = input.budgetIncidentRows.map((row) => ({
    id: row.id,
    kind: "budget_incident",
    title: `${row.scopeType} ${row.thresholdType} budget threshold (${row.metric}: ${row.amountObserved}/${row.amountLimit})`,
    status: row.status,
    severity: row.thresholdType === "hard" ? "critical" : "high",
    createdAt: row.createdAt.toISOString(),
    linkPath: "/costs",
  }));

  const recentEvents: ControlPlaneEvent[] = input.activityRows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorType: row.actorType,
    createdAt: row.createdAt.toISOString(),
    summary: formatActivitySummary(row),
  }));

  const totalOutcomes = succeeded + failed + cancelled + timedOut + running24h + queued24h;

  return {
    connected: true,
    source: "paperwork_internal",
    timestamp: input.now.toISOString(),
    summary: {
      activeRuns: input.activeRunCounts.running,
      queuedRuns: input.activeRunCounts.queued,
      activeAgents,
      totalAgents,
      pendingApprovals: input.pendingApprovalsCount,
      pendingDecisions: input.pendingDecisionsCount,
      openBudgetIncidents: input.openBudgetIncidentsCount,
      pendingWorktreeProposals: input.pendingWorktreeProposalsCount,
      passRatePct,
    },
    workers,
    gates: {
      approvals: approvalGates,
      operatorDecisions: decisionGates,
      worktreeProposals: worktreeGates,
      budgetIncidents: budgetGates,
    },
    outcomes: {
      windowHours: OUTCOME_WINDOW_HOURS,
      total: totalOutcomes,
      succeeded,
      failed,
      cancelled,
      timedOut,
      running: running24h,
      queued: queued24h,
      byAdapter,
      byProvider,
    },
    recentEvents,
  };
}

export interface DashboardDgateServiceOptions {
  now?: () => Date;
}

export function dashboardDgateService(db: Db, options: DashboardDgateServiceOptions = {}) {
  const getNow = options.now ?? (() => new Date());

  return {
    getSnapshot: async (companyId: string): Promise<ControlPlaneSnapshotResponse> => {
      const now = getNow();
      const since24h = new Date(now.getTime() - OUTCOME_WINDOW_MS);

      const [
        agentCounts,
        activeRunRows,
        workerRuns,
        outcomeRows,
        providerRows,
        pendingApprovalsAgg,
        pendingDecisionsAgg,
        openBudgetIncidentsAgg,
        pendingWorktreeProposalsAgg,
        approvalRows,
        decisionRows,
        worktreeProposalRows,
        budgetIncidentRows,
        activityRows,
      ] = await Promise.all([
        db
          .select({
            status: agents.status,
            count: sql<number>`count(*)::int`,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.status),

        db
          .select({
            status: heartbeatRuns.status,
            count: sql<number>`count(*)::int`,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, ["running", "queued"]),
            ),
          )
          .groupBy(heartbeatRuns.status),

        db
          .select({
            runId: heartbeatRuns.id,
            status: heartbeatRuns.status,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            agentRole: agents.role,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
            usageJson: heartbeatRuns.usageJson,
            invocationSource: heartbeatRuns.invocationSource,
            triggerDetail: heartbeatRuns.triggerDetail,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .leftJoin(issues, eq(heartbeatRuns.issueId, issues.id))
          .where(eq(heartbeatRuns.companyId, companyId))
          .orderBy(
            sql`case when ${heartbeatRuns.status} = 'running' then 0 when ${heartbeatRuns.status} = 'queued' then 1 else 2 end`,
            desc(heartbeatRuns.createdAt),
          )
          .limit(WORKERS_LIMIT),

        db
          .select({
            status: heartbeatRuns.status,
            adapterType: agents.adapterType,
            count: sql<number>`count(*)::int`,
          })
          .from(heartbeatRuns)
          .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, since24h)))
          .groupBy(heartbeatRuns.status, agents.adapterType),

        db
          .select({
            provider: costEvents.provider,
            count: sql<number>`count(*)::int`,
          })
          .from(costEvents)
          .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, since24h)))
          .groupBy(costEvents.provider),

        db
          .select({ count: sql<number>`count(*)::int` })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"))),

        db
          .select({ count: sql<number>`count(*)::int` })
          .from(operatorDecisions)
          .where(and(eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.status, "pending"))),

        db
          .select({ count: sql<number>`count(*)::int` })
          .from(budgetIncidents)
          .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open"))),

        db
          .select({ count: sql<number>`count(*)::int` })
          .from(worktreeRuleProposals)
          .where(
            and(
              eq(worktreeRuleProposals.companyId, companyId),
              eq(worktreeRuleProposals.status, "proposed"),
            ),
          ),

        db
          .select({
            id: approvals.id,
            type: approvals.type,
            status: approvals.status,
            payload: approvals.payload,
            createdAt: approvals.createdAt,
          })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .orderBy(desc(approvals.createdAt))
          .limit(GATES_PER_KIND_LIMIT),

        db
          .select({
            id: operatorDecisions.id,
            title: operatorDecisions.title,
            status: operatorDecisions.status,
            priority: operatorDecisions.priority,
            createdAt: operatorDecisions.createdAt,
          })
          .from(operatorDecisions)
          .where(and(eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.status, "pending")))
          .orderBy(desc(operatorDecisions.createdAt))
          .limit(GATES_PER_KIND_LIMIT),

        db
          .select({
            id: worktreeRuleProposals.id,
            rationale: worktreeRuleProposals.rationale,
            status: worktreeRuleProposals.status,
            createdAt: worktreeRuleProposals.createdAt,
          })
          .from(worktreeRuleProposals)
          .where(
            and(
              eq(worktreeRuleProposals.companyId, companyId),
              eq(worktreeRuleProposals.status, "proposed"),
            ),
          )
          .orderBy(desc(worktreeRuleProposals.createdAt))
          .limit(GATES_PER_KIND_LIMIT),

        db
          .select({
            id: budgetIncidents.id,
            scopeType: budgetIncidents.scopeType,
            metric: budgetIncidents.metric,
            thresholdType: budgetIncidents.thresholdType,
            amountLimit: budgetIncidents.amountLimit,
            amountObserved: budgetIncidents.amountObserved,
            status: budgetIncidents.status,
            createdAt: budgetIncidents.createdAt,
          })
          .from(budgetIncidents)
          .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
          .orderBy(desc(budgetIncidents.createdAt))
          .limit(GATES_PER_KIND_LIMIT),

        db
          .select({
            id: activityLog.id,
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            actorType: activityLog.actorType,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId))
          .orderBy(desc(activityLog.createdAt))
          .limit(RECENT_EVENTS_LIMIT),
      ]);

      const runIds = workerRuns.map((r) => r.runId);
      const runModels: ControlPlaneRunModelRow[] =
        runIds.length > 0
          ? await db
              .select({
                heartbeatRunId: costEvents.heartbeatRunId,
                model: sql<string | null>`max(${costEvents.model})`,
              })
              .from(costEvents)
              .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.heartbeatRunId, runIds)))
              .groupBy(costEvents.heartbeatRunId)
          : [];

      let runningCount = 0;
      let queuedCount = 0;
      for (const row of activeRunRows) {
        if (row.status === "running") runningCount += Number(row.count ?? 0);
        if (row.status === "queued") queuedCount += Number(row.count ?? 0);
      }

      return buildControlPlaneSnapshotFromRows({
        now,
        agentCounts,
        workerRuns,
        runModels,
        activeRunCounts: { running: runningCount, queued: queuedCount },
        outcomeRows,
        providerRows,
        pendingApprovalsCount: Number(pendingApprovalsAgg[0]?.count ?? 0),
        pendingDecisionsCount: Number(pendingDecisionsAgg[0]?.count ?? 0),
        openBudgetIncidentsCount: Number(openBudgetIncidentsAgg[0]?.count ?? 0),
        pendingWorktreeProposalsCount: Number(pendingWorktreeProposalsAgg[0]?.count ?? 0),
        approvalRows,
        decisionRows,
        worktreeProposalRows,
        budgetIncidentRows,
        activityRows,
      });
    },
  };
}
