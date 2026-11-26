import { Fragment, useState, type FormEvent, type JSX } from "react";
import { AlertTriangle, Save, X } from "lucide-react";
import type { LabelOption, ProjectOption, StepEditorMode, WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";
import type { CreateParentIssuePolicy } from "./workflow-parent-policy.js";
import { workflowStepsToJsonForSave, type StepDraft } from "./step-draft.js";
import { buildWorkflowInterfaceMetadata, normalizeMaxDailyRunsInput } from "./workflow-form-utils.js";
import { summarizeWorkflowGraphTriggers } from "./workflow-graph.js";
import { createCompanyLabel, usePluginAction } from "./workflow-page-api.js";
import { FieldLabel, HelpIcon } from "./shared-controls.js";
import { GraphModeTabs, StepWorkspaceEditor, type StepWorkspaceGraphEditorProps } from "./step-workspace-editor.js";

type WorkflowToolSystemState = { available: boolean; reason?: string };

const SHELL_CLASS =
  "tactile-card grid min-h-[760px] grid-rows-[auto_auto_minmax(560px,1fr)_auto_auto] gap-0 overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]";

const HEADER_CLASS =
  "flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/80 bg-slate-50/80 p-3 dark:border-white/[0.08] dark:bg-[#090c12]/80";

const IDENTITY_CLASS =
  "grid min-w-0 flex-[1_1_560px] grid-cols-1 gap-2.5 sm:grid-cols-[minmax(220px,0.8fr)_minmax(260px,1.2fr)]";

const ACTIONS_CLASS = "flex flex-wrap items-center justify-end gap-2";

const SETUP_STRIP_CLASS =
  "grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 border-b border-slate-200/80 bg-slate-50/50 px-3 py-2.5 dark:border-white/[0.08] dark:bg-[#090c12]/55";

const FIELD_CLASS = "grid min-w-0 gap-1";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200/90 bg-white px-2.5 py-2 text-[13px] text-slate-950 placeholder:text-slate-400 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] transition-colors focus:border-blue-500/70 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#edf2fb] dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa]/60 dark:focus:ring-[#60a5fa]/20";

const TEXTAREA_CLASS = `${INPUT_CLASS} min-h-[38px] resize-y`;

const SELECT_CLASS = `${INPUT_CLASS} pr-7`;

const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-[13px] font-medium text-white shadow-xs transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/15 dark:bg-white/[0.12] dark:text-[#edf2fb] dark:hover:bg-white/[0.18] dark:focus-visible:ring-[#60a5fa]/40";

const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-xs transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-slate-200 dark:hover:border-white/[0.16] dark:hover:bg-white/[0.06] dark:focus-visible:ring-[#60a5fa]/40";

export function WorkflowCreateForm({
  companyId,
  projects,
  toolSystem,
  availableTools,
  availableToolGrants,
  renderGraphEditor,
  onCreated,
  onCancel,
  onLabelsRefresh,
}: {
  companyId: string;
  projects: ProjectOption[];
  toolSystem: WorkflowToolSystemState;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  renderGraphEditor: (props: StepWorkspaceGraphEditorProps) => JSX.Element;
  onCreated: () => Promise<void> | void;
  onCancel: () => void;
  onLabelsRefresh: () => Promise<LabelOption[]>;
}) {
  const createWorkflow = usePluginAction("create-workflow");
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowDescription, setNewWorkflowDescription] = useState("");
  const [newWorkflowSteps, setNewWorkflowSteps] = useState<StepDraft[]>([]);
  const [newStepMode, setNewStepMode] = useState<StepEditorMode>("graph");
  const [newJsonText, setNewJsonText] = useState("[]");
  const [newFlowInputsText, setNewFlowInputsText] = useState("[]");
  const [newFlowEnvVariablesText, setNewFlowEnvVariablesText] = useState("[]");
  const [newTestInputPresetsText, setNewTestInputPresetsText] = useState("[]");
  const [newTriggerLabels, setNewTriggerLabels] = useState("");
  const [newLabelIds, setNewLabelIds] = useState<string[]>([]);
  const [showNewLabelForm, setShowNewLabelForm] = useState<boolean>(false);
  const [newLabelName, setNewLabelName] = useState<string>("");
  const [newLabelColor, setNewLabelColor] = useState<string>("#6366f1");
  const [creatingLabel, setCreatingLabel] = useState<boolean>(false);
  const [newSchedule, setNewSchedule] = useState("");
  const [newMaxDailyRuns, setNewMaxDailyRuns] = useState("");
  const [newTimezone, setNewTimezone] = useState("Asia/Seoul");
  const [newProjectId, setNewProjectId] = useState("");
  const [newCreateParentIssuePolicy, setNewCreateParentIssuePolicy] = useState<CreateParentIssuePolicy>("when_multiple_steps");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  function resetCreateForm(): void {
    setNewWorkflowName("");
    setNewWorkflowDescription("");
    setNewWorkflowSteps([]);
    setNewStepMode("graph");
    setNewJsonText("[]");
    setNewFlowInputsText("[]");
    setNewFlowEnvVariablesText("[]");
    setNewTestInputPresetsText("[]");
    setNewTriggerLabels("");
    setNewLabelIds([]);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    setNewSchedule("");
    setNewMaxDailyRuns("");
    setNewTimezone("Asia/Seoul");
    setNewProjectId("");
    setNewCreateParentIssuePolicy("when_multiple_steps");
    setCreateError("");
    onCancel();
  }

  async function onCreateWorkflow(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newWorkflowName.trim();
    if (!name) {
      setCreateError("name은 필수입니다.");
      return;
    }

    const serializedSteps = workflowStepsToJsonForSave(newStepMode, newJsonText, newWorkflowSteps);
    if ("error" in serializedSteps) { setCreateError(serializedSteps.error); return; }
    const parsedSteps = serializedSteps.steps;
    const invalidStep = parsedSteps.find((s) => !(s as Record<string, unknown>).id);
    if (invalidStep) {
      setCreateError("모든 step에 ID가 필요합니다.");
      return;
    }

    setCreateError("");
    setIsCreating(true);
    try {
      const parsedMaxDailyRuns = normalizeMaxDailyRunsInput(newMaxDailyRuns);
      if (parsedMaxDailyRuns.error) {
        setCreateError(parsedMaxDailyRuns.error);
        return;
      }
      const description = newWorkflowDescription.trim();
      const triggerLabels = newTriggerLabels.split(",").map((l) => l.trim()).filter(Boolean);
      const labelIds = newLabelIds.map((l) => l.trim()).filter(Boolean);
      const legacyMetadata = buildWorkflowInterfaceMetadata({}, newFlowInputsText, newFlowEnvVariablesText, newTestInputPresetsText);
      if (legacyMetadata.error) {
        setCreateError(legacyMetadata.error);
        return;
      }
      const workflow = {
        name,
        description,
        status: "active",
        steps: parsedSteps,
        maxDailyRuns: parsedMaxDailyRuns.value,
        timezone: newTimezone.trim() || undefined,
        createParentIssuePolicy: newCreateParentIssuePolicy,
        legacyMetadata: legacyMetadata.value,
        ...(triggerLabels.length > 0 ? { triggerLabels } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(newSchedule.trim() ? { schedule: newSchedule.trim() } : {}),
        ...(newProjectId.trim() ? { projectId: newProjectId.trim() } : {}),
      };
      await createWorkflow({
        companyId,
        workflow,
        ...workflow,
      });
      resetCreateForm();
      await onCreated();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(`생성 실패: ${message}`);
    } finally {
      setIsCreating(false);
    }
  }

  async function onCreateLabelForCreateForm(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) {
      setCreateError("새 레이블 이름을 입력하세요.");
      return;
    }
    if (!companyId.trim()) {
      setCreateError("companyId가 없어 레이블을 생성할 수 없습니다.");
      return;
    }

    setCreateError("");
    setCreatingLabel(true);
    try {
      const created = await createCompanyLabel(companyId, name, newLabelColor);
      const nextLabels = await onLabelsRefresh();
      const createdId = nextLabels.find((label) => label.id === created.id)?.id ?? created.id;
      setNewLabelIds((prev) => (prev.includes(createdId) ? prev : [...prev, createdId]));
      setNewLabelName("");
      setNewLabelColor("#6366f1");
      setShowNewLabelForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(`레이블 생성 실패: ${message}`);
    } finally {
      setCreatingLabel(false);
    }
  }

  void showNewLabelForm;
  void creatingLabel;
  void onCreateLabelForCreateForm;

  return (
    <form key="new-workflow-form" className={SHELL_CLASS} onSubmit={(event) => void onCreateWorkflow(event)}>
      <div key="create-header" className={HEADER_CLASS}>
        <div key="identity" className={IDENTITY_CLASS}>
          <div key="name-field" className={FIELD_CLASS}>
            <FieldLabel help="Name shown in lists, editor headers, and run history.">Workflow name</FieldLabel>
            <input
              key="input"
              className={INPUT_CLASS}
              value={newWorkflowName}
              onChange={(event) => setNewWorkflowName(event.target.value)}
              placeholder="Daily market signal digest"
              required
            />
          </div>
          <div key="description-field" className={FIELD_CLASS}>
            <FieldLabel help="Short summary of what this workflow is intended to automate.">Description</FieldLabel>
            <textarea
              key="textarea"
              className={TEXTAREA_CLASS}
              value={newWorkflowDescription}
              onChange={(event) => setNewWorkflowDescription(event.target.value)}
              rows={2}
              placeholder="What this workflow does"
            />
          </div>
        </div>
        <div key="create-actions" className={ACTIONS_CLASS}>
          <GraphModeTabs key="mode-tabs" mode={newStepMode} onChange={setNewStepMode} />
          <button
            type="submit"
            className={PRIMARY_BUTTON_CLASS}
            disabled={isCreating}
          >
            <Save className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Save
          </button>
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            disabled={isCreating}
            onClick={resetCreateForm}
          >
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Cancel
          </button>
          <HelpIcon label="Save creates the workflow. Cancel clears this draft. Mode tabs choose graph, form, or raw JSON step editing." />
        </div>
      </div>

      <div key="create-setup-strip" className={SETUP_STRIP_CLASS}>
        <div key="schedule-field" className={FIELD_CLASS}>
          <FieldLabel help="Cron expression for automatic scheduled runs. Leave blank if this workflow is only manual or label-triggered.">Schedule (cron)</FieldLabel>
          <input
            key="input"
            className={`${INPUT_CLASS} font-mono tabular-nums`}
            value={newSchedule}
            onChange={(e) => setNewSchedule(e.target.value)}
            placeholder="0 9 * * *"
          />
        </div>
        <div key="timezone-field" className={FIELD_CLASS}>
          <FieldLabel help="Timezone used to interpret the cron schedule.">Timezone</FieldLabel>
          <input
            key="input"
            className={INPUT_CLASS}
            value={newTimezone}
            onChange={(e) => setNewTimezone(e.target.value)}
            placeholder="Asia/Seoul"
          />
        </div>
        <div key="project-field" className={FIELD_CLASS}>
          <FieldLabel help="Optional project to attach generated issues and runs to.">Project</FieldLabel>
          <select
            key="select"
            className={SELECT_CLASS}
            value={newProjectId}
            onChange={(e) => setNewProjectId(e.target.value)}
          >
            {[
              <option key="none" value="">— none —</option>,
              ...(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>),
            ]}
          </select>
        </div>
        <div key="max-daily-runs-field" className={FIELD_CLASS}>
          <FieldLabel help="Daily execution cap for this workflow. Blank uses the server default.">Max Daily Runs</FieldLabel>
          <input
            key="input"
            className={`${INPUT_CLASS} tabular-nums`}
            type="number"
            min={0}
            step={1}
            value={newMaxDailyRuns}
            onChange={(e) => setNewMaxDailyRuns(e.target.value)}
            placeholder="blank=1/day"
          />
        </div>
        <div key="trigger-labels-field" className={FIELD_CLASS}>
          <FieldLabel help="Comma-separated issue labels that should trigger this workflow.">Trigger labels</FieldLabel>
          <input
            key="input"
            className={INPUT_CLASS}
            value={newTriggerLabels}
            onChange={(event) => setNewTriggerLabels(event.target.value)}
            placeholder="daily-tech-research"
          />
        </div>
      </div>

      {!toolSystem.available ? (
        <p
          key="tool-system-unavailable"
          className="mx-3 mt-2.5 flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50/75 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Workflow tools inactive: {toolSystem.reason ?? "no workflow tools are available."}</span>
        </p>
      ) : (
        <Fragment key="tool-system-available-placeholder" />
      )}

      <div key="create-workspace" className="grid min-h-0 p-3">
        <StepWorkspaceEditor
          renderGraphEditor={renderGraphEditor}
          key="steps-editor"
          steps={newWorkflowSteps}
          onChange={setNewWorkflowSteps}
          mode={newStepMode}
          onModeChange={setNewStepMode}
          jsonText={newJsonText}
          onJsonTextChange={setNewJsonText}
          onJsonError={setCreateError}
          triggerSummary={summarizeWorkflowGraphTriggers({
            schedule: newSchedule,
            timezone: newTimezone,
            triggerLabels: newTriggerLabels,
          })}
          testInterfaceInput={{
            graphFlowInputs: newFlowInputsText,
            graphFlowEnvVariables: newFlowEnvVariablesText,
            graphTestInputPresets: newTestInputPresetsText,
          }}
          availableTools={availableTools}
          availableToolGrants={availableToolGrants}
          surface={newStepMode === "graph" ? "focus" : "stacked"}
        />
      </div>

      {createError ? (
        <p
          key="create-error"
          role="alert"
          className="mx-3 mb-3 flex items-center gap-2 rounded-lg border border-rose-200/90 bg-rose-50/85 px-3 py-2 text-xs font-medium text-rose-700 dark:border-rose-500/25 dark:bg-rose-950/35 dark:text-rose-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{createError}</span>
        </p>
      ) : (
        <Fragment key="create-error-placeholder" />
      )}
    </form>
  );
}
