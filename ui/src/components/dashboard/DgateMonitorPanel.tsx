import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type {
  ControlPlaneEvent,
  ControlPlaneGateItem,
  ControlPlaneGates,
  ControlPlaneProviderBreakdown,
  ControlPlaneSnapshot,
  DgateDashboardBridgeResponse,
} from "@/api/dashboard";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  GitBranch,
  Layers,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";

export type DgateMonitorResponse = DgateDashboardBridgeResponse & {
  stale?: boolean;
  reason?: string | null;
};

export interface DgateMonitorPanelProps {
  dgate?: DgateMonitorResponse | null;
  loading?: boolean;
  className?: string;
}

function asStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function formatShortTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("ko-KR", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const mins = Math.floor(rounded / 60);
  const remSec = rounded % 60;
  if (mins < 60) return `${mins}m ${String(remSec).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hours}h ${String(remMin).padStart(2, "0")}m`;
}

function computeWorkerDurationSec(entry: Record<string, unknown>): number | null {
  const directSec = entry.elapsedSec ?? entry.elapsed_sec ?? entry.durationSec ?? entry.duration_sec;
  if (typeof directSec === "number" && Number.isFinite(directSec)) return Math.max(0, directSec);

  const durationMs = entry.durationMs ?? entry.duration_ms;
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    return Math.max(0, Math.round(durationMs / 1000));
  }

  const startedAt = asStr(entry.startedAt ?? entry.started_at, "");
  if (!startedAt) return null;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;

  const finishedAt = asStr(entry.finishedAt ?? entry.finished_at, "");
  const endMs = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function isWorkerActive(status: string): boolean {
  const s = status.toLowerCase();
  return s === "active" || s === "running" || s === "busy" || s === "working" || s === "in_progress";
}

function isWorkerQueued(status: string): boolean {
  const s = status.toLowerCase();
  return s === "queued" || s === "pending" || s === "waiting";
}

function isWorkerFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "error" || s === "timed_out" || s === "cancelled";
}

function statusPillClass(status: string): string {
  if (isWorkerActive(status)) {
    return "border-lime-500/40 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/40 dark:bg-[#a3e635]/10 dark:text-[#a3e635]";
  }
  if (isWorkerQueued(status)) {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]";
  }
  if (isWorkerFailed(status)) {
    return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  }
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "completed" || s === "pass" || s === "passed") {
    return "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]";
  }
  return "border-border bg-muted/40 text-muted-foreground dark:border-white/[0.07] dark:bg-[#07090d]";
}

function statusDotClass(status: string): string {
  if (isWorkerActive(status)) return "bg-lime-500 dark:bg-[#a3e635]";
  if (isWorkerQueued(status)) return "bg-amber-500 dark:bg-[#f59e0b]";
  if (isWorkerFailed(status)) return "bg-rose-500 dark:bg-rose-400";
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "completed" || s === "pass" || s === "passed") {
    return "bg-blue-500 dark:bg-[#60a5fa]";
  }
  return "bg-muted-foreground/50";
}

function roleBadgeText(entry: Record<string, unknown>, fallbackRole?: string): string {
  const raw = asStr(entry.role ?? entry.slot ?? fallbackRole, "WORKER").trim();
  if (!raw) return "WORKER";
  return raw.length > 10 ? raw.slice(0, 10).toUpperCase() : raw.toUpperCase();
}

function eventKindTone(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("fail") || k.includes("error") || k.includes("budget") || k.includes("incident") || k.includes("reject")) {
    return "border-rose-500/35 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  }
  if (k.includes("approval") || k.includes("gate") || k.includes("decision") || k.includes("proposal") || k.includes("warn")) {
    return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]";
  }
  if (k.includes("succeed") || k.includes("pass") || k.includes("approve") || k.includes("complete") || k.includes("run")) {
    return "border-lime-500/35 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:text-[#a3e635]";
  }
  return "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]";
}

interface NormalizedWorker {
  key: string;
  agentId: string | null;
  name: string;
  role: string;
  adapter: string;
  model: string;
  status: string;
  durationSec: number | null;
  activity: string;
  issueIdentifier: string;
}

function resolvePayload(dgate?: DgateMonitorResponse | null): {
  summary: ControlPlaneSnapshot["summary"] | null;
  workersRaw: Array<Record<string, unknown>>;
  gatesRaw: ControlPlaneSnapshot["gates"] | null;
  outcomesRaw: Record<string, unknown>;
  eventsRaw: ControlPlaneEvent[];
  adaptersRaw: ControlPlaneProviderBreakdown[];
  timestamp: string | null;
  scope: string;
  dbLive: boolean;
  snap: ControlPlaneSnapshot | null;
} {
  const snap = dgate?.snapshot ?? null;
  const summary = dgate?.summary ?? snap?.summary ?? null;
  const workersRaw: Array<Record<string, unknown>> = Array.isArray(dgate?.workers)
    ? (dgate.workers as Array<Record<string, unknown>>)
    : Array.isArray(snap?.workers)
      ? snap.workers
      : [];
  const gatesRaw = dgate?.gates ?? snap?.gates ?? null;
  const outcomesRaw = ((dgate?.outcomes ?? snap?.outcomes ?? {}) as Record<string, unknown>);
  const eventsRaw: ControlPlaneEvent[] = Array.isArray(dgate?.recentEvents)
    ? dgate.recentEvents
    : Array.isArray(snap?.recentEvents)
      ? snap.recentEvents
      : Array.isArray(snap?.recent_events)
        ? (snap.recent_events as ControlPlaneEvent[])
        : [];
  const adaptersRaw: ControlPlaneProviderBreakdown[] = Array.isArray(dgate?.adapters)
    ? dgate.adapters
    : Array.isArray(snap?.adapters)
      ? snap.adapters
      : Array.isArray(snap?.providers)
        ? (snap.providers as ControlPlaneProviderBreakdown[])
        : [];
  const timestamp = dgate?.timestamp ?? snap?.timestamp ?? dgate?.fetchedAt ?? null;
  const scope = snap?.scope || (dgate?.source === "paperwork_internal" ? "paperwork-internal" : "paperwork-internal");
  const dbLive = dgate?.connected === true ? true : snap?.db_live !== false;

  return {
    summary,
    workersRaw,
    gatesRaw,
    outcomesRaw,
    eventsRaw,
    adaptersRaw,
    timestamp,
    scope,
    dbLive,
    snap,
  };
}

function normalizeWorkers(
  workersRaw: Array<Record<string, unknown>>,
  snap: ControlPlaneSnapshot | null,
): NormalizedWorker[] {
  const rawList: Array<{ entry: Record<string, unknown>; fallbackRole?: string }> = [];
  for (const item of workersRaw) {
    if (item && typeof item === "object") rawList.push({ entry: item });
  }
  if (snap?.lead && typeof snap.lead === "object") {
    rawList.push({ entry: snap.lead, fallbackRole: "LEAD" });
  }
  if (Array.isArray(snap?.verifiers)) {
    for (const item of snap.verifiers) {
      if (item && typeof item === "object") rawList.push({ entry: item, fallbackRole: "VERIFIER" });
    }
  }
  if (Array.isArray(snap?.advisors)) {
    for (const item of snap.advisors) {
      if (item && typeof item === "object") rawList.push({ entry: item, fallbackRole: "ADVISOR" });
    }
  }

  const seen = new Set<string>();
  const normalized: NormalizedWorker[] = [];

  for (let idx = 0; idx < rawList.length; idx += 1) {
    const { entry, fallbackRole } = rawList[idx]!;
    const agentId = asStr(entry.agentId ?? entry.agent_id, "") || null;
    const runId = asStr(entry.runId ?? entry.run_id, "");
    const fallbackId = asStr(entry.id, "");
    const name = asStr(entry.agentName ?? entry.agent_name ?? entry.name ?? entry.label ?? fallbackId, "unnamed");
    const dedupeKey = runId || agentId || fallbackId || `${name}-${idx}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const status = asStr(entry.status, "idle");
    const adapter = asStr(entry.adapterType ?? entry.adapter_type ?? entry.adapter ?? entry.cli ?? entry.tool, "");
    const model = asStr(entry.model, "");
    const issueIdentifier = asStr(entry.issueIdentifier ?? entry.issue_identifier, "");
    const issueTitle = asStr(entry.issueTitle ?? entry.issue_title, "");
    const rawActivity = asStr(
      entry.contextLabel ?? entry.activity ?? entry.preview ?? entry.last_line ?? issueTitle,
      "",
    );

    normalized.push({
      key: dedupeKey,
      agentId: agentId ?? (fallbackId && fallbackId !== runId ? fallbackId : null),
      name,
      role: roleBadgeText(entry, fallbackRole),
      adapter,
      model,
      status,
      durationSec: computeWorkerDurationSec(entry),
      activity: rawActivity,
      issueIdentifier,
    });
  }

  return normalized.sort((a, b) => {
    const rank = (s: string) => (isWorkerActive(s) ? 0 : isWorkerQueued(s) ? 1 : isWorkerFailed(s) ? 2 : 3);
    return rank(a.status) - rank(b.status);
  });
}

interface NormalizedGates {
  pendingApprovals: number;
  ownerDecisions: number;
  worktreeProposals: number;
  budgetIncidents: number;
  totalPending: number;
  topTitles: {
    approvals?: string;
    ownerDecisions?: string;
    worktreeProposals?: string;
    budgetIncidents?: string;
  };
}

function gateCountFromField(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return asNum(value, 0);
}

function firstGateTitle(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (!first || typeof first !== "object") return undefined;
  const title = asStr((first as Record<string, unknown>).title ?? (first as Record<string, unknown>).label, "").trim();
  return title || undefined;
}

function normalizeGates(
  gatesRaw: ControlPlaneSnapshot["gates"] | null,
  summary: ControlPlaneSnapshot["summary"] | null,
  snap: ControlPlaneSnapshot | null,
): NormalizedGates {
  let pendingApprovals = asNum(summary?.pendingApprovals, 0);
  let ownerDecisions = asNum(summary?.pendingDecisions, 0);
  let worktreeProposals = asNum(summary?.pendingWorktreeProposals, 0);
  let budgetIncidents = asNum(summary?.openBudgetIncidents, 0);
  const topTitles: NormalizedGates["topTitles"] = {};

  if (gatesRaw && !Array.isArray(gatesRaw) && typeof gatesRaw === "object") {
    const g = gatesRaw as ControlPlaneGates;
    pendingApprovals = Math.max(
      pendingApprovals,
      gateCountFromField(g.approvals ?? g.pendingApprovals ?? g.pending_approvals),
    );
    ownerDecisions = Math.max(
      ownerDecisions,
      gateCountFromField(g.operatorDecisions ?? g.ownerDecisions ?? g.owner_decisions ?? g.decisions ?? g.humanOperator),
    );
    worktreeProposals = Math.max(
      worktreeProposals,
      gateCountFromField(g.worktreeProposals ?? g.worktree_proposals ?? g.proposals),
    );
    budgetIncidents = Math.max(
      budgetIncidents,
      gateCountFromField(g.budgetIncidents ?? g.budget_incidents ?? g.budget),
    );

    topTitles.approvals = firstGateTitle(g.approvals);
    topTitles.ownerDecisions = firstGateTitle(g.operatorDecisions);
    topTitles.worktreeProposals = firstGateTitle(g.worktreeProposals);
    topTitles.budgetIncidents = firstGateTitle(g.budgetIncidents);
  } else if (Array.isArray(gatesRaw)) {
    for (const item of gatesRaw as ControlPlaneGateItem[]) {
      const k = asStr(item.key ?? item.kind ?? item.label, "").toLowerCase();
      const count = asNum(item.count ?? item.pending, 1);
      if (k.includes("approval")) pendingApprovals += count;
      else if (k.includes("owner") || k.includes("decision") || k.includes("operator") || k.includes("human")) {
        ownerDecisions += count;
      } else if (k.includes("worktree") || k.includes("proposal")) worktreeProposals += count;
      else if (k.includes("budget") || k.includes("cost") || k.includes("incident")) budgetIncidents += count;
    }
  } else if (Array.isArray(snap?.active_gates)) {
    for (const item of snap.active_gates) {
      const k = asStr(item.key ?? item.kind ?? item.gate ?? item.name, "").toLowerCase();
      const count = asNum(item.count ?? item.pending, 1);
      const st = asStr(item.status ?? item.state, "").toLowerCase();
      if (st === "pass" || st === "passed" || st === "cleared") continue;
      if (k.includes("approval")) pendingApprovals += count;
      else if (k.includes("owner") || k.includes("decision") || k.includes("operator")) ownerDecisions += count;
      else if (k.includes("worktree") || k.includes("proposal")) worktreeProposals += count;
      else if (k.includes("budget") || k.includes("incident")) budgetIncidents += count;
    }
  }

  const computedTotal = pendingApprovals + ownerDecisions + worktreeProposals + budgetIncidents;
  const declaredTotal =
    gatesRaw && !Array.isArray(gatesRaw) && typeof gatesRaw === "object"
      ? asNum((gatesRaw as ControlPlaneGates).totalPending ?? (gatesRaw as ControlPlaneGates).total_pending, computedTotal)
      : asNum(summary?.pendingGates, computedTotal);

  return {
    pendingApprovals,
    ownerDecisions,
    worktreeProposals,
    budgetIncidents,
    totalPending: Math.max(computedTotal, declaredTotal),
    topTitles,
  };
}

interface NormalizedOutcomes {
  succeeded: number;
  failed: number;
  running: number;
  queued: number;
  total: number;
  successRate: number | null;
}

function normalizeOutcomes(
  raw: Record<string, unknown>,
  summary: ControlPlaneSnapshot["summary"] | null,
  workers: NormalizedWorker[],
): NormalizedOutcomes {
  const succeeded = asNum(raw.succeeded ?? raw.pass ?? summary?.succeededRuns24h, 0);
  const failed =
    asNum(raw.failed ?? raw.fail ?? summary?.failedRuns24h, 0) +
    asNum(raw.timedOut ?? raw.timed_out, 0);
  const running = asNum(
    raw.running ?? raw.active,
    workers.filter((w) => isWorkerActive(w.status)).length,
  );
  const queued = asNum(
    raw.queued ?? raw.waiting_human ?? raw.rework,
    workers.filter((w) => isWorkerQueued(w.status)).length,
  );
  const total = Math.max(asNum(raw.total, 0), succeeded + failed + running + queued);
  const completed = succeeded + failed;

  const summaryRate = summary?.passRatePct ?? summary?.successRate24h;
  const successRate =
    completed > 0
      ? typeof summaryRate === "number" && Number.isFinite(summaryRate)
        ? Math.max(0, Math.min(100, Math.round(summaryRate <= 1 && summaryRate > 0 ? summaryRate * 100 : summaryRate)))
        : Math.round((succeeded / completed) * 100)
      : typeof summaryRate === "number" && Number.isFinite(summaryRate) && total > 0
        ? Math.max(0, Math.min(100, Math.round(summaryRate)))
        : null;

  return { succeeded, failed, running, queued, total, successRate };
}

interface NormalizedAdapterRow {
  key: string;
  label: string;
  model: string;
  runs: number;
  succeeded: number;
  failed: number;
  running: number;
  sharePct: number;
}

function normalizeAdapters(
  adaptersRaw: ControlPlaneProviderBreakdown[],
  outcomesRaw: Record<string, unknown>,
  workers: NormalizedWorker[],
): NormalizedAdapterRow[] {
  if (adaptersRaw.length > 0) {
    const rawRows = adaptersRaw.map((item, idx) => {
      const label = asStr(item.adapterType ?? item.adapter_type ?? item.adapter ?? item.provider ?? item.name, `adapter-${idx + 1}`);
      const model = asStr(item.model, "");
      const runs = asNum(item.runs ?? item.count ?? item.total, 0);
      const succeeded = asNum(item.succeeded ?? item.pass, 0);
      const failed = asNum(item.failed ?? item.fail, 0);
      const running = asNum(item.running ?? item.active, 0);
      const explicitShare = item.sharePct ?? item.share_pct;
      return {
        key: `${label}:${model}:${idx}`,
        label,
        model,
        runs: Math.max(runs, succeeded + failed + running),
        succeeded,
        failed,
        running,
        explicitShare: typeof explicitShare === "number" && Number.isFinite(explicitShare) ? explicitShare : null,
      };
    });

    const sumRuns = rawRows.reduce((acc, row) => acc + row.runs, 0);
    return rawRows
      .map((row) => ({
        key: row.key,
        label: row.label,
        model: row.model,
        runs: row.runs,
        succeeded: row.succeeded,
        failed: row.failed,
        running: row.running,
        sharePct:
          row.explicitShare !== null
            ? Math.max(0, Math.min(100, Math.round(row.explicitShare)))
            : sumRuns > 0
              ? Math.round((row.runs / sumRuns) * 100)
              : 0,
      }))
      .sort((a, b) => b.runs - a.runs);
  }

  // Wave 1 outcomes.byAdapter / outcomes.byProvider map
  const byAdapter = outcomesRaw.byAdapter;
  if (byAdapter && typeof byAdapter === "object" && !Array.isArray(byAdapter)) {
    const entries = Object.entries(byAdapter as Record<string, unknown>)
      .map(([label, count]) => ({ label, runs: asNum(count, 0) }))
      .filter((e) => e.runs > 0);
    if (entries.length > 0) {
      const sumRuns = entries.reduce((acc, e) => acc + e.runs, 0);
      return entries
        .map((e, idx) => ({
          key: `adapter-${e.label}-${idx}`,
          label: e.label,
          model: "",
          runs: e.runs,
          succeeded: 0,
          failed: 0,
          running: 0,
          sharePct: sumRuns > 0 ? Math.round((e.runs / sumRuns) * 100) : 0,
        }))
        .sort((a, b) => b.runs - a.runs);
    }
  }

  // Derive per-adapter breakdown from workers when explicit provider list is empty
  const grouped = new Map<string, { label: string; model: string; runs: number; succeeded: number; failed: number; running: number }>();
  for (const w of workers) {
    const label = w.adapter || "paperwork_agent";
    const existing = grouped.get(label) ?? { label, model: w.model, runs: 0, succeeded: 0, failed: 0, running: 0 };
    existing.runs += 1;
    if (!existing.model && w.model) existing.model = w.model;
    if (isWorkerActive(w.status)) existing.running += 1;
    else if (isWorkerFailed(w.status)) existing.failed += 1;
    else if (w.status.toLowerCase() === "succeeded" || w.status.toLowerCase() === "completed") existing.succeeded += 1;
    grouped.set(label, existing);
  }

  const total = workers.length;
  return Array.from(grouped.values())
    .map((row, idx) => ({
      key: `${row.label}-${idx}`,
      label: row.label,
      model: row.model,
      runs: row.runs,
      succeeded: row.succeeded,
      failed: row.failed,
      running: row.running,
      sharePct: total > 0 ? Math.round((row.runs / total) * 100) : 0,
    }))
    .sort((a, b) => b.runs - a.runs);
}

function WorkerCard({ worker }: { worker: NormalizedWorker }) {
  const active = isWorkerActive(worker.status);
  const spec = [worker.adapter, worker.model].filter(Boolean);

  const cardBody = (
    <div
      data-testid={`control-plane-worker-${worker.key}`}
      className={cn(
        "group flex flex-col justify-between gap-2 rounded-lg border border-slate-200/80 bg-slate-50/75 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] transition-colors dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
        worker.agentId && "hover:border-blue-500/40 hover:bg-white dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#111827]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">
            {worker.role}
          </span>
          <span className="truncate text-xs font-semibold text-foreground" title={worker.name}>
            {worker.name}
          </span>
        </div>

        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] font-medium",
            statusPillClass(worker.status),
          )}
        >
          <span className="relative flex h-1.5 w-1.5">
            {active && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime-400 opacity-75 dark:bg-[#a3e635]" />
            )}
            <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", statusDotClass(worker.status))} />
          </span>
          {worker.status}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px] text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {spec.length > 0 ? (
            <span
              className="truncate rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[9.5px] text-foreground/85 dark:border-white/[0.08] dark:bg-[#0e131d]"
              title={spec.join(" · ")}
            >
              {spec.join(" · ")}
            </span>
          ) : (
            <span className="font-mono text-[9.5px] text-muted-foreground">native-runtime</span>
          )}
          {worker.issueIdentifier && (
            <span className="rounded border border-slate-200/80 bg-white/80 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-600 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#9aa7bd]">
              {worker.issueIdentifier}
            </span>
          )}
        </div>

        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground tabular-nums">
          <Clock className="h-2.5 w-2.5" />
          {formatDuration(worker.durationSec)}
        </span>
      </div>

      {worker.activity && (
        <p
          className="truncate rounded bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground dark:bg-[#0e131d]"
          title={worker.activity}
        >
          {worker.activity}
        </p>
      )}
    </div>
  );

  if (worker.agentId) {
    return (
      <Link
        to={`/agents/${worker.agentId}`}
        className="block no-underline text-inherit focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded-lg"
      >
        {cardBody}
      </Link>
    );
  }

  return cardBody;
}

export function DgateMonitorPanel({
  dgate,
  loading = false,
  className,
}: DgateMonitorPanelProps) {
  if (loading) {
    return (
      <div
        className={cn(
          "tactile-card rounded-[12px] border border-slate-200/90 bg-white p-4 tabular-nums dark:border-white/[0.08] dark:bg-[#0e131d] dark:[background-image:none]",
          className,
        )}
        aria-busy="true"
        aria-label="내부 통제 · 실행 관제 로딩 중"
      >
        <div className="mb-3 h-5 w-52 animate-pulse rounded bg-muted" />
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {[0, 1, 2, 3].map((idx) => (
            <div
              key={idx}
              className="h-16 animate-pulse rounded-lg border border-slate-200/80 bg-slate-100/80 dark:border-white/[0.07] dark:bg-[#07090d]"
            />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          <div className="h-44 animate-pulse rounded-lg border border-slate-200/80 bg-slate-100/80 dark:border-white/[0.07] dark:bg-[#07090d] lg:col-span-8" />
          <div className="h-44 animate-pulse rounded-lg border border-slate-200/80 bg-slate-100/80 dark:border-white/[0.07] dark:bg-[#07090d] lg:col-span-4" />
        </div>
      </div>
    );
  }

  const payload = resolvePayload(dgate);
  const { summary, snap, timestamp: timestampStr, scope: scopeLabel, dbLive } = payload;
  const isStale = Boolean(dgate?.stale);
  const workers = normalizeWorkers(payload.workersRaw, snap);
  const gates = normalizeGates(payload.gatesRaw, summary, snap);
  const outcomes = normalizeOutcomes(payload.outcomesRaw, summary, workers);
  const adapters = normalizeAdapters(payload.adaptersRaw, payload.outcomesRaw, workers);
  const recentEvents = payload.eventsRaw;

  const runningWorkersCount =
    summary?.activeRuns ??
    summary?.runningWorkers ??
    workers.filter((w) => isWorkerActive(w.status)).length ??
    snap?.open_forks ??
    0;
  const queuedWorkersCount =
    summary?.queuedRuns ??
    summary?.queuedWorkers ??
    workers.filter((w) => isWorkerQueued(w.status)).length;
  const pendingGatesCount = gates.totalPending;
  const activeAgentsCount =
    summary?.activeAgents ??
    (workers.length > 0
      ? new Set(workers.filter((w) => isWorkerActive(w.status)).map((w) => w.agentId ?? w.name)).size
      : snap?.mapped_count ?? 0);
  const totalAgentsCount = summary?.totalAgents;

  const gateRows = [
    {
      key: "approvals",
      label: "승인 대기",
      sublabel: gates.topTitles.approvals ?? "Pending Approvals",
      count: gates.pendingApprovals,
      to: "/approvals",
      icon: CheckCircle2,
    },
    {
      key: "owner-decisions",
      label: "오너 의사결정",
      sublabel: gates.topTitles.ownerDecisions ?? "Owner Decisions",
      count: gates.ownerDecisions,
      to: "/human-operator",
      icon: UserCheck,
    },
    {
      key: "worktree-proposals",
      label: "워크트리 제안",
      sublabel: gates.topTitles.worktreeProposals ?? "Worktree Proposals",
      count: gates.worktreeProposals,
      to: "/worktree/proposals",
      icon: GitBranch,
    },
    {
      key: "budget-incidents",
      label: "예산 인시던트",
      sublabel: gates.topTitles.budgetIncidents ?? "Budget Incidents",
      count: gates.budgetIncidents,
      to: "/costs",
      icon: AlertTriangle,
    },
  ];

  const totalOutcomeBar = Math.max(outcomes.total, 1);
  const succeededPct = Math.round((outcomes.succeeded / totalOutcomeBar) * 100);
  const runningPct = Math.round((outcomes.running / totalOutcomeBar) * 100);
  const queuedPct = Math.round((outcomes.queued / totalOutcomeBar) * 100);
  const failedPct = Math.max(
    0,
    outcomes.total > 0 ? 100 - succeededPct - runningPct - queuedPct : 0,
  );

  return (
    <div
      data-testid="dgate-live-panel"
      className={cn(
        "tactile-card flex flex-col gap-4 rounded-[12px] border border-slate-200/90 bg-white p-4 tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:[background-image:none] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
        className,
      )}
    >
      {/* Top Control Plane Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 dark:border-white/[0.07]">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold",
              isStale
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]"
                : "border-lime-500/40 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/40 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
            )}
          >
            <span className="relative flex h-1.5 w-1.5">
              {!isStale && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime-400 opacity-75 dark:bg-[#a3e635]" />
              )}
              <span
                className={cn(
                  "relative inline-flex h-1.5 w-1.5 rounded-full",
                  isStale ? "bg-amber-500 dark:bg-[#f59e0b]" : "bg-lime-500 dark:bg-[#a3e635]",
                )}
              />
            </span>
            {isStale ? "STALE" : "CONTROL PLANE LIVE"}
          </span>

          <span className="rounded border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-foreground dark:border-white/[0.07] dark:bg-[#07090d]">
            {scopeLabel}
          </span>

          <span className="font-mono text-[11px] text-muted-foreground">
            {formatShortTime(timestampStr)}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded border border-blue-500/35 bg-blue-500/10 px-2 py-0.5 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">
            <ShieldCheck className="h-3 w-3" />
            PAPERWORK INTERNAL
          </span>
          <span className="rounded border border-border/80 bg-muted/30 px-2 py-0.5 text-foreground dark:border-white/[0.07] dark:bg-[#07090d]">
            DB {dbLive ? "LIVE" : "SYNCING"}
          </span>
        </div>
      </div>

      {/* Top 4-cell KPI Strip */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-testid="control-plane-kpi-strip">
        {/* KPI 1: 실행 중 워커 */}
        <div className="rounded-lg border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">실행 중 워커</span>
            <Cpu className="h-3.5 w-3.5 text-lime-600 dark:text-[#a3e635]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold tracking-tight text-foreground tabular-nums">
              {runningWorkersCount}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {queuedWorkersCount > 0 ? `대기 ${queuedWorkersCount}` : `전체 ${workers.length}`}
            </span>
          </div>
        </div>

        {/* KPI 2: 대기 통제 게이트 */}
        <div className="rounded-lg border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">대기 통제 게이트</span>
            <ShieldAlert
              className={cn(
                "h-3.5 w-3.5",
                pendingGatesCount > 0
                  ? "text-amber-600 dark:text-[#f59e0b]"
                  : "text-lime-600 dark:text-[#a3e635]",
              )}
            />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={cn(
                "text-xl font-bold tracking-tight tabular-nums",
                pendingGatesCount > 0 ? "text-amber-600 dark:text-[#f59e0b]" : "text-foreground",
              )}
            >
              {pendingGatesCount}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {pendingGatesCount > 0 ? "검토 필요" : "모두 정상"}
            </span>
          </div>
        </div>

        {/* KPI 3: 24h 성공률 */}
        <div className="rounded-lg border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">24h 성공률</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold tracking-tight text-foreground tabular-nums">
              {outcomes.successRate !== null ? `${outcomes.successRate}%` : "—"}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {outcomes.succeeded}/{outcomes.succeeded + outcomes.failed} 완료
            </span>
          </div>
        </div>

        {/* KPI 4: 활성 에이전트 */}
        <div className="rounded-lg border border-slate-200/80 bg-slate-50/75 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">활성 에이전트</span>
            <Bot className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-bold tracking-tight text-foreground tabular-nums">
              {activeAgentsCount}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {typeof totalAgentsCount === "number" ? `/ ${totalAgentsCount} 등록` : "실행 중"}
            </span>
          </div>
        </div>
      </div>

      {/* Main Split Grid: Left/Main (Workers + 24h Outcomes/Routing) & Right/Control (Gates + Recent Events) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left / Main Column */}
        <div className="flex flex-col gap-4 lg:col-span-8">
          {/* Active & Recent Agent Workers Grid */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-lime-600 dark:text-[#a3e635]" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Agent Workers Grid
                </h4>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {runningWorkersCount} running · {workers.length} recent
              </span>
            </div>

            {workers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-6 text-center text-xs text-muted-foreground dark:border-white/[0.08] dark:bg-[#07090d]">
                현재 실행 중이거나 최근 실행된 에이전트 워커가 없습니다.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {workers.slice(0, 8).map((worker) => (
                  <WorkerCard key={worker.key} worker={worker} />
                ))}
              </div>
            )}
          </div>

          {/* 24h Outcome & Provider Routing Bar */}
          <div className="space-y-2.5 rounded-lg border border-slate-200/80 bg-slate-50/60 p-3 dark:border-white/[0.07] dark:bg-[#07090d]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  24h Outcome &amp; Provider Routing
                </h4>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                <span className="rounded border border-lime-500/35 bg-lime-500/10 px-1.5 py-0.5 text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:text-[#a3e635]">
                  성공 {outcomes.succeeded}
                </span>
                <span className="rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0.5 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">
                  실행 {outcomes.running}
                </span>
                <span className="rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
                  대기 {outcomes.queued}
                </span>
                <span className="rounded border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.5 text-rose-600 dark:text-rose-400">
                  실패 {outcomes.failed}
                </span>
              </div>
            </div>

            {/* Stacked Outcome Bar */}
            <div
              className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]"
              role="img"
              aria-label={`24시간 실행 결과: 성공 ${outcomes.succeeded}, 실행 ${outcomes.running}, 대기 ${outcomes.queued}, 실패 ${outcomes.failed}`}
            >
              {outcomes.total > 0 && (
                <>
                  {outcomes.succeeded > 0 && (
                    <div
                      className="h-full bg-lime-500 dark:bg-[#a3e635]"
                      style={{ width: `${succeededPct}%` }}
                    />
                  )}
                  {outcomes.running > 0 && (
                    <div
                      className="h-full bg-blue-500 dark:bg-[#60a5fa]"
                      style={{ width: `${runningPct}%` }}
                    />
                  )}
                  {outcomes.queued > 0 && (
                    <div
                      className="h-full bg-amber-500 dark:bg-[#f59e0b]"
                      style={{ width: `${queuedPct}%` }}
                    />
                  )}
                  {outcomes.failed > 0 && (
                    <div
                      className="h-full bg-rose-500 dark:bg-rose-400"
                      style={{ width: `${failedPct}%` }}
                    />
                  )}
                </>
              )}
            </div>

            {/* Per-Adapter / Provider Breakdown */}
            {adapters.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                {adapters.slice(0, 6).map((adapter) => (
                  <div
                    key={adapter.key}
                    className="rounded-md border border-slate-200/80 bg-white/80 px-2.5 py-2 dark:border-white/[0.06] dark:bg-[#0e131d]"
                  >
                    <div className="flex items-center justify-between gap-2 text-[10.5px]">
                      <span className="truncate font-mono font-semibold text-foreground" title={adapter.label}>
                        {adapter.label}
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                        {adapter.runs} runs · {adapter.sharePct}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]">
                      <div
                        className="h-full rounded-full bg-blue-500 dark:bg-[#60a5fa]"
                        style={{ width: `${Math.max(4, adapter.sharePct)}%` }}
                      />
                    </div>
                    {adapter.model && (
                      <p className="mt-1 truncate font-mono text-[9.5px] text-muted-foreground" title={adapter.model}>
                        {adapter.model}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">최근 24시간 어댑터 라우팅 집계 없음</p>
            )}
          </div>
        </div>

        {/* Right / Control Column */}
        <div className="flex flex-col gap-4 lg:col-span-4">
          {/* Internal Control Gates */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Internal Control Gates
                </h4>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {pendingGatesCount} pending
              </span>
            </div>

            <div className="space-y-1.5">
              {gateRows.map((gate) => {
                const Icon = gate.icon;
                const hasPending = gate.count > 0;
                return (
                  <Link
                    key={gate.key}
                    to={gate.to}
                    data-testid={`control-gate-${gate.key}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200/80 bg-slate-50/75 px-3 py-2 text-inherit no-underline shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] transition-colors hover:border-blue-500/40 hover:bg-white dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#111827]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          hasPending
                            ? "text-amber-600 dark:text-[#f59e0b]"
                            : "text-muted-foreground",
                        )}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">{gate.label}</p>
                        <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                          {gate.sublabel}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
                          hasPending
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]"
                            : "border-border bg-muted/40 text-muted-foreground dark:border-white/[0.08] dark:bg-[#0e131d]",
                        )}
                      >
                        {gate.count}
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/70" />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Recent Control Events Live Feed */}
          <div className="flex flex-1 flex-col space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent Control Events
                </h4>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {recentEvents.length}
              </span>
            </div>

            {recentEvents.length > 0 ? (
              <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200/80 bg-slate-50/75 p-2.5 font-mono text-[10.5px] dark:border-white/[0.07] dark:bg-[#07090d]">
                {recentEvents.slice(0, 15).map((ev, idx) => {
                  const ts = asStr(ev.timestamp ?? ev.ts ?? ev.createdAt ?? ev.at, "");
                  const kind = asStr(ev.kind ?? ev.type ?? ev.event ?? ev.action, "event");
                  const actor = asStr(ev.agentName ?? ev.actor, "");
                  const msg = asStr(ev.message ?? ev.summary ?? ev.detail, "");
                  return (
                    <div
                      key={asStr(ev.id, `${ts}-${idx}`)}
                      className="flex flex-col gap-0.5 border-b border-border/40 pb-1.5 last:border-b-0 last:pb-0 dark:border-white/[0.05]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1.5 py-0.2 text-[9px] font-semibold uppercase",
                            eventKindTone(kind),
                          )}
                        >
                          {kind}
                        </span>
                        {ts && (
                          <span className="shrink-0 text-[9.5px] text-muted-foreground tabular-nums">
                            {formatShortTime(ts)}
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[10.5px] text-foreground/85" title={msg || actor || "—"}>
                        {actor ? `${actor}: ` : ""}
                        {msg || "—"}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-3 py-4 text-center text-[11px] text-muted-foreground dark:border-white/[0.08] dark:bg-[#07090d]">
                최근 통제 이벤트가 없습니다.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
