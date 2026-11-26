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

// Stage 10 U4c dark cockpit palette. The workflow sub-components style themselves with inline
// `var(--*)` declarations, so the page pins the tokens here and re-points panel surfaces by
// overriding the custom properties on each panel root (no !important needed).
const COCKPIT_CSS = `
#wf-page {
  color-scheme: dark;
  --background: #0b0e14; --foreground: #e6edf7; --card: #151b28; --card-foreground: #e6edf7;
  --popover: #111622; --popover-foreground: #e6edf7; --primary: #2563eb; --primary-foreground: #f8fafc;
  --secondary: #111622; --secondary-foreground: #e6edf7; --muted: #111622; --muted-foreground: #8b97ad;
  --accent: #1b2433; --accent-foreground: #e6edf7; --border: #242d3f; --input: #242d3f; --ring: #5f8dff;
}
/* Side rail + inspector dialog: #111622 surfaces, 1px #242d3f hairlines (resolved through their inline var() styles). */
#wf-page #wf-rail { --background: #111622; --card: #111622; }
#wf-page [data-graph-details-dialog] { --background: #111622; }
/* Run panels: #151b28 card surfaces. */
#wf-page #wf-active-runs, #wf-page #wf-run-history { --background: #151b28; --card: #151b28; }
/* Run metrics align in columns. */
#wf-page table { font-variant-numeric: tabular-nums; }
`;

const PAGE_CLASS = "-m-4 md:-m-6 flex min-h-[calc(100dvh-3rem)] flex-col bg-[#0b0e14] text-[#e6edf7]";
const SELECT_CLASS = "h-7 min-w-0 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#e6edf7] outline-none focus:border-[#2563eb]";
const ACTION_CLASS = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs font-semibold text-[#f8fafc] outline-none focus-visible:ring-1 focus-visible:ring-[#5f8dff] disabled:cursor-not-allowed disabled:opacity-60";

function WorkflowControlBar({ workflows, navigatorSearch, onNavigatorSearchChange, runningCount, workflowCount, runCount, showHelp, onToggleHelp, showNewWorkflowForm, onNewWorkflow, isRefreshing, refreshButtonLabel, onRefresh }: {
  workflows: WorkflowSummary[]; navigatorSearch: string; onNavigatorSearchChange: (value: string) => void;
  runningCount: number; workflowCount: number; runCount: number;
  showHelp: boolean; onToggleHelp: () => void; showNewWorkflowForm: boolean; onNewWorkflow: () => void;
  isRefreshing: boolean; refreshButtonLabel: string; onRefresh: () => void;
}): JSX.Element {
  const focusedWorkflow = workflows.find((workflow) => workflow.name === navigatorSearch) ?? null;
  return (
    <header id="wf-header" className="sticky top-0 z-20 flex h-10 shrink-0 items-center gap-2 border-b border-[#242d3f] bg-[#111622] px-2">
      <h1 className="truncate text-[13px] font-semibold tracking-wide text-[#e6edf7]">Workflows</h1>
      <button type="button" aria-label="Help" aria-pressed={showHelp} title={showHelp ? "도움말 닫기" : "도움말"} onClick={onToggleHelp}
        className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#242d3f] bg-transparent text-[11px] font-bold leading-none text-[#8b97ad] hover:text-[#e6edf7]">?</button>
      <select aria-label="Focus workflow" title="Focus the definition list and navigator on one workflow" className={`${SELECT_CLASS} max-w-[220px]`} value={focusedWorkflow?.id ?? ""}
        onChange={(event) => onNavigatorSearchChange(workflows.find((workflow) => workflow.id === event.target.value)?.name ?? "")}>
        <option value="">All workflows</option>
        {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
      </select>
      <span role="status" className="hidden min-w-0 items-center gap-1.5 rounded-full border border-[#242d3f] bg-[#0b0e14] px-2.5 py-0.5 text-[11px] tabular-nums text-[#8b97ad] sm:inline-flex">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${runningCount > 0 ? "bg-[#5f8dff]" : "bg-[#34d399]"}`} />
        <span className="truncate"><b className="font-semibold text-[#e6edf7]">{runningCount}</b> running · <b className="font-semibold text-[#e6edf7]">{workflowCount}</b> workflows · <b className="font-semibold text-[#e6edf7]">{runCount}</b> runs</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button type="button" className={`${ACTION_CLASS} bg-[#2563eb] hover:bg-[#1d4ed8]`} disabled={showNewWorkflowForm} onClick={onNewWorkflow}>+ New Workflow</button>
        <button type="button" className={`${ACTION_CLASS} border border-[#2563eb] bg-[#2563eb]/20 hover:bg-[#2563eb]/35`} disabled={isRefreshing} onClick={() => { void onRefresh(); }}>
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

      <section id="wf-definitions" key="definitions-section" style={definitionsSectionStyle}>
        <div key="definitions-toolbar-row" className="flex min-h-9 items-center">
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

      <div key="run-panels" className="grid min-w-0 gap-3 px-3 py-3 xl:grid-cols-2">
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
