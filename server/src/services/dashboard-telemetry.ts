import os from "node:os";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import type {
  DashboardLiveSession,
  DashboardTelemetryBucket,
  DashboardTelemetryResponse,
  DashboardTelemetryWindow,
  DashboardUsageShare,
} from "@paperclipai/shared";

export const TELEMETRY_WINDOWS: readonly DashboardTelemetryWindow[] = ["10m", "1h", "6h", "24h"];
export const DEFAULT_TELEMETRY_WINDOW: DashboardTelemetryWindow = "6h";
const TOP_MODEL_LIMIT = 5;
const RECENT_RUNS_LIMIT = 40;
/**
 * cost_events 단일 스캔 상한. 이 쿼리는 UI 가 10 초 폴링하므로 24h 창의 행 수가
 * 무제한으로 늘어나는 것을 막는 안전 가드다. LIMIT 초과 시 최근(occurredAt 내림차순)
 * 이벤트만 유지하고 나머지는 응답에서 생략하며, 잘렸을 때는 경고를 남긴다.
 */
const COST_EVENTS_SCAN_LIMIT = 50_000;

interface WindowSpec {
  window: DashboardTelemetryWindow;
  windowMs: number;
  bucketCount: number;
  bucketMs: number;
}

const WINDOW_SPECS: Record<DashboardTelemetryWindow, WindowSpec> = {
  "10m": { window: "10m", windowMs: 10 * 60_000, bucketCount: 10, bucketMs: 60_000 },
  "1h": { window: "1h", windowMs: 60 * 60_000, bucketCount: 12, bucketMs: 5 * 60_000 },
  "6h": { window: "6h", windowMs: 6 * 60 * 60_000, bucketCount: 12, bucketMs: 30 * 60_000 },
  "24h": { window: "24h", windowMs: 24 * 60 * 60_000, bucketCount: 24, bucketMs: 60 * 60_000 },
};

export function parseTelemetryWindow(raw: unknown): DashboardTelemetryWindow {
  if (typeof raw === "string" && raw in WINDOW_SPECS) {
    return raw as DashboardTelemetryWindow;
  }
  return DEFAULT_TELEMETRY_WINDOW;
}

export interface TelemetryCostEventRow {
  id: string;
  agentId: string;
  agentName: string | null;
  projectId: string | null;
  projectName: string | null;
  heartbeatRunId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
}

export interface TelemetryRunRow {
  runId: string;
  status: string;
  agentId: string;
  agentName: string | null;
  adapterType: string | null;
  projectId: string | null;
  projectName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  usageJson: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface TelemetryRunCostAggRow {
  heartbeatRunId: string | null;
  totalTokens: number;
  outputTokens: number;
  costCents: number;
  model: string | null;
  provider: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatUtcHHmm(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function extractNumber(obj: Record<string, unknown> | null | undefined, keys: string[]): number {
  if (!obj) return 0;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return 0;
}

function extractString(obj: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return null;
}

function computeHostMetrics(activeRuns: number): DashboardTelemetryResponse["host"] {
  const cpuCount = Math.max(1, os.cpus().length);
  const load1 = os.loadavg()[0] ?? 0;
  const cpuPct = Math.min(100, Math.max(0, round1((load1 / cpuCount) * 100)));

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const ramPct = totalMem > 0 ? Math.min(100, Math.max(0, round1((usedMem / totalMem) * 100))) : 0;
  const ramTotalGb = round1(totalMem / 1024 ** 3);
  const ramUsedGb = round1(usedMem / 1024 ** 3);

  return {
    cpuPct,
    ramPct,
    ramUsedGb,
    ramTotalGb,
    activeRuns,
  };
}

function buildUsageShares(
  entries: Map<string, { id: string; name: string; tokens: number; costCents: number }>,
  kind: "project" | "agent",
  totalTokens: number,
): DashboardUsageShare[] {
  return Array.from(entries.values())
    .sort((a, b) => b.tokens - a.tokens || b.costCents - a.costCents || a.name.localeCompare(b.name))
    .map((item) => ({
      id: item.id,
      name: item.name,
      kind,
      tokens: item.tokens,
      costCents: item.costCents,
      sharePct: totalTokens > 0 ? round1((item.tokens / totalTokens) * 100) : 0,
    }));
}

export function buildDashboardTelemetryFromRows(input: {
  window: DashboardTelemetryWindow;
  now: Date;
  costRows: TelemetryCostEventRow[];
  runRows: TelemetryRunRow[];
  runCostRows: TelemetryRunCostAggRow[];
  hostMetrics?: DashboardTelemetryResponse["host"];
}): DashboardTelemetryResponse {
  const spec = WINDOW_SPECS[input.window];
  const nowMs = input.now.getTime();
  const firstBucketStartMs = nowMs - spec.windowMs;

  const rawBuckets = Array.from({ length: spec.bucketCount }, (_, idx) => {
    const startMs = firstBucketStartMs + idx * spec.bucketMs;
    return {
      ts: new Date(startMs).toISOString(),
      label: formatUtcHHmm(startMs),
      totalTokens: 0,
      costCents: 0,
      runIds: new Set<string>(),
      anonRuns: 0,
      rawByModel: new Map<string, number>(),
    };
  });

  const modelTotals = new Map<string, number>();
  const projectTotals = new Map<string, { id: string; name: string; tokens: number; costCents: number }>();
  const agentTotals = new Map<string, { id: string; name: string; tokens: number; costCents: number }>();
  const windowTokensByRunId = new Map<string, number>();

  let totalWindowTokens = 0;
  let totalWindowCostCents = 0;

  for (const row of input.costRows) {
    const tokens = Math.max(
      0,
      Number(row.inputTokens ?? 0) + Number(row.cachedInputTokens ?? 0) + Number(row.outputTokens ?? 0),
    );
    const costCents = Number(row.costCents ?? 0);
    const modelKey = row.model?.trim() || row.provider?.trim() || "unknown";
    const occurredMs = row.occurredAt instanceof Date ? row.occurredAt.getTime() : new Date(row.occurredAt).getTime();
    const bucketIdx = Math.min(
      spec.bucketCount - 1,
      Math.max(0, Math.floor((occurredMs - firstBucketStartMs) / spec.bucketMs)),
    );

    const bucket = rawBuckets[bucketIdx];
    if (bucket) {
      bucket.totalTokens += tokens;
      bucket.costCents += costCents;
      if (row.heartbeatRunId) {
        bucket.runIds.add(row.heartbeatRunId);
      } else {
        bucket.anonRuns += 1;
      }
      bucket.rawByModel.set(modelKey, (bucket.rawByModel.get(modelKey) ?? 0) + tokens);
    }

    totalWindowTokens += tokens;
    totalWindowCostCents += costCents;
    modelTotals.set(modelKey, (modelTotals.get(modelKey) ?? 0) + tokens);

    if (row.heartbeatRunId) {
      windowTokensByRunId.set(row.heartbeatRunId, (windowTokensByRunId.get(row.heartbeatRunId) ?? 0) + tokens);
    }

    const agentEntry = agentTotals.get(row.agentId) ?? {
      id: row.agentId,
      name: row.agentName?.trim() || row.agentId,
      tokens: 0,
      costCents: 0,
    };
    agentEntry.tokens += tokens;
    agentEntry.costCents += costCents;
    agentTotals.set(row.agentId, agentEntry);

    const projId = row.projectId ?? "unassigned";
    const projName = row.projectId ? (row.projectName?.trim() || row.projectId) : "Unassigned";
    const projEntry = projectTotals.get(projId) ?? {
      id: projId,
      name: projName,
      tokens: 0,
      costCents: 0,
    };
    projEntry.tokens += tokens;
    projEntry.costCents += costCents;
    projectTotals.set(projId, projEntry);
  }

  const sortedModels = Array.from(modelTotals.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model);

  const topModels = sortedModels.slice(0, TOP_MODEL_LIMIT);
  const topModelSet = new Set(topModels);
  const hasOther = sortedModels.length > TOP_MODEL_LIMIT;
  const models = hasOther ? [...topModels, "other"] : topModels;

  const buckets: DashboardTelemetryBucket[] = rawBuckets.map((b) => {
    const byModel: Record<string, number> = {};
    for (const m of models) {
      byModel[m] = 0;
    }
    for (const [modelKey, tok] of b.rawByModel.entries()) {
      if (topModelSet.has(modelKey)) {
        byModel[modelKey] = (byModel[modelKey] ?? 0) + tok;
      } else if (hasOther) {
        byModel.other = (byModel.other ?? 0) + tok;
      }
    }
    return {
      ts: b.ts,
      label: b.label,
      totalTokens: b.totalTokens,
      costCents: b.costCents,
      runs: b.runIds.size + b.anonRuns,
      byModel,
    };
  });

  const runCostByRunId = new Map<string, TelemetryRunCostAggRow>();
  for (const agg of input.runCostRows) {
    if (agg.heartbeatRunId) {
      runCostByRunId.set(agg.heartbeatRunId, agg);
    }
  }

  const sessions: DashboardLiveSession[] = input.runRows.map((run) => {
    const isActive = run.status === "running" || run.status === "queued";
    const costAgg = runCostByRunId.get(run.runId);
    const usage = isPlainObject(run.usageJson) ? run.usageJson : null;

    const usageInput = extractNumber(usage, ["inputTokens", "input_tokens"]);
    const usageCached = extractNumber(usage, ["cachedInputTokens", "cached_input_tokens"]);
    const usageOutput = extractNumber(usage, ["outputTokens", "output_tokens"]);
    const usageTotal = usageInput + usageCached + usageOutput;
    const usageCostCents = extractNumber(usage, ["costCents", "cost_cents"]);

    const totalTokens = costAgg && costAgg.totalTokens > 0 ? costAgg.totalTokens : usageTotal;
    const outputTokens = costAgg && costAgg.outputTokens > 0 ? costAgg.outputTokens : usageOutput;
    const costCents = costAgg && costAgg.costCents > 0 ? costAgg.costCents : usageCostCents;
    const recentTokens = windowTokensByRunId.get(run.runId) ?? 0;

    const model = costAgg?.model?.trim() || extractString(usage, ["model"]) || null;
    const provider = costAgg?.provider?.trim() || extractString(usage, ["provider"]) || null;

    const startedMs = run.startedAt ? run.startedAt.getTime() : null;
    const finishedMs = run.finishedAt ? run.finishedAt.getTime() : null;
    const elapsedMs =
      startedMs !== null ? Math.max(0, (finishedMs ?? nowMs) - startedMs) : 0;

    const burnRateTokPerHour =
      elapsedMs > 0 && totalTokens > 0
        ? Math.round((totalTokens / Math.max(elapsedMs, 10_000)) * 3_600_000)
        : 0;

    return {
      runId: run.runId,
      status: run.status,
      isActive,
      agentId: run.agentId,
      agentName: run.agentName?.trim() || run.agentId,
      adapterType: run.adapterType?.trim() || "process",
      model,
      provider,
      projectId: run.projectId ?? null,
      projectName: run.projectName ?? null,
      issueId: run.issueId ?? null,
      issueIdentifier: run.issueIdentifier ?? null,
      issueTitle: run.issueTitle ?? null,
      recentTokens,
      totalTokens,
      outputTokens,
      costCents,
      burnRateTokPerHour,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      elapsedMs,
    };
  });

  const activeSessions = sessions.filter((s) => s.isActive).length;
  const idleSessions = sessions.length - activeSessions;

  const windowHours = spec.windowMs / 3_600_000;
  const bucketHours = spec.bucketMs / 3_600_000;
  const peakBucketTokens = buckets.reduce((max, b) => (b.totalTokens > max ? b.totalTokens : max), 0);

  return {
    window: input.window,
    generatedAt: input.now.toISOString(),
    velocity: {
      tokensPerHour: Math.round(totalWindowTokens / windowHours),
      peakTokensPerHour: Math.round(peakBucketTokens / bucketHours),
      totalTokens: totalWindowTokens,
      avgTokensPerBucket: spec.bucketCount > 0 ? Math.round(totalWindowTokens / spec.bucketCount) : 0,
      totalCostCents: totalWindowCostCents,
      activeSessions,
      idleSessions,
    },
    host: input.hostMetrics ?? computeHostMetrics(activeSessions),
    models,
    buckets,
    projectShares: buildUsageShares(projectTotals, "project", totalWindowTokens),
    agentShares: buildUsageShares(agentTotals, "agent", totalWindowTokens),
    sessions,
  };
}

export interface DashboardTelemetryServiceOptions {
  now?: () => Date;
}

export function dashboardTelemetryService(db: Db, options: DashboardTelemetryServiceOptions = {}) {
  const getNow = options.now ?? (() => new Date());

  return {
    telemetry: async (companyId: string, rawWindow?: unknown): Promise<DashboardTelemetryResponse> => {
      const window = parseTelemetryWindow(rawWindow);
      const spec = WINDOW_SPECS[window];
      const now = getNow();
      const windowStart = new Date(now.getTime() - spec.windowMs);

      const [costRows, runRows] = await Promise.all([
        db
          .select({
            id: costEvents.id,
            agentId: costEvents.agentId,
            agentName: agents.name,
            projectId: costEvents.projectId,
            projectName: projects.name,
            heartbeatRunId: costEvents.heartbeatRunId,
            provider: costEvents.provider,
            model: costEvents.model,
            inputTokens: costEvents.inputTokens,
            cachedInputTokens: costEvents.cachedInputTokens,
            outputTokens: costEvents.outputTokens,
            costCents: costEvents.costCents,
            occurredAt: costEvents.occurredAt,
          })
          .from(costEvents)
          .leftJoin(agents, eq(costEvents.agentId, agents.id))
          .leftJoin(projects, eq(costEvents.projectId, projects.id))
          .where(
            and(
              eq(costEvents.companyId, companyId),
              gte(costEvents.occurredAt, windowStart),
              lte(costEvents.occurredAt, now),
            ),
          )
          .orderBy(desc(costEvents.occurredAt))
          .limit(COST_EVENTS_SCAN_LIMIT),
        db
          .select({
            runId: heartbeatRuns.id,
            status: heartbeatRuns.status,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            adapterType: agents.adapterType,
            projectId: issues.projectId,
            projectName: projects.name,
            issueId: heartbeatRuns.issueId,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            usageJson: heartbeatRuns.usageJson,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .leftJoin(issues, eq(heartbeatRuns.issueId, issues.id))
          .leftJoin(projects, eq(issues.projectId, projects.id))
          .where(eq(heartbeatRuns.companyId, companyId))
          .orderBy(
            sql`case when ${heartbeatRuns.status} in ('running', 'queued') then 0 else 1 end`,
            desc(heartbeatRuns.createdAt),
          )
          .limit(RECENT_RUNS_LIMIT),
      ]);

      if (costRows.length >= COST_EVENTS_SCAN_LIMIT) {
        console.warn(
          `[dashboard-telemetry] cost_events scan hit the ${COST_EVENTS_SCAN_LIMIT}-row limit (company=${companyId}, window=${window}); older events are omitted`,
        );
      }

      const runIds = runRows.map((r) => r.runId);
      const runCostRows: TelemetryRunCostAggRow[] =
        runIds.length > 0
          ? await db
              .select({
                heartbeatRunId: costEvents.heartbeatRunId,
                totalTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}), 0)::int`,
                outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
                costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
                model: sql<string | null>`max(${costEvents.model})`,
                provider: sql<string | null>`max(${costEvents.provider})`,
              })
              .from(costEvents)
              .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.heartbeatRunId, runIds)))
              .groupBy(costEvents.heartbeatRunId)
          : [];

      return buildDashboardTelemetryFromRows({
        window,
        now,
        costRows,
        runRows,
        runCostRows,
      });
    },
  };
}
