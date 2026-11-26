import { useMemo, useState, type JSX } from "react";
import { buildIssueHref } from "./routes.js";
import { currentBrowserPathname } from "./shared-controls.js";
import { WorkflowRunGraphPreview } from "./graph-editor/GraphRunPreview.js";
import { usePluginAction, useWorkflowRunDetail } from "./workflow-page-api.js";
import { applyStepRunsToGraphSteps } from "./workflow-graph.js";
import { WorkflowReplacementProposal } from "./workflow-replacement-proposal.js";
import { cn } from "../../lib/utils";

const PANEL_MESSAGE =
  "tactile-card rounded-xl border-slate-200/90 bg-white px-3 py-2 text-xs text-slate-600 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#8b97ad]";
const TABLE_HEAD =
  "h-8 px-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-[#8b97ad]";
const TABLE_CELL = "px-3 py-2.5 align-middle";
const ACTION_BUTTON =
  "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-blue-500/25 bg-blue-500/10 px-2.5 text-xs font-semibold text-blue-700 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/35 hover:border-blue-500/45 hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:border-slate-200/90 disabled:bg-slate-100 disabled:text-slate-400 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10 dark:text-[#93c5fd] dark:focus-visible:ring-[#60a5fa]/35 dark:hover:border-[#60a5fa]/45 dark:hover:bg-[#60a5fa]/15 dark:disabled:border-white/[0.07] dark:disabled:bg-white/[0.04] dark:disabled:text-[#627089]";

function statusToneClass(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (["completed", "complete", "succeeded", "success", "done"].includes(normalized)) {
    return "border-lime-600/25 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/25 dark:bg-[#a3e635]/10 dark:text-[#bef264]";
  }
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(normalized)) {
    return "border-rose-600/25 bg-rose-500/10 text-rose-700 dark:border-[#f43f5e]/25 dark:bg-[#f43f5e]/10 dark:text-[#fda4af]";
  }
  if (["running", "in_progress", "active", "queued"].includes(normalized)) {
    return "border-blue-600/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10 dark:text-[#93c5fd]";
  }
  if (["pending", "paused", "blocked", "waiting"].includes(normalized)) {
    return "border-amber-600/25 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/25 dark:bg-[#f59e0b]/10 dark:text-[#fcd34d]";
  }
  return "border-slate-300/80 bg-slate-500/10 text-slate-600 dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-[#8b97ad]";
}

export function WorkflowRunDetailPanel({
  companyId,
  runId,
  onRefreshOverview,
}: {
  companyId: string;
  runId: string;
  onRefreshOverview: () => Promise<void>;
}): JSX.Element {
  const detail = useWorkflowRunDetail(runId);
  const rerunStep = usePluginAction("rerun-step");
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>("");
  const runGraphSteps = useMemo(() => {
    const workflowSteps = detail.data?.workflow?.steps ?? [];
    const stepRuns = detail.data?.stepRuns ?? [];
    return applyStepRunsToGraphSteps(workflowSteps, stepRuns);
  }, [detail.data]);

  async function handleRerunStep(input: { stepRunId: string; issueId?: string | null }): Promise<void> {
    setPendingStepId(input.stepRunId);
    setActionError("");
    try {
      await rerunStep({
        companyId,
        stepRunId: input.stepRunId,
        issueId: input.issueId || undefined,
      });
      await Promise.all([detail.refresh(), onRefreshOverview()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`Step rerun 실패: ${message}`);
    } finally {
      setPendingStepId(null);
    }
  }

  if (detail.loading) {
    return <p className={PANEL_MESSAGE}>Loading step details...</p>;
  }

  if (detail.error) {
    return <p className={cn(PANEL_MESSAGE, "border-rose-300/70 text-rose-700 dark:border-[#f43f5e]/25 dark:text-[#fda4af]")}>Failed to load step details: {detail.error.message}</p>;
  }

  if (!detail.data) {
    return <p className={PANEL_MESSAGE}>No step details available.</p>;
  }

  return (
    <div className="grid gap-2 tabular-nums">
      {actionError ? (
        <p className="rounded-md border border-rose-300/70 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-700 dark:border-[#f43f5e]/25 dark:bg-[#f43f5e]/10 dark:text-[#fda4af]">{actionError}</p>
      ) : null}
      {detail.data.run.status === "failed" && <WorkflowReplacementProposal key={`${companyId}:${runId}`} companyId={companyId} runId={runId} />}
      <WorkflowRunGraphPreview
        steps={runGraphSteps}
        pendingStepRunId={pendingStepId}
        onRerunStep={(input) => {
          void handleRerunStep({ stepRunId: input.stepRunId, issueId: input.issueId });
        }}
      />
      <div className="tactile-card overflow-hidden rounded-xl border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-50/80 dark:bg-[#090c12]">
              <tr>
                <th className={TABLE_HEAD}>Step</th>
                <th className={TABLE_HEAD}>Issue</th>
                <th className={TABLE_HEAD}>Type</th>
                <th className={TABLE_HEAD}>Status</th>
                <th className={TABLE_HEAD}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/80 dark:divide-white/[0.07]">
              {detail.data.stepRuns.map((step) => {
                const canRerun = Boolean(step.id && companyId.trim() && (step.issueId || step.id));
                const isPending = pendingStepId === step.id;
                return (
                  <tr key={step.id} className="transition-colors hover:bg-slate-50/90 dark:hover:bg-white/[0.045]">
                    <td className={TABLE_CELL}>
                      <div className="grid gap-0.5">
                        <span className="text-[13px] font-semibold text-slate-900 dark:text-[#eef2f8]">{step.stepTitle || step.stepId}</span>
                        <span className="font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">{step.stepId}</span>
                      </div>
                    </td>
                    <td className={TABLE_CELL}>
                      {step.issueId ? (
                        <a
                          href={buildIssueHref({
                            issueId: step.issueId,
                            issueIdentifier: step.issueIdentifier,
                            currentPathname: currentBrowserPathname(),
                          })}
                          className="font-mono text-xs text-blue-600 no-underline transition-colors hover:text-blue-500 dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
                          title={step.issueId}
                        >
                          {step.issueIdentifier || step.issueId.slice(0, 8)}
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-[#627089]">-</span>
                      )}
                    </td>
                    <td className={cn(TABLE_CELL, "text-xs text-slate-600 dark:text-[#b8c2d4]")}>{step.stepType || "-"}</td>
                    <td className={TABLE_CELL}>
                      <span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-semibold", statusToneClass(step.status))}>{step.status}</span>
                    </td>
                    <td className={TABLE_CELL}>
                      <button
                        type="button"
                        className={ACTION_BUTTON}
                        disabled={!canRerun || isPending}
                        onClick={() => {
                          void handleRerunStep({ stepRunId: step.id, issueId: step.issueId });
                        }}
                      >
                        {isPending ? "Rerunning..." : "Rerun Step"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
