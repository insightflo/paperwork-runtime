import { useEffect, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  missionsApi,
  type MissionAgentEntry,
  type MissionAgentRole,
  type MissionWorkflowConditionalDependency,
  type MissionWorkflowRun,
  type MissionWorkflowStep,
  type MissionWorkflowStepWorkProduct,
} from "../api/missions";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { openWorkProductInBrowser } from "../lib/workProductOpen";
import {
  buildLoopbackLanePath,
  buildTangentBezierPath,
  computePortOffsets,
  getConnectorVisualStyle,
  type ConnectorState,
  type ConnectorVisualStyle,
} from "../pages/workflows/graph-editor/connector-styles";
import { Button } from "@/components/ui/button";
import { GitBranch, User, Wrench } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowDagPanelProps {
  missionId: string;
  /** Default Execution Flow view: "graph" (default, read-only DAG) or "text" (classic run/step list). */
  defaultMode?: "graph" | "text";
}

const ROLE_ORDER: MissionAgentRole[] = [
  "owner",
  "executor",
  "reviewer",
  "specialist",
  "observer",
];

const ROLE_COLORS: Record<MissionAgentRole, string> = {
  owner: "border-blue-500/40 bg-blue-500/10 text-blue-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
  executor: "border-lime-600/35 bg-lime-500/10 text-lime-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
  reviewer: "border-violet-500/35 bg-violet-500/10 text-violet-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-violet-400/30 dark:bg-violet-400/10 dark:text-violet-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
  specialist: "border-cyan-500/35 bg-cyan-500/10 text-cyan-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
  observer: "border-slate-300/80 bg-slate-100/70 text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
};

// ---------------------------------------------------------------------------
// WorkflowDagPanel
// ---------------------------------------------------------------------------

export function WorkflowDagPanel({ missionId, defaultMode = "graph" }: WorkflowDagPanelProps) {
  const { selectedCompanyId } = useCompany();
  const [mode, setMode] = useState<"graph" | "text">(defaultMode);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: workflowRuns,
    isLoading: workflowRunsLoading,
    error: workflowRunsError,
  } = useQuery({
    queryKey: queryKeys.missions.workflowRuns(missionId),
    queryFn: () => missionsApi.listWorkflowRuns(missionId),
    enabled: !!missionId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (workflowRunsLoading) {
    return (
      <div className="space-y-2 py-2">
        {["mission-a", "mission-b", "mission-c"].map((key) => (
          <div key={key} className="h-12 animate-pulse rounded-[10px] border border-slate-200/70 bg-slate-100 dark:border-white/[0.06] dark:bg-[#0e131d]" />
        ))}
      </div>
    );
  }

  if (workflowRunsError) {
    return (
      <p className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white px-3 py-2 text-sm text-destructive dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-red-300">Failed to load workflow runs.</p>
    );
  }

  return (
    <div className="space-y-6 tabular-nums text-slate-900 dark:text-slate-100">
      <div className="tactile-card inline-flex items-center gap-0.5 rounded-[10px] border-[var(--pw-hairline)] bg-white p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]" role="group" aria-label="Execution flow view">
        <button
          type="button"
          onClick={() => setMode("graph")}
          aria-pressed={mode === "graph"}
          className={cn(
            "rounded-l-[8px] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors",
            mode === "graph" ? "bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24)] dark:bg-[#60a5fa]/15 dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-[#8f9db3] dark:hover:bg-white/[0.05] dark:hover:text-slate-100",
          )}
        >
          Graph
        </button>
        <button
          type="button"
          onClick={() => setMode("text")}
          aria-pressed={mode === "text"}
          className={cn(
            "rounded-r-[8px] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors",
            mode === "text" ? "bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24)] dark:bg-[#60a5fa]/15 dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-[#8f9db3] dark:hover:bg-white/[0.05] dark:hover:text-slate-100",
          )}
        >
          Text
        </button>
      </div>

      {mode === "graph" ? (
        <WorkflowRunGraph runs={workflowRuns ?? []} missionId={missionId} agentMap={agentMap} />
      ) : (
        <WorkflowRunList runs={workflowRuns ?? []} missionId={missionId} agentMap={agentMap} />
      )}

      {/* Agent roster grouped by role */}
      <AgentRoster missionId={missionId} agentMap={agentMap} />
    </div>
  );
}

const RUN_STATUS_TONE: Record<string, string> = {
  pending: "border-slate-300/80 bg-slate-100/70 text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-[#8f9db3]",
  running: "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]",
  completed: "border-lime-600/35 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]",
  failed: "border-red-500/40 bg-red-500/10 text-red-700 dark:border-red-400/35 dark:bg-red-500/10 dark:text-red-300",
  cancelled: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
};

const STEP_STATUS_TONE: Record<string, string> = {
  pending: "bg-slate-400 dark:bg-slate-500",
  running: "bg-blue-500 shadow-[0_0_8px_rgba(37,99,235,0.35)] dark:bg-[#60a5fa] dark:shadow-[0_0_10px_rgba(96,165,250,0.55)]",
  completed: "bg-emerald-500 dark:bg-[#a3e635] dark:shadow-[0_0_10px_rgba(163,230,53,0.45)]",
  failed: "bg-red-500 dark:bg-red-400 dark:shadow-[0_0_10px_rgba(248,113,113,0.42)]",
  skipped: "bg-amber-500 dark:bg-[#f59e0b] dark:shadow-[0_0_10px_rgba(245,158,11,0.42)]",
};

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function WorkflowRunList({
  runs,
  missionId,
  agentMap,
}: {
  runs: MissionWorkflowRun[];
  missionId: string;
  agentMap: Record<string, string>;
}) {
  if (runs.length === 0) {
    return (
      <div className="tactile-card rounded-[12px] border border-dashed border-slate-300/80 bg-white p-4 text-center text-slate-900 dark:border-white/[0.12] dark:bg-[#0e131d] dark:bg-none dark:text-slate-100">
        <GitBranch className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">No workflow runs for this mission yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Mission-linked workflow runs will appear here once execution starts.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((run) => {
        return (
          <div key={run.id} className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white p-4 space-y-2 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold tracking-[-0.01em] text-slate-950 dark:text-slate-50 truncate">
                  {run.workflowName ?? "Unnamed workflow"}
                </p>
                <p className="font-mono text-xs tabular-nums text-slate-500 dark:text-[#8f9db3] truncate">{run.id}</p>
              </div>
              <span
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]",
                  RUN_STATUS_TONE[run.status] ?? RUN_STATUS_TONE.pending,
                )}
              >
                {formatStatusLabel(run.status)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
              <span>Triggered by: {run.triggeredBy}</span>
              <span>Started: {run.startedAt ? formatDateTime(run.startedAt) : "—"}</span>
              <span>Ended: {run.completedAt ? formatDateTime(run.completedAt) : "—"}</span>
              <span>Steps: {run.progress.totalSteps}</span>
              <span>Completed: {run.progress.completedSteps}</span>
              {run.progress.runningSteps > 0 ? <span>Running: {run.progress.runningSteps}</span> : null}
              {run.progress.failedSteps > 0 ? <span>Failed: {run.progress.failedSteps}</span> : null}
              {run.progress.skippedSteps > 0 ? <span>Skipped: {run.progress.skippedSteps}</span> : null}
            </div>
            {run.steps.length > 0 ? (
              <div className="space-y-2 border-t border-slate-200/80 pt-3 dark:border-white/[0.07]">
                {run.steps.map((step) => (
                  <WorkflowStepRow
                    key={`${run.id}-${step.stepId}`}
                    missionId={missionId}
                    step={step}
                    steps={run.steps}
                    agentMap={agentMap}
                    stepRunId={step.stepRunId ?? null}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkProductCard({
  product,
}: {
  product: MissionWorkflowStepWorkProduct;
}) {
  const [openingProductId, setOpeningProductId] = useState<string | null>(null);
  const [openedProductId, setOpenedProductId] = useState<string | null>(null);
  const [openErrorProductId, setOpenErrorProductId] = useState<string | null>(null);

  async function openWorkProduct() {
    setOpeningProductId(product.id);
    setOpenedProductId(null);
    setOpenErrorProductId(null);
    try {
      await openWorkProductInBrowser(product.id);
      setOpenedProductId(product.id);
    } catch {
      setOpenErrorProductId(product.id);
    } finally {
      setOpeningProductId(null);
    }
  }

  return (
    <div className="rounded-[10px] border border-slate-200/80 bg-white px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/10 dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          {product.url ? (
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-xs font-medium underline-offset-2 hover:underline"
            >
              {product.title}
            </a>
          ) : (
            <p className="truncate text-xs font-medium">{product.title}</p>
          )}
          <div className="flex flex-wrap gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="rounded-md border border-slate-200/80 bg-slate-50/70 px-1.5 py-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]">{product.type}</span>
            <span className="rounded-md border border-slate-200/80 bg-slate-50/70 px-1.5 py-0.5 dark:border-white/[0.08] dark:bg-white/[0.04]">{formatStatusLabel(product.status)}</span>
            {product.isPrimary ? (
              <span className="rounded-md border border-lime-600/35 bg-lime-500/10 px-1.5 py-0.5 text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]">Primary</span>
            ) : null}
          </div>
          {product.summary ? <p className="text-[11px] text-muted-foreground">{product.summary}</p> : null}
          {openedProductId === product.id ? <p className="text-[11px] text-emerald-600 dark:text-[#a3e635]">Opened</p> : null}
          {openErrorProductId === product.id ? <p className="text-[11px] text-destructive">Open failed</p> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={() => void openWorkProduct()}
          disabled={openingProductId === product.id}
        >
          {openingProductId === product.id ? "Opening…" : "Open"}
        </Button>
      </div>
    </div>
  );
}

function WorkflowStepRow({
  missionId,
  step,
  steps,
  agentMap,
  stepRunId,
  onCapBoosted,
}: {
  missionId: string;
  step: MissionWorkflowStep;
  steps: MissionWorkflowStep[];
  agentMap: Record<string, string>;
  stepRunId: string | null;
  onCapBoosted?: () => void;
}) {
  const dependencyNames = step.dependencies.map(
    (dependencyId) => steps.find((candidate) => candidate.stepId === dependencyId)?.name ?? dependencyId,
  );
  const conditionalNames = forwardConditionalDependencies(step).map(
    (edge) => describeConditionalDependency(edge, steps),
  );
  const backEdgeNames = backEdgeDependencies(step).map((edge) => {
    const name = steps.find((candidate) => candidate.stepId === edge.stepId)?.name ?? edge.stepId;
    return `rework ×${edge.maxIterations ?? "?"}: ${name}`;
  });
  const hasForwardDependencies = dependencyNames.length > 0 || conditionalNames.length > 0;
  const assignee = getStepAssignee(step, agentMap);
  const workProducts = step.workProducts ?? [];
  const [boostAmount, setBoostAmount] = useState(1);
  const [boostReason, setBoostReason] = useState("");
  const [boostState, setBoostState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [boostError, setBoostError] = useState<string | null>(null);

  const hasReworkCap = typeof step.reworkCap === "number" && step.reworkCap > 0;
  const effectiveCap = hasReworkCap ? step.reworkCap! + (step.capBoost ?? 0) : null;
  const capExhausted = hasReworkCap && (step.iterationIndex ?? 0) >= (step.reworkCap ?? 0) + (step.capBoost ?? 0);

  async function handleBoost() {
    if (!stepRunId) return;
    setBoostState("busy");
    setBoostError(null);
    try {
      await missionsApi.grantQaReworkCapBoost(stepRunId, boostAmount, boostReason.trim() || undefined);
      setBoostState("done");
      onCapBoosted?.();
    } catch (error) {
      setBoostState("error");
      setBoostError(error instanceof Error ? error.message : "Failed to grant rework cap boost");
    }
  }

  return (
    <div className="rounded-[10px] border border-slate-200/80 bg-slate-50/50 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/[0.07] dark:bg-[#07090d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                STEP_STATUS_TONE[step.status] ?? STEP_STATUS_TONE.pending,
              )}
            />
            <span className="truncate text-sm font-medium">{step.name}</span>
            <span className="shrink-0 rounded-md border border-slate-200/80 bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3]">
              {formatStatusLabel(step.status)}
            </span>
            {hasReworkCap ? (
              <span
                className={cn(
                  "shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                  capExhausted ? "border-red-500/60 bg-red-500/10 text-red-600 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300" : "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
                )}
                title={capExhausted ? "QA rework cap exhausted — automatic rework stopped" : "QA rework budget"}
              >
                QA rework {step.iterationIndex ?? 0}/{effectiveCap}
                {(step.capBoost ?? 0) > 0 ? ` (+${step.capBoost} boost)` : ""}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5",
                assignee.kind === "tool"
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-300"
                  : assignee.kind === "agent"
                    ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]"
                    : "border-slate-200/80 bg-slate-50/70 text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3]",
              )}
              title={assignee.title}
            >
              {assignee.kind === "tool" ? (
                <Wrench className="h-3 w-3" />
              ) : (
                <User className="h-3 w-3" />
              )}
              <span>Assignee: {assignee.label}</span>
            </span>
            {hasForwardDependencies ? (
              <span>Depends on: {[...dependencyNames, ...conditionalNames].join(", ")}</span>
            ) : backEdgeNames.length > 0 ? (
              <span>Rework loop target</span>
            ) : (
              <span>Entry step</span>
            )}
            {backEdgeNames.length > 0 ? (
              <span className="text-amber-600 dark:text-[#f59e0b]">{backEdgeNames.join(", ")}</span>
            ) : null}
          </div>
          {hasReworkCap && capExhausted && stepRunId ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5">
              <span className="text-[11px] text-muted-foreground">QA rework cap reached. Grant a temporary boost:</span>
              <input
                type="number"
                min={1}
                max={50}
                step={1}
                value={boostAmount}
                onChange={(event) => setBoostAmount(Number(event.target.value) || 1)}
                aria-label="Boost amount"
                className="w-16 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-800 outline-none transition-colors focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
              />
              <input
                type="text"
                value={boostReason}
                onChange={(event) => setBoostReason(event.target.value)}
                placeholder="Reason (optional)"
                aria-label="Boost reason"
                className="min-w-32 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-800 outline-none transition-colors focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-100 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
              />
              <button
                type="button"
                disabled={boostState === "busy"}
                onClick={() => void handleBoost()}
                className="rounded-md border border-lime-600/35 bg-lime-500/10 px-2 py-0.5 text-xs font-semibold text-lime-700 transition-colors hover:bg-lime-500/15 disabled:opacity-60 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635] dark:hover:bg-[#a3e635]/15"
              >
                {boostState === "busy" ? "Granting" : "Grant"}
              </button>
            </div>
          ) : null}
          {boostState === "done" ? (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Cap boost granted. The next workflow sync will allow more rework.</p>
          ) : null}
          {boostState === "error" ? (
            <p className="text-[11px] text-destructive">{boostError}</p>
          ) : null}
          {step.toolNames.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {step.toolNames.map((toolName) => (
                <span
                  key={`${step.stepId}-${toolName}`}
                  className="rounded-md border border-slate-200/80 bg-slate-50/70 px-1.5 py-0.5 dark:border-white/[0.08] dark:bg-white/[0.04] text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  {toolName}
                </span>
              ))}
            </div>
          ) : null}
          {step.knowledgeBaseIds.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {step.knowledgeBaseIds.map((knowledgeBaseId) => (
                <span
                  key={`${step.stepId}-${knowledgeBaseId}`}
                  className="rounded-md border border-slate-200/80 bg-slate-50/70 px-1.5 py-0.5 dark:border-white/[0.08] dark:bg-white/[0.04] text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  kb:{knowledgeBaseId}
                </span>
              ))}
            </div>
          ) : null}
          {step.description ? <p className="text-xs text-muted-foreground">{step.description}</p> : null}
        </div>
        {workProducts.length > 0 ? (
          <div className="w-[20rem] shrink-0 space-y-1.5 rounded-[10px] border border-slate-200/80 bg-slate-50/60 p-2 dark:border-white/[0.07] dark:bg-[#0e131d]">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Work products · {workProducts.length}
            </p>
            <div className="space-y-1.5">
              {workProducts.map((product) => (
                <WorkProductCard key={product.id} product={product} />
              ))}
            </div>
          </div>
        ) : null}
        <div className="w-[16rem] shrink-0 space-y-1 text-right">
          {step.issue ? (
            <Link
              to={`/issues/${step.issue.identifier ?? step.issue.id}`}
              state={createIssueDetailLocationState("Mission", `/missions/${missionId}`)}
              className="block rounded-[10px] border border-slate-200/80 bg-white px-2 py-1 text-xs no-underline shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] transition-colors hover:border-blue-500/35 hover:bg-blue-50/60 dark:border-white/[0.08] dark:bg-[#07090d] dark:text-slate-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#101827]"
            >
              <span className="block truncate font-mono text-muted-foreground">
                {step.issue.identifier ?? step.issue.id}
              </span>
              <span className="block truncate">{step.issue.title}</span>
              <span className="block truncate text-muted-foreground">
                Issue: {formatStatusLabel(step.issue.status)}
              </span>
            </Link>
          ) : (
            <div className="rounded-[10px] border border-dashed border-slate-300/80 bg-slate-50/50 px-2 py-1 text-xs text-slate-500 dark:border-white/[0.12] dark:bg-white/[0.03] dark:text-[#8f9db3]">
              Issue pending
            </div>
          )}
          <div className="space-y-0.5 text-[11px] leading-tight text-muted-foreground">
            <div>Started: {step.startedAt ? formatDateTime(step.startedAt) : "—"}</div>
            <div>Ended: {step.completedAt ? formatDateTime(step.completedAt) : "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function getStepAssignee(
  step: MissionWorkflowStep,
  agentMap: Record<string, string>,
): { kind: "agent" | "tool" | "unassigned"; label: string; title: string } {
  if (step.type === "tool") {
    return {
      kind: "tool",
      label: "tool",
      title: step.toolNames.length > 0 ? `Tool step: ${step.toolNames.join(", ")}` : "Tool step",
    };
  }

  const agentId = step.agentId.trim();
  const issueAssigneeAgentId = step.issue?.assigneeAgentId?.trim() ?? "";
  const resolvedAgentId = agentId || issueAssigneeAgentId;
  if (resolvedAgentId) {
    return {
      kind: "agent",
      label: agentMap[resolvedAgentId] ?? resolvedAgentId,
      title: resolvedAgentId,
    };
  }

  return {
    kind: "unassigned",
    label: "Unassigned",
    title: "No agent or tool is assigned to this step yet.",
  };
}

// ---------------------------------------------------------------------------
// WorkflowRunGraph — read-only DAG visualization (default Execution Flow view)
// [목적] mission workflow run 의 step 들을 dependency level(L→R) 배치 + SVG edge 로 시각화.
//   read-only. node 선택 시 기존 WorkflowStepRow 를 detail rail 로 재사용(text mode 장점 섞기).
// [수정시 주의] 좌표는 frame width 에 맞춰 재계산. cycle/미해결 dependency 방어.
// ---------------------------------------------------------------------------

const GRAPH_CONTAINER_X_PADDING = 24;
const GRAPH_ROW_HEIGHT = 96;
const GRAPH_NODE_MIN_WIDTH = 180;
const GRAPH_NODE_MAX_WIDTH = 240;
const GRAPH_COLUMN_MIN_GAP = 32;
// back-edge(rework loop) arc 가 지나갈 상단 여백.
const GRAPH_BACK_EDGE_HEADROOM = 56;
const GRAPH_BACK_EDGE_LANE_STRIDE = 36;
const GRAPH_PORT_SPAN = 36;

// [목적] step.dependencies 기반 topological level 계산(0 = entry). cycle/미존재 dep 방어.
// [출력] stepId -> level. dep 없으면 0, 있으면 max(dep level)+1.
// [주의] IF 조건분기(conditionalDependencies 의 forward edge)도 level 계산에 포함한다.
//   조건 전용으로 진입하는 step 이 level 0 으로 평탄화되어 Entry 로 오표시되는 버그 방지.
//   back-edge(rework loop)는 순환 구조라 level 계산에서 제외 — 그래프 배치는 forward-only.
function computeStepLevels(steps: MissionWorkflowStep[]): Map<string, number> {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const inboundForwardDepIds = (step: MissionWorkflowStep): string[] =>
    Array.from(
      new Set([
        ...step.dependencies,
        ...forwardConditionalDependencies(step).map((edge) => edge.stepId),
      ]),
    );
  const resolve = (id: string): number => {
    if (levels.has(id)) return levels.get(id)!;
    const step = byId.get(id);
    if (!step) {
      levels.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      // cycle 방어 — 순환 dep 면 0으로 평탄화
      levels.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const knownDeps = inboundForwardDepIds(step).filter((depId) => byId.has(depId));
    const level = knownDeps.length === 0 ? 0 : Math.max(...knownDeps.map((depId) => resolve(depId))) + 1;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  steps.forEach((step) => resolve(step.stepId));
  return levels;
}

// [목적] 조건부 의존성 중 forward edge(IF 분기)만 추출. back-edge(loop) 제외.
function forwardConditionalDependencies(step: MissionWorkflowStep): MissionWorkflowConditionalDependency[] {
  return (step.conditionalDependencies ?? []).filter((edge) => edge.isBackEdge !== true);
}

// [목적] 조건부 의존성 중 back-edge(QA rework loop)만 추출.
function backEdgeDependencies(step: MissionWorkflowStep): MissionWorkflowConditionalDependency[] {
  return (step.conditionalDependencies ?? []).filter((edge) => edge.isBackEdge === true);
}

// [목적] 조건부 forward edge 를 공유 connector vocabulary 상태로 변환.
//   when:"success"/undefined/unknown 은 legacy dependencies 와 동일 의미이므로 null(소스 step 상태 상속).
type DagForwardEdge = { sourceStepId: string; targetStepId: string; state: ConnectorState; label: string | null };

const CONDITIONAL_CONNECTOR_STATE: Record<string, ConnectorState> = {
  condition_true: "condition_true", condition_false: "condition_false",
  failure: "blocked", qa_request_changes: "rework",
};
const CONDITIONAL_EDGE_LABEL: Record<string, string> = {
  condition_true: "true", condition_false: "false", always: "always",
  failure: "failure", qa_request_changes: "request changes",
};

function stepConnectorState(step: MissionWorkflowStep): ConnectorState {
  if (step.status === "running") return "running";
  if (step.status === "completed") return "completed";
  if (step.status === "failed") return "blocked";
  return "default";
}

function ConnectorLabel({ x, y, label, stroke }: { x: number; y: number; label: string; stroke: string }) {
  const width = Math.max(20, label.length * 6 + 8);
  return (
    <>
      <rect data-edge-label-backdrop="true" x={x - width / 2} y={y - 10} width={width} height={13} rx={3}
        fill="var(--background, #ffffff)" opacity={0.92} />
      <text x={x} y={y} fill={stroke} fontSize="10" fontWeight="700" textAnchor="middle">{label}</text>
    </>
  );
}

function ConnectorPath({ path, visual }: { path: string; visual: ConnectorVisualStyle }) {
  return (
    <path d={path} fill="none" stroke={visual.stroke} strokeWidth={visual.strokeWidth}
      strokeDasharray={visual.strokeDasharray} strokeLinecap="round" opacity={visual.opacity}
      className={visual.animationClassName} markerEnd="url(#wf-dag-arrow-context)" />
  );
}

// [목적] text 모드/step 상세에서 조건부 의존성을 사람이 읽는 문구로 변환.
function describeConditionalDependency(
  edge: MissionWorkflowConditionalDependency,
  steps: MissionWorkflowStep[],
): string {
  const name = steps.find((candidate) => candidate.stepId === edge.stepId)?.name ?? edge.stepId;
  switch (edge.when) {
    case "condition_true":
      return `IF true: ${name}`;
    case "condition_false":
      return `IF false: ${name}`;
    case "failure":
      return `on failure: ${name}`;
    case "always":
      return `always after: ${name}`;
    case "qa_request_changes":
      return `rework from: ${name}`;
    default:
      return `after success: ${name}`;
  }
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = Math.floor(element.clientWidth);
      setWidth((previousWidth) => (previousWidth === nextWidth ? previousWidth : nextWidth));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

function WorkflowRunGraph({
  runs,
  missionId,
  agentMap,
}: {
  runs: MissionWorkflowRun[];
  missionId: string;
  agentMap: Record<string, string>;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [graphFrameRef, graphFrameWidth] = useElementWidth<HTMLDivElement>();

  if (runs.length === 0) {
    return (
      <div className="tactile-card rounded-[12px] border border-dashed border-slate-300/80 bg-white p-4 text-center text-slate-900 dark:border-white/[0.12] dark:bg-[#0e131d] dark:bg-none dark:text-slate-100">
        <GitBranch className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">No workflow runs for this mission yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Mission-linked workflow runs will appear here once execution starts.
        </p>
      </div>
    );
  }

  // 기본 run: running 중인 것 우선, 없으면 첫 run. 사용자가 run selector 로 변경 가능.
  const runningRun = runs.find((run) => run.status === "running");
  const run = runs.find((candidate) => candidate.id === selectedRunId) ?? runningRun ?? runs[0];

  const branchPointStepIds = new Set(
    run.steps.flatMap((step) =>
      forwardConditionalDependencies(step)
        .filter((edge) => edge.when === "condition_true" || edge.when === "condition_false")
        .map((edge) => edge.stepId),
    ),
  );

  const levels = computeStepLevels(run.steps);
  const maxLevel = run.steps.length === 0 ? 0 : Math.max(0, ...run.steps.map((step) => levels.get(step.stepId) ?? 0));
  const columns: MissionWorkflowStep[][] = Array.from({ length: maxLevel + 1 }, () => []);
  run.steps.forEach((step) => {
    columns[levels.get(step.stepId) ?? 0]?.push(step);
  });
  const positionByKey = new Map<string, { col: number; row: number }>();
  columns.forEach((columnSteps, col) => {
    columnSteps.forEach((step, row) => {
      positionByKey.set(`${run.id}:${step.stepId}`, { col, row });
    });
  });
  const numRows = Math.max(1, ...columns.map((columnSteps) => columnSteps.length));
  const columnCount = maxLevel + 1;
  const minGraphWidth =
    columnCount * GRAPH_NODE_MIN_WIDTH + Math.max(0, columnCount - 1) * GRAPH_COLUMN_MIN_GAP;
  const availableGraphWidth = graphFrameWidth > 0
    ? Math.max(0, graphFrameWidth - GRAPH_CONTAINER_X_PADDING)
    : 0;
  const graphWidth = Math.max(availableGraphWidth, minGraphWidth);
  const nodeWidth = Math.min(
    GRAPH_NODE_MAX_WIDTH,
    Math.max(
      GRAPH_NODE_MIN_WIDTH,
      (graphWidth - Math.max(0, columnCount - 1) * GRAPH_COLUMN_MIN_GAP) / columnCount,
    ),
  );
  const columnGap = columnCount <= 1
    ? 0
    : Math.max(GRAPH_COLUMN_MIN_GAP, (graphWidth - nodeWidth * columnCount) / (columnCount - 1));
  const columnStride = nodeWidth + columnGap;
  // back-edge(rework loop) arc 를 담기 위한 상단 여백. lane 수만큼 노드 전체를 아래로 민다.
  const stepBackEdges = run.steps.flatMap((step) =>
    backEdgeDependencies(step).map((edge) => ({ edge, targetStepId: step.stepId })),
  );
  const validBackEdges = stepBackEdges.filter(({ edge, targetStepId }) =>
    positionByKey.has(`${run.id}:${edge.stepId}`) && positionByKey.has(`${run.id}:${targetStepId}`));
  const backEdgeHeadroom = validBackEdges.length > 0
    ? GRAPH_BACK_EDGE_HEADROOM + (validBackEdges.length - 1) * GRAPH_BACK_EDGE_LANE_STRIDE : 0;
  const graphHeight = backEdgeHeadroom + numRows * GRAPH_ROW_HEIGHT;
  const stepById = new Map(run.steps.map((step) => [step.stepId, step]));
  const plainEdgeKeys = new Set<string>();
  const forwardEdgeInputs: DagForwardEdge[] = [];

  run.steps.forEach((step) => {
    const pushForwardEdge = (dependencyId: string, state: ConnectorState | null, label: string | null) => {
      const sourceStep = stepById.get(dependencyId);
      if (!sourceStep || !positionByKey.has(`${run.id}:${dependencyId}`)) return;
      forwardEdgeInputs.push({
        sourceStepId: dependencyId,
        targetStepId: step.stepId,
        state: state ?? stepConnectorState(sourceStep),
        label,
      });
    };
    step.dependencies.forEach((dependencyId) => {
      plainEdgeKeys.add(`${dependencyId}->${step.stepId}`);
      pushForwardEdge(dependencyId, null, null);
    });
    forwardConditionalDependencies(step).forEach((edge) => {
      const state = edge.when ? CONDITIONAL_CONNECTOR_STATE[edge.when] ?? null : null;
      if (!state) {
        // when:"success"/undefined 는 legacy dependencies 와 동일 의미 — 같은 src->tgt 평범 edge 가 이미 있으면 생략(중복 방지)
        if (plainEdgeKeys.has(`${edge.stepId}->${step.stepId}`)) return;
        plainEdgeKeys.add(`${edge.stepId}->${step.stepId}`);
      }
      pushForwardEdge(edge.stepId, state, edge.when ? CONDITIONAL_EDGE_LABEL[edge.when] ?? null : null);
    });
  });

  const portIndexes = (keyForEdge: (edge: DagForwardEdge) => string) => {
    const groups = new Map<string, number[]>();
    forwardEdgeInputs.forEach((edge, index) => {
      const key = keyForEdge(edge);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    return new Map<number, number>([...groups.values()].flatMap((indexes) =>
      computePortOffsets(indexes.length, GRAPH_PORT_SPAN).map((offset, portIndex) =>
        [indexes[portIndex], offset] as const)));
  };
  const outgoingOffsets = portIndexes((edge) => edge.sourceStepId);
  const incomingOffsets = portIndexes((edge) => edge.targetStepId);

  const edges = forwardEdgeInputs.flatMap((edge, index) => {
    const source = positionByKey.get(`${run.id}:${edge.sourceStepId}`);
    const target = positionByKey.get(`${run.id}:${edge.targetStepId}`);
    if (!source || !target) return [];
    const x1 = source.col * columnStride + nodeWidth;
    const x2 = target.col * columnStride;
    const y1 = backEdgeHeadroom + source.row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2 + (outgoingOffsets.get(index) ?? 0);
    const y2 = backEdgeHeadroom + target.row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2 + (incomingOffsets.get(index) ?? 0);
    return [{
      key: `${run.id}:forward:${edge.sourceStepId}->${edge.targetStepId}:${index}`,
      path: buildTangentBezierPath(x1, y1, x2, y2),
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 8,
      label: edge.label,
      state: edge.state,
      sourceStepId: edge.sourceStepId,
      targetStepId: edge.targetStepId,
      visual: getConnectorVisualStyle(edge.state),
    }];
  });

  // back-edge 는 상단 여백을 지나는 staggered overhead lane 으로 그린다(레이아웃은 forward-only 유지).
  const backEdgeArcs = validBackEdges.map(({ edge, targetStepId }, laneIndex) => {
    const sourcePos = positionByKey.get(`${run.id}:${edge.stepId}`)!;
    const targetPos = positionByKey.get(`${run.id}:${targetStepId}`)!;
    const sx = sourcePos.col * columnStride + nodeWidth / 2;
    const sy = backEdgeHeadroom + sourcePos.row * GRAPH_ROW_HEIGHT;
    const tx = targetPos.col * columnStride + nodeWidth / 2;
    const ty = backEdgeHeadroom + targetPos.row * GRAPH_ROW_HEIGHT;
    return {
      key: `${run.id}:back:${edge.stepId}->${targetStepId}`,
      ...buildLoopbackLanePath(sx, sy, tx, ty, laneIndex),
      label: `rework ×${edge.maxIterations ?? "?"}`,
      visual: getConnectorVisualStyle("rework"),
    };
  });

  const selectedStep = selectedStepId ? run.steps.find((step) => step.stepId === selectedStepId) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white p-4 space-y-2 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-[-0.01em] text-slate-950 dark:text-slate-50 truncate">{run.workflowName ?? "Unnamed workflow"}</p>
            <p className="font-mono text-xs tabular-nums text-slate-500 dark:text-[#8f9db3] truncate">{run.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]",
                RUN_STATUS_TONE[run.status] ?? RUN_STATUS_TONE.pending,
              )}
            >
              {formatStatusLabel(run.status)}
            </span>
            <a
              href={missionsApi.workflowRunFlowmapDownloadPath(missionId, run.id)}
              download
              className="rounded-md border border-slate-200/90 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:border-blue-500/35 hover:bg-blue-50 dark:border-[#60a5fa]/25 dark:bg-[#07090d] dark:text-[#60a5fa] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-[#101827]"
              title="Download this run as a single-file interactive flowmap HTML (IF branches + rework loops included)"
            >
              Export flowmap
            </a>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
          <span>Triggered by: {run.triggeredBy}</span>
          <span>Started: {run.startedAt ? formatDateTime(run.startedAt) : "—"}</span>
          <span>Ended: {run.completedAt ? formatDateTime(run.completedAt) : "—"}</span>
          <span>Steps: {run.progress.totalSteps}</span>
          <span>Completed: {run.progress.completedSteps}</span>
          {run.progress.runningSteps > 0 ? <span>Running: {run.progress.runningSteps}</span> : null}
          {run.progress.failedSteps > 0 ? <span>Failed: {run.progress.failedSteps}</span> : null}
          {run.progress.skippedSteps > 0 ? <span>Skipped: {run.progress.skippedSteps}</span> : null}
        </div>
        {runs.length > 1 ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {runs.map((candidateRun) => (
              <button
                key={candidateRun.id}
                type="button"
                onClick={() => {
                  setSelectedRunId(candidateRun.id);
                  setSelectedStepId(null);
                }}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide transition-colors",
                  candidateRun.id === run.id
                    ? "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]"
                    : "border-slate-200/80 text-slate-500 hover:bg-slate-100 dark:border-white/[0.08] dark:text-[#8f9db3] dark:hover:bg-white/[0.05]",
                )}
              >
                {candidateRun.workflowName ?? candidateRun.id.slice(0, 8)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {run.steps.length === 0 ? (
        <div className="tactile-card rounded-[12px] border border-dashed border-slate-300/80 bg-white p-4 text-center text-slate-900 dark:border-white/[0.12] dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 text-sm text-muted-foreground">
          No steps in this run.
        </div>
      ) : (
        <div ref={graphFrameRef} className="tactile-card overflow-x-auto overscroll-contain rounded-[12px] border-[var(--pw-hairline)] bg-slate-100/70 p-3 dark:border-white/10 dark:bg-[#07090d] dark:bg-none dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),inset_0_12px_32px_rgba(0,0,0,0.22)]">
          <div
            className="relative"
            style={{
              width: graphFrameWidth > 0 ? graphWidth : "100%",
              minWidth: minGraphWidth,
              height: graphHeight,
            }}
          >
            <svg
              className="absolute inset-0 pointer-events-none text-border"
              width="100%"
              height={graphHeight}
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
              aria-hidden="true"
            >
              <defs>
                <marker id="wf-dag-arrow-context" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
                </marker>
              </defs>
              {edges.map((edge) => (
                <g key={edge.key} data-connector-state={edge.state}
                  data-source-step-id={edge.sourceStepId} data-target-step-id={edge.targetStepId}>
                  <ConnectorPath path={edge.path} visual={edge.visual} />
                  {edge.label ? (
                    <ConnectorLabel x={edge.labelX} y={edge.labelY} label={edge.label} stroke={edge.visual.stroke} />
                  ) : null}
                </g>
              ))}
              {backEdgeArcs.map((arc) => (
                <g key={arc.key} data-connector-state="rework">
                  <ConnectorPath path={arc.path} visual={arc.visual} />
                  <ConnectorLabel x={arc.labelX} y={arc.labelY} label={arc.label} stroke={arc.visual.stroke} />
                </g>
              ))}
            </svg>
            {run.steps.map((step) => {
              const position = positionByKey.get(`${run.id}:${step.stepId}`);
              if (!position) return null;
              const assignee = getStepAssignee(step, agentMap);
              const isEntry = step.dependencies.length === 0 && forwardConditionalDependencies(step).length === 0;
              const isBranchPoint = branchPointStepIds.has(step.stepId);
              const isSelected = selectedStepId === step.stepId;
              const tone = STEP_STATUS_TONE[step.status] ?? STEP_STATUS_TONE.pending;
              const emphasis =
                step.status === "failed"
                  ? "border-red-500/70 dark:border-red-400/60"
                  : step.status === "running"
                    ? "border-blue-500/70 dark:border-[#60a5fa]/60"
                    : "border-slate-200/90 dark:border-white/[0.09]";
              return (
                <button
                  key={`${run.id}-${step.stepId}`}
                  type="button"
                  onClick={() => setSelectedStepId(isSelected ? null : step.stepId)}
                  aria-pressed={isSelected}
                  title={step.name}
                  className={cn(
                    "absolute rounded-[10px] border bg-white px-2.5 py-2 text-left text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_4px_14px_rgba(15,23,42,0.08)] transition-[color,background-color,border-color,box-shadow,transform] hover:border-blue-500/35 hover:bg-blue-50/60 motion-safe:enabled:active:scale-[0.96] dark:bg-[#0e131d] dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_8px_22px_rgba(0,0,0,0.34)] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#111827]",
                    emphasis,
                    isSelected ? "ring-2 ring-blue-500/35 dark:ring-[#a3e635]/45" : "",
                  )}
                  style={{
                    left: position.col * columnStride,
                    top: backEdgeHeadroom + position.row * GRAPH_ROW_HEIGHT,
                    width: nodeWidth,
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", tone)} />
                    <span className="truncate text-xs font-medium">{step.name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="uppercase tracking-wide">{formatStatusLabel(step.status)}</span>
                    {isEntry ? <span className="rounded border border-lime-600/35 bg-lime-500/10 px-1 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]">Entry</span> : null}
                    {isBranchPoint ? (
                      <span className="rounded border border-blue-500/40 bg-blue-500/10 px-1 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">IF</span>
                    ) : null}
                    <span className="truncate">{assignee.label}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    {step.issue ? <span className="font-mono">{step.issue.identifier ?? step.issue.id}</span> : null}
                    {step.workProducts.length > 0 ? (
                      <span className="rounded border border-slate-200/80 bg-slate-50/70 px-1 dark:border-white/[0.08] dark:bg-white/[0.04]">wp·{step.workProducts.length}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedStep ? (
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8f9db3]">Selected step</p>
          <WorkflowStepRow
            missionId={missionId}
            step={selectedStep}
            steps={run.steps}
            agentMap={agentMap}
            stepRunId={selectedStep.stepRunId ?? null}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Select a step node to see full detail (issue, assignee, tools, knowledge bases, work products).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRoster — fetches /missions/:id agents directly via the missions detail
// ---------------------------------------------------------------------------

interface AgentRosterProps {
  missionId: string;
  agentMap: Record<string, string>;
}

interface MissionAgentRosterResult {
  entries: MissionAgentEntry[];
  endpointAvailable: boolean;
}

function AgentRoster({ missionId, agentMap }: AgentRosterProps) {
  const { data: rosterData, isLoading } = useQuery<MissionAgentRosterResult>({
    queryKey: [...queryKeys.missions.detail(missionId), "agents"],
    queryFn: async () => {
      try {
        return {
          entries: await missionsApi.listAgents(missionId),
          endpointAvailable: true,
        };
      } catch (error) {
        const status =
          error instanceof Error && "status" in error
            ? Number((error as Error & { status?: number }).status)
            : null;
        if (status === 404) {
          return {
            entries: [],
            endpointAvailable: false,
          };
        }
        throw new Error("Failed to load mission roster");
      }
    },
    enabled: !!missionId,
  });

  if (isLoading) {
    return (
      <div className="space-y-1">
        {["roster-a", "roster-b"].map((key) => (
          <div key={key} className="h-10 animate-pulse rounded-[10px] border border-slate-200/70 bg-slate-100 dark:border-white/[0.06] dark:bg-[#0e131d]" />
        ))}
      </div>
    );
  }

  const entries: MissionAgentEntry[] = rosterData?.entries ?? [];

  if (rosterData?.endpointAvailable === false) {
    return (
      <div className="tactile-card flex flex-col items-center rounded-[12px] border-[var(--pw-hairline)] bg-white py-6 text-center text-slate-900 dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100">
        <User className="h-6 w-6 mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Mission roster is not available yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          This workspace can still show mission details while the roster endpoint is being rolled out.
        </p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="tactile-card flex flex-col items-center rounded-[12px] border-[var(--pw-hairline)] bg-white py-6 text-center text-slate-900 dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100">
        <User className="h-6 w-6 mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No agents assigned to this mission.</p>
      </div>
    );
  }

  // Sort by canonical role order
  const sorted = [...entries].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );

  // Group by role
  const grouped = ROLE_ORDER.reduce<Record<string, MissionAgentEntry[]>>((acc, role) => {
    const members = sorted.filter((e) => e.role === role);
    if (members.length > 0) acc[role] = members;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([role, members]) => (
        <div key={role} className="space-y-1.5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-[#8f9db3]">
            {role}
          </p>
          <div className="flex flex-wrap gap-2">
            {members.map((entry) => (
              <div
                key={entry.agentId}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[11px] font-semibold tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
                  ROLE_COLORS[entry.role as MissionAgentRole] ?? "border-border bg-muted text-muted-foreground",
                )}
              >
                <User className="h-3 w-3" />
                {agentMap[entry.agentId] ?? entry.agentId}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
