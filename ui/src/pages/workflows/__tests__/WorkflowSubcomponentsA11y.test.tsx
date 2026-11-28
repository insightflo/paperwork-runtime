/** @vitest-environment jsdom */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowDefinitionEditorShell } from "../workflow-definition-editor-shell.js";
import { WorkflowRestoreDialog } from "../workflow-restore-dialog.js";
import {
  ActiveRunsTable,
  RecentRunsTable,
  formatTriggerSource,
  WorkflowRunDebugStrip,
  WorkflowRunDetailPanel,
  WorkflowRunDrawer,
  workflowRunDrawerActionsStyle,
  workflowRunOverlayBannerStyle,
} from "../workflow-runs.js";
import type { WorkflowSummary } from "../workflow-page-types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// 셸 테스트 범위는 대상 파일 3개다. 범위 밖 자식(마운트 시 fetch 하는 워크훅 패널,
// 자체 폼 컨트롤을 렌더하는 스텝 워크스페이스)이 단언을 오염하지 않게 고정한다.
vi.mock("../workflow-webhook-panel.js", () => ({ WorkflowWebhookPanel: () => null }));
vi.mock("../step-workspace-editor.js", () => ({
  GraphModeTabs: () => null,
  StepWorkspaceEditor: () => null,
}));

let root: Root | undefined;
let container: HTMLDivElement;

async function render(element: ReactElement) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(element));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const noop = (): void => {};

const archivedWorkflow: WorkflowSummary = {
  id: "wf-archived",
  name: "Archived flow",
  description: "Old flow",
  status: "archived",
  steps: [],
};

const shellElement = (
  <WorkflowDefinitionEditorShell
    railCollapsed={false}
    onRailCollapsedChange={noop}
    visibleItems={[]}
    workflows={[]}
    editingWorkflow={{ ...archivedWorkflow, status: "paused", name: "Nightly digest" }}
    editingWorkflowPending={false}
    editStepMode="form"
    onActionModeChange={noop}
    editingName="Nightly digest"
    onEditingNameChange={noop}
    editingDescription=""
    onEditingDescriptionChange={noop}
    editingStatus="paused"
    onEditingStatusChange={noop}
    editingSchedule=""
    onEditingScheduleChange={noop}
    editingTimezone=""
    onEditingTimezoneChange={noop}
    editingProjectId=""
    onEditingProjectIdChange={noop}
    editingMaxDailyRuns=""
    onEditingMaxDailyRunsChange={noop}
    editingTriggerLabels=""
    onEditingTriggerLabelsChange={noop}
    projects={[]}
    inspectedRunId={null}
    inspectedRunSummary={null}
    inspectedRunDetail={{ loading: false, error: null, data: null }}
    runDrawerMode="closed"
    onCloseRunOverlay={noop}
    onViewRunRow={noop}
    editingWorkflowRunDebugSummary={null}
    editingSteps={[]}
    onEditingStepsChange={noop}
    onWorkspaceModeChange={noop}
    editJsonText="[]"
    onEditJsonTextChange={noop}
    onJsonError={noop}
    runOverlaySteps={undefined}
    editingFlowInputsText=""
    editingFlowEnvVariablesText=""
    editingTestInputPresetsText=""
    availableTools={[]}
    availableToolGrants={[]}
    renderGraphEditor={() => <div />}
    onSelectWorkflow={noop}
    onRunWorkflow={noop}
    onSaveEdit={noop}
    onCancelEdit={noop}
    onToggleStatus={noop}
    onDeleteWorkflow={noop}
  />
);

describe("Workflow subcomponent accessibility", () => {
  it("labels every editor shell form control and types every button", async () => {
    await render(shellElement);
    const controls = [...container.querySelectorAll("input, select, textarea")];
    expect(controls).toHaveLength(8);
    const expectedLabels = new Set([
      "Workflow name",
      "Description",
      "Status",
      "Schedule (cron)",
      "Timezone",
      "Project",
      "Max Daily Runs",
      "Trigger Labels",
    ]);
    const actualLabels = new Set<string>();
    for (const control of controls) {
      const label = control.getAttribute("aria-label")?.trim() ?? "";
      expect(label).toBeTruthy();
      actualLabels.add(label);
    }
    expect(actualLabels).toEqual(expectedLabels);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(["button", "submit"]).toContain(button.getAttribute("type"));
      if (!button.textContent?.trim()) {
        expect(button.getAttribute("aria-label")?.trim()).toBeTruthy();
      }
    }
    expect(container.textContent).toContain("Run");
    expect(container.textContent).toContain("보관");
  });

  it("keeps the restore dialog announced with typed, named buttons", async () => {
    await render(
      <WorkflowRestoreDialog workflow={archivedWorkflow} onCancel={noop} onConfirm={noop} />,
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toContain("Restore archived workflow");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Cancel",
      "Restore as reusable",
      "Restore as manual",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("type")).toBe("button");
      expect(button.textContent?.trim()).toBeTruthy();
    }
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("keeps the runs barrel a pure re-export surface", () => {
    for (const exportValue of [WorkflowRunDebugStrip, WorkflowRunDetailPanel, ActiveRunsTable, RecentRunsTable, WorkflowRunDrawer]) {
      expect(typeof exportValue).toBe("function");
    }
    expect(typeof formatTriggerSource).toBe("function");
    expect(formatTriggerSource(undefined)).toBe("unknown");
    expect(formatTriggerSource("schedule")).toBe("cron");
    expect(typeof workflowRunDrawerActionsStyle).toBe("object");
    expect(typeof workflowRunOverlayBannerStyle).toBe("object");
  });
});
