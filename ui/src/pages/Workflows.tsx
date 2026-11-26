import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { jsonToSteps, stepsToJson, type StepDraft } from "./workflows/step-draft.js";
import type { LabelOption, PluginPageProps, StatusFilter, WorkflowScopeFilter, WorkflowSummary } from "./workflows/workflow-page-types.js";
import { fetchCompanyLabels, useAvailableWorkflowTools, useHostContext, usePluginAction, useWorkflowOverview } from "./workflows/workflow-page-api.js";
import { filterRunsForWorkflows, isManualMissionPlanWorkflow } from "./workflows/workflow-filters.js";
import { WorkflowHelpOverlay } from "./workflows/workflow-help-overlay.js";
import { WorkflowDefinitionsResizeHandle } from "./workflows/workflow-definitions-resize-handle.js";
import { WorkflowDefinitionsToolbar } from "./workflows/workflow-definitions-toolbar.js";
import { shouldShowWorkflowLoadingState, WorkflowErrorState, WorkflowLoadingState } from "./workflows/workflow-page-states.js";
import { DefinitionsTable } from "./workflows/workflow-definitions-table.js";
import { WorkflowCreateForm } from "./workflows/workflow-create-form.js";
export { WorkflowDashboardWidget, WorkflowSidebarLink } from "./workflows/workflow-sidebar-and-widget.js";
import { WorkflowRunSections, type WorkflowRunHistoryScope } from "./workflows/workflow-run-sections.js";
import { renderWorkflowGraphEditor } from "./workflows/graph-editor/WorkflowGraphEditor.js";

export { jsonToSteps, stepsToJson };
export type { StepDraft };

const PLUGIN_ID = "paperclip.core-workflows";

// Fix: prevent parent window from capturing arrow keys in textareas
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === "TEXTAREA" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.stopPropagation();
    }
  }, true);
}

// Combo 1 Tactile Telemetry Cockpit palette with full light/dark legibility.
// Workflow sub-components style themselves with inline `var(--*)` declarations, so the page
// binds tokens for both light mode and `.dark` obsidian surfaces with 1px specular top highlights.
const COCKPIT_CSS = `
#wf-page {
  --background: #f8fafc; --foreground: #0f172a; --card: #ffffff; --card-foreground: #0f172a;
  --popover: #f1f5f9; --popover-foreground: #0f172a; --primary: #2563eb; --primary-foreground: #ffffff;
  --secondary: #f1f5f9; --secondary-foreground: #0f172a; --muted: #f1f5f9; --muted-foreground: #64748b;
  --accent: #e2e8f0; --accent-foreground: #0f172a; --border: #e2e8f0; --input: #cbd5e1; --ring: #2563eb;
}
.dark #wf-page {
  color-scheme: dark;
  --background: #07090d; --foreground: #edf2fb; --card: #0e131d; --card-foreground: #edf2fb;
  --popover: #0b0f18; --popover-foreground: #edf2fb; --primary: #2563eb; --primary-foreground: #f8fafc;
  --secondary: #0b0f18; --secondary-foreground: #edf2fb; --muted: #0b0f18; --muted-foreground: #8b97ad;
  --accent: #161f30; --accent-foreground: #edf2fb; --border: rgba(255, 255, 255, 0.08); --input: rgba(255, 255, 255, 0.1); --ring: #60a5fa;
}
/* Side rail + inspector dialog: recessed tactile surfaces. */
#wf-page #wf-rail { --background: #f1f5f9; --card: #f8fafc; }
.dark #wf-page #wf-rail { --background: #090d14; --card: #0b0f18; }
#wf-page [data-graph-details-dialog] { --background: #ffffff; }
.dark #wf-page [data-graph-details-dialog] { --background: #0e131d; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06); }
/* Run panels: Combo 1 tactile cards with 1px specular top highlight in dark mode. */
#wf-page #wf-active-runs, #wf-page #wf-run-history {
  --background: #ffffff; --card: #ffffff;
  border-radius: 0.75rem;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(15, 23, 42, 0.04);
}
.dark #wf-page #wf-active-runs, .dark #wf-page #wf-run-history {
  --background: #0e131d; --card: #0e131d;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 6px 24px -10px rgba(0, 0, 0, 0.65);
}
/* Run metrics and counts align in columns. */
#wf-page table { font-variant-numeric: tabular-nums; }
`;

const PAGE_CLASS = "-m-4 md:-m-6 flex min-h-[calc(100dvh-3rem)] flex-col bg-slate-50 text-slate-900 tabular-nums dark:bg-[#07090d] dark:text-[#edf2fb]";
const SELECT_CLASS = "h-7.5 min-w-0 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090d14] dark:text-[#edf2fb] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const ACTION_CLASS = "inline-flex h-7.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-[#60a5fa]/40";

function WorkflowControlBar({ workflows, navigatorSearch, onNavigatorSearchChange, runningCount, workflowCount, runCount, showHelp, onToggleHelp, showNewWorkflowForm, onNewWorkflow, isRefreshing, refreshButtonLabel, onRefresh }: {
  workflows: WorkflowSummary[]; navigatorSearch: string; onNavigatorSearchChange: (value: string) => void;
  runningCount: number; workflowCount: number; runCount: number;
  showHelp: boolean; onToggleHelp: () => void; showNewWorkflowForm: boolean; onNewWorkflow: () => void;
  isRefreshing: boolean; refreshButtonLabel: string; onRefresh: () => void;
}): JSX.Element {
  const focusedWorkflow = workflows.find((workflow) => workflow.name === navigatorSearch) ?? null;
  const hasRunning = runningCount > 0;
  return (
    <header
      id="wf-header"
      className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2.5 border-b border-slate-200/90 bg-white/95 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur dark:border-white/[0.08] dark:bg-[#0e131d]/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
    >
      <h1 className="truncate text-sm font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">Workflows</h1>
      <button
        type="button"
        aria-label="Help"
        aria-pressed={showHelp}
        title={showHelp ? "도움말 닫기" : "도움말"}
        onClick={onToggleHelp}
        className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-slate-300/90 bg-slate-50 text-[11px] font-bold leading-none text-slate-600 transition-colors hover:border-blue-500/50 hover:text-slate-950 dark:border-white/[0.12] dark:bg-[#090d14] dark:text-[#8b97ad] dark:hover:border-[#60a5fa]/50 dark:hover:text-[#edf2fb]"
      >
        ?
      </button>
      <select
        aria-label="Focus workflow"
        title="Focus the definition list and navigator on one workflow"
        className={`${SELECT_CLASS} max-w-[240px]`}
        value={focusedWorkflow?.id ?? ""}
        onChange={(event) => onNavigatorSearchChange(workflows.find((workflow) => workflow.id === event.target.value)?.name ?? "")}
      >
        <option value="">All workflows</option>
        {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
      </select>
      <span
        role="status"
        className={`hidden min-w-0 items-center gap-2 rounded-full border px-3 py-1 text-[11px] tabular-nums sm:inline-flex ${
          hasRunning
            ? "border-lime-500/35 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:text-[#d9f99d]"
            : "border-slate-200/90 bg-slate-100/80 text-slate-600 dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#8b97ad]"
        }`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${
            hasRunning
              ? "bg-lime-500 animate-pulse shadow-[0_0_8px_rgba(163,230,53,0.7)] dark:bg-[#a3e635]"
              : "bg-blue-500 dark:bg-[#60a5fa]"
          }`}
        />
        <span className="truncate">
          <b className="font-mono font-semibold text-slate-950 dark:text-[#edf2fb]">{runningCount}</b> running
          <span className="mx-1.5 opacity-40">·</span>
          <b className="font-mono font-semibold text-slate-950 dark:text-[#edf2fb]">{workflowCount}</b> workflows
          <span className="mx-1.5 opacity-40">·</span>
          <b className="font-mono font-semibold text-slate-950 dark:text-[#edf2fb]">{runCount}</b> runs
        </span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          className={`${ACTION_CLASS} bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]`}
          disabled={showNewWorkflowForm}
          onClick={onNewWorkflow}
        >
          + New Workflow
        </button>
        <button
          type="button"
          className={`${ACTION_CLASS} border border-slate-200/90 bg-white text-slate-700 hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#0b0f18] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]`}
          disabled={isRefreshing}
          onClick={() => { void onRefresh(); }}
        >
          {refreshButtonLabel}
        </button>
      </div>
    </header>
  );
}

export function WorkflowPage(props: PluginPageProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context?.companyId ?? "";
  const overview = useWorkflowOverview(companyId);
  const { tools: availableTools, grants: availableToolGrants, toolSystem } = useAvailableWorkflowTools(companyId);
  const createWorkflow = usePluginAction("create-workflow");
  const abortRun = usePluginAction("abort-run");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [workflowScopeFilter, setWorkflowScopeFilter] = useState<WorkflowScopeFilter>("reusable");
  const [workflowStatusFilter, setWorkflowStatusFilter] = useState<StatusFilter>("active");
  const [runHistoryScope, setRunHistoryScope] = useState<WorkflowRunHistoryScope>("all");
  const [activeRunsScope, setActiveRunsScope] = useState<WorkflowRunHistoryScope>("all");
  const [selectedHistoryWorkflowId, setSelectedHistoryWorkflowId] = useState<string | null>(null);
  const [navigatorSearch, setNavigatorSearch] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showNewWorkflowForm, setShowNewWorkflowForm] = useState(false);
  const [definitionsCollapsed, setDefinitionsCollapsed] = useState(false);
  const [definitionsHeight, setDefinitionsHeight] = useState<number | null>(null);
  const definitionsResizeRef = useRef<number>(0);
  const definitionsStartY = useRef<number>(0);
  const [labels, setLabels] = useState<LabelOption[]>([]);
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null);

  async function refreshOverview(): Promise<void> {
    if (isRefreshing) {
      return;
    }
    setIsRefreshing(true);
    try {
      await overview.refresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    const nextLabels = overview.data?.labels ?? [];
    setLabels(nextLabels.map((label) => ({
      id: String(label.id),
      name: String(label.name ?? label.id),
      color: typeof label.color === "string" && label.color.trim() ? label.color : "#6366f1",
    })));
  }, [overview.data?.labels]);

  useEffect(() => {
    if (!companyId.trim()) {
      setLabels([]);
    }
  }, [companyId]);

  async function refreshLabels(): Promise<LabelOption[]> {
    const next = await fetchCompanyLabels(companyId);
    setLabels(next);
    return next;
  }

  function handleAbortRun(runId: string): void {
    void (async () => {
      try {
        await abortRun({ runId });
        await refreshOverview();
      } catch { /* ignore */ }
    })();
  }

  const refreshButtonLabel = isRefreshing ? "갱신 중..." : "↻ Refresh";

  const allWorkflows = overview.data?.workflows ?? [];
  const reusableWorkflows = useMemo(
    () => allWorkflows.filter((workflow) => !isManualMissionPlanWorkflow(workflow)),
    [allWorkflows],
  );
  const manualMissionWorkflows = useMemo(
    () => allWorkflows.filter(isManualMissionPlanWorkflow),
    [allWorkflows],
  );
  const scopedWorkflows = workflowScopeFilter === "manual_mission" ? manualMissionWorkflows : reusableWorkflows;
  const activeWorkflows = useMemo(
    () => scopedWorkflows.filter((w) => w.status.trim().toLowerCase() !== "archived"),
    [scopedWorkflows],
  );
  const archivedWorkflows = useMemo(
    () => scopedWorkflows.filter((w) => w.status.trim().toLowerCase() === "archived"),
    [scopedWorkflows],
  );
  const filteredWorkflows = workflowStatusFilter === "active" ? activeWorkflows : archivedWorkflows;

  if (shouldShowWorkflowLoadingState(overview.loading, overview.data !== null)) {
    return <WorkflowLoadingState pluginId={PLUGIN_ID} isRefreshing={isRefreshing} refreshButtonLabel={refreshButtonLabel} onRefresh={refreshOverview} />;
  }

  if (overview.error) {
    return <WorkflowErrorState pluginId={PLUGIN_ID} isRefreshing={isRefreshing} refreshButtonLabel={refreshButtonLabel} onRefresh={refreshOverview} message={`Failed to load workflows: ${overview.error.message}`} onRetry={refreshOverview} />;
  }

  const data = {
    workflows: overview.data?.workflows ?? [],
    activeRuns: overview.data?.activeRuns ?? [],
    recentRuns: overview.data?.recentRuns ?? [],
    projects: overview.data?.projects ?? [],
    labels: overview.data?.labels ?? [],
  };
  const scopedActiveRuns = filterRunsForWorkflows(data.activeRuns, scopedWorkflows);
  const scopedRecentRuns = filterRunsForWorkflows(data.recentRuns, scopedWorkflows);
  const selectedHistoryWorkflow = selectedHistoryWorkflowId
    ? scopedWorkflows.find((workflow) => workflow.id === selectedHistoryWorkflowId) ?? null
    : null;
  const selectedHistoryRuns = selectedHistoryWorkflow
    ? filterRunsForWorkflows(scopedRecentRuns, [selectedHistoryWorkflow])
    : [];
  const historyRuns = runHistoryScope === "selected" && selectedHistoryWorkflow
    ? selectedHistoryRuns
    : scopedRecentRuns;
  const canFilterSelectedHistory = Boolean(selectedHistoryWorkflow);
  const selectedActiveRuns = selectedHistoryWorkflow
    ? filterRunsForWorkflows(scopedActiveRuns, [selectedHistoryWorkflow])
    : [];
  const displayActiveRuns = activeRunsScope === "selected" && selectedHistoryWorkflow
    ? selectedActiveRuns
    : scopedActiveRuns;
  // Full-bleed: the host <main> adds p-4/md:p-6, cancelled by PAGE_CLASS negative margins. The canvas band
  // keeps only a 12px gutter so the DAG shell keeps the viewport-based height it derives from 100dvh.
  const definitionsSectionStyle: CSSProperties = {
    display: "grid", gap: 0, padding: "0 12px", height: definitionsCollapsed || definitionsHeight === null ? "auto" : `${definitionsHeight}px`, overflow: definitionsHeight === null ? "visible" : "auto", minHeight: definitionsCollapsed ? "auto" : "200px",
  };

  return (
    <div data-plugin-id={PLUGIN_ID} id="wf-page" className={PAGE_CLASS}>
      <style data-wf-cockpit-style="true">{COCKPIT_CSS}</style>
      <WorkflowControlBar workflows={scopedWorkflows} navigatorSearch={navigatorSearch} onNavigatorSearchChange={setNavigatorSearch} runningCount={scopedActiveRuns.length} workflowCount={filteredWorkflows.length} runCount={scopedRecentRuns.length}
        showHelp={showHelp} onToggleHelp={() => setShowHelp(!showHelp)} showNewWorkflowForm={showNewWorkflowForm} onNewWorkflow={() => { setShowNewWorkflowForm(true); }}
        isRefreshing={isRefreshing} refreshButtonLabel={refreshButtonLabel} onRefresh={refreshOverview} />

      <section id="wf-definitions" key="definitions-section" style={definitionsSectionStyle} className="pt-2">
        <div
          key="definitions-toolbar-row"
          className="mb-2 flex min-h-10 items-center rounded-xl border border-slate-200/90 bg-white/95 px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
        >
          <WorkflowDefinitionsToolbar
            navigatorSearch={navigatorSearch}
            onNavigatorSearchChange={setNavigatorSearch}
            workflowScopeFilter={workflowScopeFilter}
            onWorkflowScopeFilterChange={setWorkflowScopeFilter}
            workflowStatusFilter={workflowStatusFilter}
            onWorkflowStatusFilterChange={setWorkflowStatusFilter}
            reusableCount={reusableWorkflows.length}
            manualCount={manualMissionWorkflows.length}
            activeCount={activeWorkflows.length}
            archivedCount={archivedWorkflows.length}
            definitionsCollapsed={definitionsCollapsed}
            onToggleCollapsed={() => setDefinitionsCollapsed((prev) => !prev)}
          />
        </div>
        {!definitionsCollapsed && (
          <Fragment key="definitions-body">
            {showNewWorkflowForm ? (
              <WorkflowCreateForm companyId={companyId} projects={data.projects ?? []} toolSystem={toolSystem} availableTools={availableTools} availableToolGrants={availableToolGrants} renderGraphEditor={renderWorkflowGraphEditor} onCreated={refreshOverview} onCancel={() => setShowNewWorkflowForm(false)} onLabelsRefresh={refreshLabels} />
            ) : (
              <DefinitionsTable
                key="definitions-table"
                workflows={filteredWorkflows}
                companyId={companyId}
                refreshOverview={refreshOverview}
                projects={data.projects ?? []}
                labels={labels}
                refreshLabels={refreshLabels}
                activeRuns={scopedActiveRuns}
                recentRuns={scopedRecentRuns}
                onManualRunStarted={setHighlightedRunId}
                highlightedRunId={highlightedRunId}
                onAbortRun={handleAbortRun}
                navigatorSearch={navigatorSearch}
                onEditingWorkflowChange={setSelectedHistoryWorkflowId}
                availableTools={availableTools}
                availableToolGrants={availableToolGrants}
              />
            )}
          </Fragment>
        )}
      </section>

      <WorkflowDefinitionsResizeHandle
        collapsed={definitionsCollapsed}
        height={definitionsHeight}
        resizeRef={definitionsResizeRef}
        startYRef={definitionsStartY}
        onHeightChange={setDefinitionsHeight}
      />

      <div key="run-panels" className="grid min-w-0 gap-3.5 px-3.5 py-3.5 xl:grid-cols-2">
        <WorkflowRunSections
          activeRunsScope={activeRunsScope}
          runHistoryScope={runHistoryScope}
          onActiveRunsScopeChange={setActiveRunsScope}
          onRunHistoryScopeChange={setRunHistoryScope}
          selectedHistoryWorkflow={selectedHistoryWorkflow}
          scopedActiveRuns={scopedActiveRuns}
          selectedActiveRuns={selectedActiveRuns}
          displayActiveRuns={displayActiveRuns}
          canFilterSelectedHistory={canFilterSelectedHistory}
          scopedRecentRuns={scopedRecentRuns}
          selectedHistoryRuns={selectedHistoryRuns}
          historyRuns={historyRuns}
          companyId={companyId}
          onAbortRun={handleAbortRun}
          onRefreshOverview={refreshOverview}
          highlightedRunId={highlightedRunId}
        />
      </div>

      {showHelp && <WorkflowHelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export function Workflows(): JSX.Element {
  return <WorkflowPage context={{}} />;
}
