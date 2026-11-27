import { Fragment, lazy, Suspense, useEffect, useState, type JSX } from "react";
import { buildManualRunFeedback, findNewRunId, manualRunUnavailableMessage } from "./run-feedback.js";
import { WorkflowRunDialog } from "./workflow-run-dialog.js";
import type { WorkflowRunSubmission } from "./workflow-run-inputs.js";
import type { WorkflowRunDrawerMode } from "./workflow-runs.js";
import { jsonToSteps, stepsToJson, type StepDraft } from "./step-draft.js";
import { applyStepRunsToGraphSteps, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphRunDebugSummary, type WorkflowGraphNavigatorFilter } from "./workflow-graph.js";
import type { CreateParentIssuePolicy } from "./workflow-parent-policy.js";
import type { StepEditorMode, ProjectOption, LabelOption, WorkflowToolOption, WorkflowToolGrant, WorkflowOverviewData, WorkflowRestoreKind, WorkflowRunSummary } from "./workflow-page-types.js";
import { createCompanyLabel, usePluginAction, useWorkflowRunDetail } from "./workflow-page-api.js";
import { filterRunsForWorkflows } from "./workflow-filters.js";
import { WorkflowDefinitionList } from "./workflow-definition-list.js";
import { WorkflowRestoreDialog } from "./workflow-restore-dialog.js";
import { buildWorkflowDefinitionEditDraft, emptyWorkflowDefinitionEditDraft, type WorkflowDefinitionEditDraft } from "./workflow-definition-edit-draft.js";
import { buildWorkflowDefinitionEditPatch } from "./workflow-definition-edit-patch.js";
export { WorkflowDashboardWidget, WorkflowSidebarLink } from "./workflow-sidebar-and-widget.js";
import { WorkflowDefinitionEditorShell } from "./workflow-definition-editor-shell.js";
import type { StepWorkspaceGraphEditorProps } from "./step-workspace-editor.js";

// graph-editor UI 묶음은 무거우므로 편집기를 처음 열 때 로드한다(lazy 경계).
const LazyWorkflowGraphEditor = lazy(async () => ({ default: (await import("./graph-editor/WorkflowGraphEditor.js")).renderWorkflowGraphEditor }));
function renderLazyWorkflowGraphEditor(props: StepWorkspaceGraphEditorProps): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyWorkflowGraphEditor {...props} />
    </Suspense>
  );
}

export { jsonToSteps, stepsToJson };

const WORKFLOW_DEFINITIONS_COCKPIT_CSS = `
.workflow-definitions-cockpit {
  --background: #f8fafc; --card: #ffffff; --border: rgba(15, 23, 42, 0.13);
  --foreground: #0f172a; --muted-foreground: #64748b; --link: #2563eb;
}
.dark .workflow-definitions-cockpit {
  --background: #090c12; --card: #0e131d; --border: rgba(255, 255, 255, 0.08);
  --foreground: #eef2f8; --muted-foreground: #8b97ad; --link: #60a5fa;
}
.workflow-definitions-cockpit #wf-editor {
  border: 1px solid var(--border) !important; border-radius: 12px !important;
  background: var(--card) !important; overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.88), 0 1px 2px rgba(15,23,42,0.05) !important;
}
.dark .workflow-definitions-cockpit #wf-editor {
  background: linear-gradient(180deg, rgba(17,22,33,0.96), rgba(13,17,24,0.98)) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 10px 28px rgba(0,0,0,0.36) !important;
}
.workflow-definitions-cockpit #wf-rail {
  background: #f8fafc !important; border-right-color: var(--border) !important;
}
.dark .workflow-definitions-cockpit #wf-rail { background: #090c12 !important; }
.workflow-definitions-cockpit #wf-rail button:has(strong) {
  --background: var(--card); border-radius: 10px !important; padding: 10px !important;
  transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
@media (hover: hover) {
  .workflow-definitions-cockpit #wf-rail button:has(strong):hover {
    background: rgba(37, 99, 235, 0.07) !important; border-color: rgba(37, 99, 235, 0.22) !important;
  }
  .dark .workflow-definitions-cockpit #wf-rail button:has(strong):hover {
    background: rgba(96, 165, 250, 0.08) !important; border-color: rgba(96, 165, 250, 0.24) !important;
  }
}
.workflow-definitions-cockpit #wf-rail button[style*="#22c55e"]:has(strong) {
  background: rgba(37, 99, 235, 0.1) !important; border-color: rgba(37, 99, 235, 0.34) !important;
  box-shadow: inset 2px 0 0 #2563eb;
}
.dark .workflow-definitions-cockpit #wf-rail button[style*="#22c55e"]:has(strong) {
  background: rgba(96, 165, 250, 0.11) !important; border-color: rgba(96, 165, 250, 0.36) !important;
  box-shadow: inset 2px 0 0 #60a5fa;
}
.workflow-definitions-cockpit #wf-editor input:not([type="checkbox"]):not([type="radio"]),
.workflow-definitions-cockpit #wf-editor select,
.workflow-definitions-cockpit #wf-editor textarea {
  border: 1px solid var(--border) !important; border-radius: 8px !important;
  background: var(--background) !important; color: var(--foreground) !important;
  min-height: 28px; font-size: 12px !important;
}
.workflow-definitions-cockpit #wf-editor input:not([type="checkbox"]):not([type="radio"]):focus,
.workflow-definitions-cockpit #wf-editor select:focus,
.workflow-definitions-cockpit #wf-editor textarea:focus {
  border-color: #2563eb !important; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.16) !important; outline: none !important;
}
.dark .workflow-definitions-cockpit #wf-editor input:not([type="checkbox"]):not([type="radio"]):focus,
.dark .workflow-definitions-cockpit #wf-editor select:focus,
.dark .workflow-definitions-cockpit #wf-editor textarea:focus {
  border-color: #60a5fa !important; box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.18) !important;
}
.workflow-definitions-cockpit #wf-editor > div:last-child > div:first-child button {
  border-radius: 8px !important; min-height: 28px; font-size: 12px !important;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
}
.workflow-definition-list-cockpit > div { gap: 6px !important; }
.workflow-definition-list-cockpit > div > div {
  border: 1px solid var(--border) !important; border-radius: 12px !important;
  background: var(--card) !important; padding: 10px 12px !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.82), 0 1px 2px rgba(15,23,42,0.04);
  transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}
.dark .workflow-definition-list-cockpit > div > div {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 6px 18px rgba(0,0,0,0.24);
}
@media (hover: hover) {
  .workflow-definition-list-cockpit > div > div:hover {
    border-color: rgba(37,99,235,0.32) !important; background: rgba(37,99,235,0.045) !important;
  }
  .dark .workflow-definition-list-cockpit > div > div:hover {
    border-color: rgba(96,165,250,0.34) !important; background: rgba(96,165,250,0.055) !important;
  }
}
.workflow-definition-list-cockpit button {
  border-radius: 8px !important; min-height: 28px; font-size: 12px !important;
}
`;

function noticeClass(tone: "error" | "info" | "success"): string {
  if (tone === "error") {
    return "rounded-md border border-rose-300/70 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-700 dark:border-[#f43f5e]/25 dark:bg-[#f43f5e]/10 dark:text-[#fda4af]";
  }
  if (tone === "success") {
    return "rounded-md border border-lime-500/25 bg-lime-500/10 px-2.5 py-1.5 text-xs text-lime-700 dark:border-[#a3e635]/25 dark:bg-[#a3e635]/10 dark:text-[#bef264]";
  }
  return "rounded-md border border-blue-500/25 bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-700 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10 dark:text-[#93c5fd]";
}

export function DefinitionsTable({
  workflows,
  companyId,
  refreshOverview,
  projects,
  labels,
  refreshLabels,
  activeRuns,
  recentRuns,
  onManualRunStarted,
  highlightedRunId,
  onAbortRun,
  navigatorSearch,
  onEditingWorkflowChange,
  availableTools,
  availableToolGrants,
}: {
  workflows: WorkflowOverviewData["workflows"];
  companyId: string;
  refreshOverview: () => Promise<void>;
  projects: ProjectOption[];
  labels: LabelOption[];
  refreshLabels: () => Promise<LabelOption[]>;
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  onManualRunStarted: (runId: string | null) => void;
  highlightedRunId: string | null;
  onAbortRun: (runId: string) => void;
  navigatorSearch: string;
  onEditingWorkflowChange?: (workflowId: string | null) => void;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
}): JSX.Element {
  const updateWorkflow = usePluginAction("update-workflow");
  const deleteWorkflow = usePluginAction("delete-workflow");
  const runWorkflow = usePluginAction("start-workflow");
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(true);
  const [editingName, setEditingName] = useState<string>("");
  const [editingDescription, setEditingDescription] = useState<string>("");
  const [editingStatus, setEditingStatus] = useState<string>("active");
  const [editingTriggerLabels, setEditingTriggerLabels] = useState<string>("");
  const [editingLabelIds, setEditingLabelIds] = useState<string[]>([]);
  const [showNewLabelForm, setShowNewLabelForm] = useState<boolean>(false);
  const [newLabelName, setNewLabelName] = useState<string>("");
  const [newLabelColor, setNewLabelColor] = useState<string>("#6366f1");
  const [creatingLabel, setCreatingLabel] = useState<boolean>(false);
  const [editingSchedule, setEditingSchedule] = useState<string>("");
  const [editingMaxDailyRuns, setEditingMaxDailyRuns] = useState<string>("");
  const [editingTimezone, setEditingTimezone] = useState<string>("Asia/Seoul");
  const [editingProjectId, setEditingProjectId] = useState<string>("");
  const [editingCreateParentIssuePolicy, setEditingCreateParentIssuePolicy] = useState<CreateParentIssuePolicy>("when_multiple_steps");
  const [editingSteps, setEditingSteps] = useState<StepDraft[]>([]);
  const [editStepMode, setEditStepMode] = useState<StepEditorMode>("graph");
  const [editJsonText, setEditJsonText] = useState("");
  const [editingFlowInputsText, setEditingFlowInputsText] = useState("[]");
  const [editingFlowEnvVariablesText, setEditingFlowEnvVariablesText] = useState("[]");
  const [editingTestInputPresetsText, setEditingTestInputPresetsText] = useState("[]");
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<WorkflowOverviewData["workflows"][number] | null>(null);
  const [runTarget, setRunTarget] = useState<WorkflowOverviewData["workflows"][number] | null>(null);
  const [tableError, setTableError] = useState<string>("");
  const [tableNotice, setTableNotice] = useState<{ tone: "info" | "success"; message: string } | null>(null);
  const [graphShellDismissed, setGraphShellDismissed] = useState<boolean>(false);
  const [runDrawerMode, setRunDrawerMode] = useState<WorkflowRunDrawerMode>("closed");
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const navigatorFilter: WorkflowGraphNavigatorFilter = "all";
  const inspectedRunDetail = useWorkflowRunDetail(inspectedRunId);

  function clearTableFeedback(): void {
    setTableError("");
    setTableNotice(null);
  }

  function applyEditDraft(draft: WorkflowDefinitionEditDraft): void {
    setEditingName(draft.name);
    setEditingDescription(draft.description);
    setEditingStatus(draft.status);
    setEditingTriggerLabels(draft.triggerLabels);
    setEditingLabelIds(draft.labelIds);
    setShowNewLabelForm(draft.showNewLabelForm);
    setNewLabelName(draft.newLabelName);
    setNewLabelColor(draft.newLabelColor);
    setEditingSchedule(draft.schedule);
    setEditingMaxDailyRuns(draft.maxDailyRuns);
    setEditingTimezone(draft.timezone);
    setEditingProjectId(draft.projectId);
    setEditingCreateParentIssuePolicy(draft.createParentIssuePolicy);
    setEditingSteps(draft.steps);
    setEditStepMode(draft.stepMode);
    setEditJsonText(draft.jsonText);
    setEditingFlowInputsText(draft.flowInputsText);
    setEditingFlowEnvVariablesText(draft.flowEnvVariablesText);
    setEditingTestInputPresetsText(draft.testInputPresetsText);
  }

  function beginEdit(workflow: WorkflowOverviewData["workflows"][number]): void {
    clearTableFeedback();
    setGraphShellDismissed(false);
    setRunDrawerMode("closed");
    setInspectedRunId(null);
    setEditingWorkflowId(workflow.id);
    onEditingWorkflowChange?.(workflow.id);
    applyEditDraft(buildWorkflowDefinitionEditDraft(workflow));
  }

  function cancelEdit(): void {
    setGraphShellDismissed(true);
    setEditingWorkflowId(null);
    onEditingWorkflowChange?.(null);
    applyEditDraft(emptyWorkflowDefinitionEditDraft());
    setRunDrawerMode("closed");
    setInspectedRunId(null);
    clearTableFeedback();
  }

  useEffect(() => {
    if (editingWorkflowId || workflows.length === 0) return;
    beginEdit(workflows[0]!);
  }, [editingWorkflowId, workflows]);

  useEffect(() => {
    if (editingWorkflowId && !workflows.some((w) => w.id === editingWorkflowId)) {
      setGraphShellDismissed(false);
      setEditingWorkflowId(null);
      onEditingWorkflowChange?.(null);
    }
  }, [editingWorkflowId, onEditingWorkflowChange, workflows]);

  function switchEditingStepMode(nextMode: StepEditorMode): void {
    if (nextMode === editStepMode) return;
    setTableError("");
    if (nextMode === "json") {
      setEditJsonText(JSON.stringify(stepsToJson(editingSteps), null, 2));
      setEditStepMode(nextMode);
      return;
    }
    if (editStepMode === "json") {
      try {
        const parsed = JSON.parse(editJsonText) as unknown;
        if (!Array.isArray(parsed)) {
          setTableError("steps는 JSON 배열이어야 합니다.");
          return;
        }
        setEditingSteps(jsonToSteps(parsed as WorkflowOverviewData["workflows"][number]["steps"]));
      } catch (error) {
        setTableError(`JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    setEditStepMode(nextMode);
  }

  async function onSaveEdit(workflowId: string): Promise<void> {
    const nextName = editingName.trim();
    if (!nextName) {
      setTableError("name은 필수입니다.");
      return;
    }

    setPendingWorkflowId(workflowId);
    setTableError("");
    try {
      const patchResult = buildWorkflowDefinitionEditPatch({
        name: nextName,
        description: editingDescription,
        status: editingStatus,
        triggerLabels: editingTriggerLabels,
        labelIds: editingLabelIds,
        schedule: editingSchedule,
        maxDailyRuns: editingMaxDailyRuns,
        timezone: editingTimezone,
        projectId: editingProjectId,
        createParentIssuePolicy: editingCreateParentIssuePolicy,
        editStepMode,
        editJsonText,
        editingSteps,
        currentLegacyMetadata: workflows.find((workflow) => workflow.id === workflowId)?.legacyMetadata,
        flowInputsText: editingFlowInputsText,
        flowEnvVariablesText: editingFlowEnvVariablesText,
        testInputPresetsText: editingTestInputPresetsText,
      });
      if ("error" in patchResult) {
        setTableError(patchResult.error);
        return;
      }
      const { patch } = patchResult;
      await updateWorkflow({
        companyId,
        workflowId,
        id: workflowId,
        patch,
        ...patch,
      });
      await refreshOverview();
      setTableNotice({ tone: "success", message: "저장되었습니다." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`수정 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onCreateLabelForEditForm(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) {
      setTableError("새 레이블 이름을 입력하세요.");
      return;
    }
    if (!companyId.trim()) {
      setTableError("companyId가 없어 레이블을 생성할 수 없습니다.");
      return;
    }

    setTableError("");
    setCreatingLabel(true);
    try {
      const created = await createCompanyLabel(companyId, name, newLabelColor);
      const nextLabels = await refreshLabels();
      const createdId = nextLabels.find((label) => label.id === created.id)?.id ?? created.id;
      setEditingLabelIds((prev) => (prev.includes(createdId) ? prev : [...prev, createdId]));
      setNewLabelName("");
      setNewLabelColor("#6366f1");
      setShowNewLabelForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`레이블 생성 실패: ${message}`);
    } finally {
      setCreatingLabel(false);
    }
  }

  async function onDeleteWorkflow(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const accepted = typeof window !== "undefined"
      ? window.confirm(`"${workflow.name}" 워크플로를 보관할까요?`)
      : true;
    if (!accepted) {
      return;
    }

    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await deleteWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        status: "archived",
      });
      if (editingWorkflowId === workflow.id) {
        cancelEdit();
      }
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`삭제 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onToggleStatus(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const normalized = workflow.status.trim().toLowerCase();
    if (normalized !== "active" && normalized !== "paused") {
      return;
    }

    const nextStatus = normalized === "active" ? "paused" : "active";
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: nextStatus },
        status: nextStatus,
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`status 변경 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  function onRunWorkflow(workflow: WorkflowOverviewData["workflows"][number]): void {
    const normalizedStatus = workflow.status.trim().toLowerCase();
    if (normalizedStatus !== "active") {
      setTableError("");
      setTableNotice({ tone: "info", message: manualRunUnavailableMessage(normalizedStatus) });
      onManualRunStarted(null);
      return;
    }

    clearTableFeedback();
    setRunTarget(workflow);
  }

  async function submitRun(submission: WorkflowRunSubmission): Promise<void> {
    if (!runTarget) return;
    const workflow = runTarget;
    const beforeRunIds = new Set([...activeRuns, ...recentRuns].map((run) => run.id));
    setPendingWorkflowId(workflow.id);
    let result: Record<string, unknown> | null | undefined;
    try {
      result = await runWorkflow({ companyId, workflowId: workflow.id, ...submission }) as typeof result;
    } finally {
      setPendingWorkflowId(null);
    }
    // Only the POST above may reject back to the form. A created run is never retried for a refresh error.
    setRunTarget(null);
    try {
      const runId = typeof result?.runId === "string" ? result.runId : typeof result?.id === "string" ? result.id : null;
      const highlightedRunId = findNewRunId(beforeRunIds, runId, activeRuns, recentRuns);
      onManualRunStarted(highlightedRunId);
      setTableNotice({
        tone: "success",
        message: buildManualRunFeedback(workflow.name, {
          id: typeof result?.id === "string" ? result.id : undefined,
          runId: runId ?? undefined,
          parentIssueId: typeof result?.parentIssueId === "string" ? result.parentIssueId : undefined,
          parentIssueIdentifier: typeof result?.parentIssueIdentifier === "string" ? result.parentIssueIdentifier : undefined,
        }),
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`실행은 시작되었지만 화면 갱신에 실패했습니다: ${message}`);
    }
  }

  async function onRestoreWorkflow(workflow: WorkflowOverviewData["workflows"][number], kind: WorkflowRestoreKind): Promise<void> {
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      // 복원 종류에 따라 source/sourceKind 도 갱신. shared PATCH schema 가 source/sourceKind 를
      // 허용하고 workflow-store update 가 patch 를 통과시킨다.
      const sourcePatch = kind === "manual"
        ? { source: "manual_mission", sourceKind: "manual_mission" }
        : { source: "native", sourceKind: "workflow" };
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: "active", ...sourcePatch },
        status: "active",
        ...sourcePatch,
      });
      await refreshOverview();
      setTableNotice({ tone: "success", message: `${workflow.name} 복원 완료 (${kind === "manual" ? "Manual mission plan" : "Reusable procedure"})` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`복원 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  function confirmRestoreWorkflow(kind: WorkflowRestoreKind): void {
    const target = restoreTarget;
    if (!target) return;
    setRestoreTarget(null);
    void onRestoreWorkflow(target, kind);
  }

  if (workflows.length === 0) {
    return <p className="tactile-card rounded-xl border-slate-200/90 bg-white px-3 py-2 text-xs text-slate-600 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#8b97ad]">No workflows defined yet.</p>;
  }

  const editingWorkflow = workflows.find((workflow) => workflow.id === editingWorkflowId) ?? null;
  const editingWorkflowPending = editingWorkflow ? pendingWorkflowId === editingWorkflow.id : false;
  const editingWorkflowActiveRuns = editingWorkflow ? filterRunsForWorkflows(activeRuns, [editingWorkflow]) : [];
  const editingWorkflowRecentRuns = editingWorkflow ? filterRunsForWorkflows(recentRuns, [editingWorkflow]) : [];
  const inspectedRunSummary: WorkflowRunSummary | null = inspectedRunId
    ? [...editingWorkflowActiveRuns, ...editingWorkflowRecentRuns].find((run) => run.id === inspectedRunId) ?? null
    : null;
  const runOverlaySteps = inspectedRunId && inspectedRunDetail.data?.stepRuns
    ? applyStepRunsToGraphSteps(editingSteps, inspectedRunDetail.data.stepRuns)
    : undefined;
  const editingWorkflowRunDebugSummary = inspectedRunId ? buildWorkflowGraphRunDebugSummary({
    steps: editingSteps,
    stepRuns: inspectedRunDetail.data?.stepRuns ?? [],
    selectedStepId: editingSteps[0]?.id ?? "",
  }) : null;
  const navigatorSummary = buildWorkflowGraphDefinitionNavigator({
    workflows,
    activeRuns,
    recentRuns,
    search: navigatorSearch,
    filter: navigatorFilter,
  });

    return (
      <div className="workflow-definitions-cockpit grid gap-2 tabular-nums">
        <style data-workflow-definitions-cockpit="true">{WORKFLOW_DEFINITIONS_COCKPIT_CSS}</style>
        {tableError ? <p key="table-error" className={noticeClass("error")}>{tableError}</p> : null}
        {tableNotice ? <p key="table-notice" className={noticeClass(tableNotice.tone)}>{tableNotice.message}</p> : null}
        {runTarget ? <WorkflowRunDialog key={runTarget.id} workflow={runTarget}
          onCancel={() => setRunTarget(null)} onSubmit={submitRun} /> : null}
            {restoreTarget ? (
              <WorkflowRestoreDialog
                workflow={restoreTarget}
                onCancel={() => setRestoreTarget(null)}
                onConfirm={confirmRestoreWorkflow}
              />
            ) : null}
        {editingWorkflow ? (
        <WorkflowDefinitionEditorShell
          railCollapsed={railCollapsed}
          onRailCollapsedChange={setRailCollapsed}
          visibleItems={navigatorSummary.visibleItems}
          workflows={workflows}
          editingWorkflow={editingWorkflow}
          editingWorkflowPending={editingWorkflowPending}
          editStepMode={editStepMode}
          onActionModeChange={switchEditingStepMode}
          editingName={editingName}
          onEditingNameChange={setEditingName}
          editingDescription={editingDescription}
          onEditingDescriptionChange={setEditingDescription}
          editingStatus={editingStatus}
          onEditingStatusChange={setEditingStatus}
          editingSchedule={editingSchedule}
          onEditingScheduleChange={setEditingSchedule}
          editingTimezone={editingTimezone}
          onEditingTimezoneChange={setEditingTimezone}
          editingProjectId={editingProjectId}
          onEditingProjectIdChange={setEditingProjectId}
          editingMaxDailyRuns={editingMaxDailyRuns}
          onEditingMaxDailyRunsChange={setEditingMaxDailyRuns}
          editingTriggerLabels={editingTriggerLabels}
          onEditingTriggerLabelsChange={setEditingTriggerLabels}
          projects={projects}
          inspectedRunId={inspectedRunId}
          inspectedRunSummary={inspectedRunSummary}
          inspectedRunDetail={inspectedRunDetail}
          runDrawerMode={runDrawerMode}
          onCloseRunOverlay={() => setInspectedRunId(null)}
          onViewRunRow={() => setRunDrawerMode(inspectedRunSummary && editingWorkflowActiveRuns.some((run) => run.id === inspectedRunSummary.id) ? "active" : "recent")}
          editingWorkflowRunDebugSummary={editingWorkflowRunDebugSummary}
          editingSteps={editingSteps}
          onEditingStepsChange={setEditingSteps}
          onWorkspaceModeChange={setEditStepMode}
          editJsonText={editJsonText}
          onEditJsonTextChange={setEditJsonText}
          onJsonError={setTableError}
          runOverlaySteps={runOverlaySteps}
          editingFlowInputsText={editingFlowInputsText}
          editingFlowEnvVariablesText={editingFlowEnvVariablesText}
          editingTestInputPresetsText={editingTestInputPresetsText}
          availableTools={availableTools}
          availableToolGrants={availableToolGrants}
          renderGraphEditor={renderLazyWorkflowGraphEditor}
          onSelectWorkflow={beginEdit}
          onRunWorkflow={(workflow) => { void onRunWorkflow(workflow); }}
          onSaveEdit={(workflowId) => { void onSaveEdit(workflowId); }}
          onCancelEdit={cancelEdit}
          onToggleStatus={(workflow) => { void onToggleStatus(workflow); }}
          onDeleteWorkflow={(workflow) => { void onDeleteWorkflow(workflow); }}
        />
      ) : (
        <Fragment key="selected-workflow-shell-placeholder" />
      )}
      {editingWorkflow ? (
        <Fragment key="definitions-table-hidden-while-editing" />
      ) : (
        <div key="definitions-flow-list-surface" className="workflow-definition-list-cockpit">
          <WorkflowDefinitionList
            key="definitions-flow-list"
            workflows={workflows}
            activeRuns={activeRuns}
            recentRuns={recentRuns}
            pendingWorkflowId={pendingWorkflowId}
            editingWorkflowId={editingWorkflowId}
            onOpenGraph={beginEdit}
            onRunWorkflow={(workflow) => { void onRunWorkflow(workflow); }}
            onRestoreWorkflow={(workflow) => setRestoreTarget(workflow)}
            onDeleteWorkflow={(workflow) => { void onDeleteWorkflow(workflow); }}
            onToggleStatus={(workflow) => { void onToggleStatus(workflow); }}
          />
        </div>
      )}
    </div>
  );
}
