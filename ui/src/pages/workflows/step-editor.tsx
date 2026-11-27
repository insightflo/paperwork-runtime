import { useEffect, useState, type JSX } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Hourglass,
  Plus,
  Trash2,
  Workflow,
  Wrench,
} from "lucide-react";
import { useCompany } from "../../context/CompanyContext";
import { emptyStep, type StepDraft } from "./step-draft.js";
import { apiBaseUrl } from "./workflow-page-api.js";
import { StepSecondaryField } from "./workflow-target-picker.js";
import type { WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";
import { FieldLabel, HelpIcon } from "./shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "./workflow-tool-picker.js";
import { GraphInspectorControlNode } from "./graph-editor/GraphInspectorControlNode.js";
import { cloneWorkflowConditionGroup, defaultIfConditionGroup } from "./workflow-control-nodes.js";

const STEP_TYPE_META: Record<
  StepDraft["type"],
  { label: string; icon: typeof Bot; badgeClass: string }
> = {
  agent: {
    label: "Agent",
    icon: Bot,
    badgeClass:
      "border-blue-200/80 bg-blue-50/80 text-blue-700 dark:border-[#60a5fa]/25 dark:bg-[#60a5fa]/10 dark:text-[#93c5fd]",
  },
  tool: {
    label: "Tool",
    icon: Wrench,
    badgeClass:
      "border-amber-200/80 bg-amber-50/80 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300",
  },
  workflow: {
    label: "Workflow",
    icon: Workflow,
    badgeClass:
      "border-violet-200/80 bg-violet-50/80 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-300",
  },
  if: {
    label: "IF",
    icon: GitBranch,
    badgeClass:
      "border-cyan-200/80 bg-cyan-50/80 text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-400/10 dark:text-cyan-300",
  },
  complete: {
    label: "Complete",
    icon: CheckCircle2,
    badgeClass:
      "border-emerald-200/80 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300",
  },
  human_wait: {
    label: "Human Wait",
    icon: Hourglass,
    badgeClass:
      "border-orange-200/80 bg-orange-50/80 text-orange-700 dark:border-orange-400/25 dark:bg-orange-400/10 dark:text-orange-300",
  },
};

const STEP_CARD_CLASS =
  "tactile-card grid gap-3 rounded-[12px] border border-slate-200/90 bg-white p-3.5 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-colors dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_8px_24px_-8px_rgba(0,0,0,0.55)]";

const COLLAPSED_HEADER_CLASS =
  "tactile-card tactile-card-interactive flex cursor-pointer select-none items-center gap-2.5 rounded-[12px] border border-slate-200/90 bg-white px-3 py-2.5 text-[13px] text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] hover:border-slate-300 dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_6px_18px_-8px_rgba(0,0,0,0.5)] dark:hover:border-white/[0.15]";

const SELECTED_RING_CLASS =
  "ring-2 ring-blue-500/35 border-blue-400/70 dark:ring-[#60a5fa]/40 dark:border-[#60a5fa]/50";

const SUBPANEL_CLASS =
  "grid gap-2 rounded-[10px] border border-slate-200/75 bg-slate-50/75 p-3 dark:border-white/[0.06] dark:bg-[#090c12]/65";

const STEP_ROW_CLASS = "grid grid-cols-1 gap-2.5 sm:grid-cols-2";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200/90 bg-white px-2.5 py-2 text-[13px] text-slate-950 placeholder:text-slate-400 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] transition-colors focus:border-blue-500/70 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#edf2fb] dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa]/60 dark:focus:ring-[#60a5fa]/20";

const SELECT_CLASS = `${INPUT_CLASS} pr-7`;

const TEXTAREA_CLASS = `${INPUT_CLASS} resize-y`;

const ACTION_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-xs transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-slate-200 dark:hover:border-white/[0.16] dark:hover:bg-white/[0.06] dark:focus-visible:ring-[#60a5fa]/35";

const COMPACT_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-slate-200 dark:hover:border-white/[0.16] dark:hover:bg-white/[0.08] dark:focus-visible:ring-[#60a5fa]/35";

const COMPACT_ICON_BUTTON_CLASS =
  "inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200/90 bg-white text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-slate-400 dark:hover:border-white/[0.16] dark:hover:bg-white/[0.08] dark:hover:text-slate-100 dark:focus-visible:ring-[#60a5fa]/35";

const DANGER_COMPACT_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1 rounded-md border border-rose-200/80 bg-rose-50/75 px-2 py-1 text-[11px] font-medium text-rose-700 transition-colors hover:border-rose-300 hover:bg-rose-100/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/35 dark:border-rose-500/25 dark:bg-rose-950/35 dark:text-rose-300 dark:hover:border-rose-400/40 dark:hover:bg-rose-950/55";

const CHECKBOX_LABEL_CLASS =
  "inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400";

const CHECKBOX_CLASS =
  "h-3.5 w-3.5 rounded border-slate-300 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/20 dark:accent-[#60a5fa]";

function StepTypeBadge({ type }: { type: StepDraft["type"] }): JSX.Element {
  const meta = STEP_TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-tight ${meta.badgeClass}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

export function StepEditor({
  steps,
  onChange,
  availableTools,
  availableToolGrants,
  editingWorkflowId,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  /** 편집 중 워크플로 id — 하위 워크플로 선택기에서 자기 자신(self-cycle)을 제외한다. */
  editingWorkflowId?: string;
}): JSX.Element {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!companyId.trim()) return;
    let cancelled = false;
    fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(companyId)}/agents`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (cancelled || !Array.isArray(data)) return;
        setAgents(
          data
            .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
            .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? a.id ?? "") })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);
  const [collapsedSet, setCollapsedSet] = useState<Set<number>>(() => new Set(steps.map((_, i) => i)));
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  function toggleCollapse(index: number) {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function update(index: number, patch: Partial<StepDraft>) {
    const next = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  }

  function moveStep(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    onChange(next);
    setCollapsedSet((prev) => {
      const updated = new Set<number>();
      for (const idx of prev) {
        if (idx === index) updated.add(targetIndex);
        else if (idx === targetIndex) updated.add(index);
        else updated.add(idx);
      }
      return updated;
    });
    if (selectedIndex === index) setSelectedIndex(targetIndex);
    else if (selectedIndex === targetIndex) setSelectedIndex(index);
  }

  function remove(index: number) {
    onChange(steps.filter((_, i) => i !== index));
    setCollapsedSet((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      }
      return next;
    });
    if (selectedIndex === index) setSelectedIndex(null);
    else if (selectedIndex !== null && selectedIndex > index) setSelectedIndex(selectedIndex - 1);
  }

  function add() {
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < steps.length) {
      const afterStep = steps[selectedIndex];
      const newStep = { ...emptyStep(), dependsOn: afterStep.id.trim() };
      const insertAt = selectedIndex + 1;
      const next = [...steps.slice(0, insertAt), newStep, ...steps.slice(insertAt)];
      onChange(next);
      setCollapsedSet((prev) => {
        const shifted = new Set<number>();
        for (const idx of prev) {
          if (idx < insertAt) shifted.add(idx);
          else shifted.add(idx + 1);
        }
        return shifted;
      });
      setSelectedIndex(insertAt);
    } else {
      onChange([...steps, emptyStep()]);
      setSelectedIndex(steps.length);
    }
  }

  const allIds = steps.map((s) => s.id).filter(Boolean);
  const canReorder = steps.length > 1;

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tabular-nums text-slate-600 dark:text-slate-400">
          Steps ({steps.length})
        </span>
        <div className="flex items-center gap-1.5">
          {selectedIndex !== null && (
            <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
              insert after step {selectedIndex + 1}
            </span>
          )}
          <button type="button" className={ACTION_BUTTON_CLASS} onClick={add}>
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            + Add Step
          </button>
          <HelpIcon label="Adds a new workflow step. When a step is selected, the new step is inserted after it and depends on that selected step." />
        </div>
      </div>
      {steps.map((step, i) => {
        const isCollapsed = collapsedSet.has(i);
        const isSelected = selectedIndex === i;

        if (isCollapsed) {
          return (
            <div
              key={i}
              className={`${COLLAPSED_HEADER_CLASS} ${isSelected ? SELECTED_RING_CLASS : ""}`}
              onClick={() => {
                setSelectedIndex(isSelected ? null : i);
              }}
              onDoubleClick={() => toggleCollapse(i)}
            >
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
              <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-md bg-slate-100 px-1 text-[11px] font-semibold tabular-nums text-slate-600 dark:bg-white/[0.06] dark:text-slate-400">
                {i + 1}
              </span>
              <StepTypeBadge type={step.type} />
              <span className="truncate font-mono text-[13px] font-semibold text-slate-900 dark:text-[#edf2fb]">
                {step.id || "(no id)"}
              </span>
              {step.title && (
                <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                  — {step.title}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {canReorder && (
                  <>
                    <button
                      type="button"
                      className={COMPACT_ICON_BUTTON_CLASS}
                      aria-label="Move step up"
                      title="Move step up"
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveStep(i, -1);
                      }}
                    >
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={COMPACT_ICON_BUTTON_CLASS}
                      aria-label="Move step down"
                      title="Move step down"
                      disabled={i === steps.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveStep(i, 1);
                      }}
                    >
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={COMPACT_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(i);
                  }}
                >
                  Expand
                </button>
                <button
                  type="button"
                  className={DANGER_COMPACT_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(i);
                  }}
                >
                  <Trash2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Remove
                </button>
              </span>
            </div>
          );
        }

        return (
          <div
            key={i}
            className={`${STEP_CARD_CLASS} ${isSelected ? SELECTED_RING_CLASS : ""}`}
            onClick={() => setSelectedIndex(isSelected ? null : i)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/75 pb-2.5 dark:border-white/[0.06]">
              <div className="flex items-center gap-2">
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="text-xs font-semibold tabular-nums text-slate-600 dark:text-slate-400">
                  Step {i + 1}
                </span>
                <StepTypeBadge type={step.type} />
              </div>
              <div className="flex items-center gap-1">
                {canReorder && (
                  <>
                    <button
                      type="button"
                      className={COMPACT_ICON_BUTTON_CLASS}
                      aria-label="Move step up"
                      title="Move step up"
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveStep(i, -1);
                      }}
                    >
                      <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={COMPACT_ICON_BUTTON_CLASS}
                      aria-label="Move step down"
                      title="Move step down"
                      disabled={i === steps.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveStep(i, 1);
                      }}
                    >
                      <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={COMPACT_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(i);
                  }}
                >
                  Collapse
                </button>
                <button
                  type="button"
                  className={DANGER_COMPACT_BUTTON_CLASS}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(i);
                  }}
                >
                  <Trash2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                  Remove
                </button>
              </div>
            </div>
            <div className={STEP_ROW_CLASS} onClick={(e) => e.stopPropagation()}>
              <div className="grid gap-1">
                <FieldLabel help="Stable step id used by dependencies and runtime step runs. Keep it unique in this workflow.">ID</FieldLabel>
                <input
                  className={`${INPUT_CLASS} font-mono`}
                  value={step.id}
                  placeholder="gather"
                  onChange={(e) => update(i, { id: e.target.value })}
                />
              </div>
              <div className="grid gap-1">
                <FieldLabel help="Human-readable step title shown in issues, graph nodes, and run history.">Title</FieldLabel>
                <input
                  className={INPUT_CLASS}
                  value={step.title}
                  placeholder="데이터 수집"
                  onChange={(e) => update(i, { title: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1" onClick={(e) => e.stopPropagation()}>
              <FieldLabel help="Instruction text passed to the selected agent or used to describe the tool step.">Description (에이전트에게 전달할 작업 지시)</FieldLabel>
              <textarea
                className={`${TEXTAREA_CLASS} min-h-[120px]`}
                value={step.description}
                placeholder="수집된 데이터를 분석하여 보고서를 작성하세요."
                onChange={(e) => update(i, { description: e.target.value })}
                rows={2}
              />
            </div>
            <div className={STEP_ROW_CLASS} onClick={(e) => e.stopPropagation()}>
              <div className="grid gap-1">
                <FieldLabel help="Agent and Tool perform work. IF evaluates registered JSON output. Complete ends its selected branch successfully. Human Wait pauses the branch until a human records a decision.">Type</FieldLabel>
                <select
                  className={SELECT_CLASS}
                  value={step.type}
                  onChange={(e) => {
                    const newType = e.target.value as StepDraft["type"];
                    if (newType === "tool" && availableTools.length === 0) return;
                    if (newType === "agent" && step.agentName) {
                      const granted = new Set(availableToolGrants.filter((g) => g.agentName === step.agentName).map((g) => g.toolName));
                      const cleaned = splitCommaList(step.tools).filter((t) => granted.has(t)).join(", ");
                      update(i, { type: newType, tools: cleaned });
                    } else if (newType === "if" && !step.conditionGroup) {
                      // IF 로 전환할 때 조건 그룹이 없으면 기본값을 주입한다 — 없으면 검사기가 group.combinator 에서 크래시한다.
                      update(i, { type: newType, conditionGroup: cloneWorkflowConditionGroup(defaultIfConditionGroup) });
                    } else {
                      update(i, { type: newType });
                    }
                  }}
                >
                  <option value="tool" disabled={availableTools.length === 0}>Tool (시스템 실행)</option>
                  <option value="agent">Agent (에이전트 작업)</option>
                  <option value="workflow">Workflow (하위 워크플로 호출)</option>
                  <option value="if">IF (조건 분기)</option>
                  <option value="complete">Complete (성공 종료)</option>
                  <option value="human_wait">Human Wait (사람 승인 대기)</option>
                </select>
                {availableTools.length === 0 ? (
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Tool steps are inactive until workflow tools are available.
                  </span>
                ) : null}
              </div>
              <div className="grid gap-1">
                <StepSecondaryField
                  step={step}
                  agents={agents}
                  availableTools={availableTools}
                  availableToolGrants={availableToolGrants}
                  editingWorkflowId={editingWorkflowId}
                  onPatch={(patch) => update(i, patch)}
                />
              </div>
            </div>
            {(step.type === "if" || step.type === "complete") ? (
              <div className={SUBPANEL_CLASS} onClick={(event) => event.stopPropagation()}>
                <GraphInspectorControlNode
                  steps={steps}
                  selectedStep={step}
                  updateSelected={(patch) => update(i, patch)}
                />
                <p className="m-0 text-[11px] text-slate-500 dark:text-slate-400">
                  IF의 True/False 연결과 Complete 입력 연결은 그래프 편집기에서 설정하세요.
                </p>
              </div>
            ) : null}
            {step.type === "tool" && (
              <div className="grid gap-1" onClick={(e) => e.stopPropagation()}>
                <FieldLabel help="JSON arguments passed to the workflow tool. Invalid JSON blocks saving and shows a parse error.">Tool Args (JSON)</FieldLabel>
                <textarea
                  className={`${TEXTAREA_CLASS} min-h-[96px] font-mono text-xs`}
                  value={step.toolArgs}
                  placeholder={'{\n  "profile": "tech-scout"\n}'}
                  onChange={(e) => update(i, { toolArgs: e.target.value })}
                  rows={4}
                />
              </div>
            )}
            {step.type === "agent" && (
              <div className="grid gap-1" onClick={(e) => e.stopPropagation()}>
                <FieldLabel help="Tool or skill names this agent step may use. The picker only shows tools granted to the selected agent.">Agent tool / skill access</FieldLabel>
                <WorkflowToolPicker
                  value={step.tools}
                  multiple={true}
                  tools={availableTools.filter((t) => availableToolGrants.some((g) => g.agentName === step.agentName && g.toolName === t.name))}
                  onChange={(value) => update(i, { tools: value })}
                />
              </div>
            )}
            <div className={SUBPANEL_CLASS} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-slate-600 dark:text-slate-400">
                  Runtime output contract
                </span>
                <HelpIcon label="Controls runtime behavior for produced artifacts, input/output contracts, resources, and secrets." />
              </div>
              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={step.graphWorkProductRequired}
                  onChange={(e) => update(i, { graphWorkProductRequired: e.target.checked })}
                />
                Require registered work product
                <HelpIcon label="When enabled, the runtime expects this step to register a work product before downstream artifact gates pass." />
              </label>
              <div className={STEP_ROW_CLASS}>
                <div className="grid gap-1">
                  <FieldLabel help="Expected output path or filename pattern for the produced work product.">Work product pattern</FieldLabel>
                  <input
                    className={`${INPUT_CLASS} font-mono`}
                    value={step.graphWorkProductPattern}
                    placeholder="reports/*.html"
                    onChange={(e) => update(i, { graphWorkProductPattern: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <FieldLabel help="Comma-separated runtime resources this step can read, such as files, datasets, or service assets.">Resource refs</FieldLabel>
                  <input
                    className={INPUT_CLASS}
                    value={step.graphResourceRefs}
                    placeholder="kb:market-rules, file:brief"
                    onChange={(e) => update(i, { graphResourceRefs: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <FieldLabel help="Comma-separated secret references made available to the step by the runtime.">Secret refs</FieldLabel>
                  <input
                    className={INPUT_CLASS}
                    value={step.graphSecretRefs}
                    placeholder="secret:telegram-token"
                    onChange={(e) => update(i, { graphSecretRefs: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <FieldLabel help="Optional input transform expression for upstream data handed to this step.">Input expression</FieldLabel>
                  <input
                    className={`${INPUT_CLASS} font-mono`}
                    value={step.graphInputExpression}
                    placeholder="collect.result.summary"
                    onChange={(e) => update(i, { graphInputExpression: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1">
                <FieldLabel help="Optional JSON schema or text contract describing what this step should return.">Output schema</FieldLabel>
                <textarea
                  className={`${TEXTAREA_CLASS} min-h-[58px] font-mono text-xs`}
                  value={step.graphOutputSchema}
                  placeholder={'{ "type": "object", "required": ["artifactPath"] }'}
                  onChange={(e) => update(i, { graphOutputSchema: e.target.value })}
                />
              </div>
            </div>
            <div className={STEP_ROW_CLASS} onClick={(e) => e.stopPropagation()}>
              <div className="grid gap-1">
                <FieldLabel help="Comma-separated upstream step ids. Empty means this can be an entry step.">Depends On / upstream IDs</FieldLabel>
                <input
                  className={`${INPUT_CLASS} font-mono`}
                  value={step.dependsOn}
                  placeholder={allIds.filter((id) => id !== step.id).join(", ") || "none"}
                  onChange={(e) => update(i, { dependsOn: e.target.value })}
                />
              </div>
              {/* [descope v1 D1/D2] workflow 스텝은 항상 자식 실행 완료까지 대기(wait:true 고정)하며
                  재시도 정책 컨트롤을 노출하지 않는다 — fire-and-forget(wait:false) 선택기도 없다. */}
              {step.type !== "workflow" && (
                <>
                  <div className="grid gap-1">
                    <FieldLabel help="Runtime policy when this step fails. Retry uses Max Retries and retry delay/backoff below.">On Failure</FieldLabel>
                    <select
                      className={SELECT_CLASS}
                      value={step.onFailure}
                      onChange={(e) => update(i, { onFailure: e.target.value })}
                    >
                      <option value="">default</option>
                      <option value="retry">retry</option>
                      <option value="skip">skip</option>
                      <option value="abort_workflow">abort workflow</option>
                      <option value="escalate">escalate</option>
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <FieldLabel help="Maximum number of additional retry attempts after the initial attempt when the failure policy is retry.">Max Retries</FieldLabel>
                    <input
                      className={`${INPUT_CLASS} tabular-nums`}
                      type="number"
                      min={0}
                      step={1}
                      disabled={step.onFailure !== "retry"}
                      value={step.maxRetries}
                      placeholder={step.onFailure === "retry" ? "2" : "inactive"}
                      onChange={(e) => update(i, { maxRetries: e.target.value })}
                    />
                  </div>
                </>
              )}
              <div className="grid gap-1">
                <FieldLabel help="Step-level timeout in seconds. Leave blank to use the runtime default.">Timeout Seconds</FieldLabel>
                <input
                  className={`${INPUT_CLASS} tabular-nums`}
                  type="number"
                  min={1}
                  step={1}
                  value={step.timeoutSeconds}
                  placeholder="default"
                  onChange={(e) => update(i, { timeoutSeconds: e.target.value })}
                />
              </div>
              {step.type !== "workflow" && (
                <>
                  <div className="grid gap-1">
                    <FieldLabel help="Optional delay before retrying this step.">Retry delay seconds</FieldLabel>
                    <input
                      className={`${INPUT_CLASS} tabular-nums`}
                      type="number"
                      min={0}
                      step={1}
                      value={step.graphRetryDelaySeconds}
                      disabled={step.onFailure !== "retry"}
                      placeholder={step.onFailure === "retry" ? "blank" : "inactive"}
                      onChange={(e) => update(i, { graphRetryDelaySeconds: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <FieldLabel help="How retry delay grows between attempts.">Retry backoff</FieldLabel>
                    <select
                      className={SELECT_CLASS}
                      value={step.graphRetryBackoff}
                      disabled={step.onFailure !== "retry"}
                      onChange={(e) => update(i, { graphRetryBackoff: e.target.value })}
                    >
                      <option value="">Fixed (default)</option>
                      <option value="fixed">fixed</option>
                      <option value="linear">linear</option>
                      <option value="exponential">exponential</option>
                    </select>
                  </div>
                  <label className={CHECKBOX_LABEL_CLASS}>
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASS}
                      checked={step.graphRetryJitter}
                      disabled={step.onFailure !== "retry"}
                      onChange={(e) => update(i, { graphRetryJitter: e.target.checked })}
                    />
                    Add retry jitter
                    <HelpIcon label="Adds small random timing variation so multiple retries do not all fire at exactly the same time." />
                  </label>
                </>
              )}
            </div>
            <div className={SUBPANEL_CLASS} onClick={(e) => e.stopPropagation()}>
              <FieldLabel help="Optional expression that stops the workflow early when it evaluates as true. Leave blank for normal downstream execution.">Early Stop Condition</FieldLabel>
              <textarea
                className={`${TEXTAREA_CLASS} min-h-[54px] font-mono text-xs`}
                value={step.graphEarlyStopCondition}
                placeholder="result.done === true"
                onChange={(e) => update(i, { graphEarlyStopCondition: e.target.value })}
              />
              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={step.graphEarlyStopLabelSkipped}
                  onChange={(e) => update(i, { graphEarlyStopLabelSkipped: e.target.checked })}
                />
                Label flow as skipped if stopped
                <HelpIcon label="Marks the stopped path as skipped instead of treating the early stop as a normal success path." />
              </label>
            </div>
          </div>
        );
      })}
      {steps.length === 0 && (
        <p className="tactile-card m-0 rounded-[12px] border border-dashed border-slate-300/90 bg-white px-4 py-8 text-center text-sm text-slate-500 dark:border-white/[0.12] dark:bg-[#0e131d] dark:bg-none dark:text-slate-400">
          No steps yet. Click &quot;+ Add Step&quot; to begin.
        </p>
      )}
    </div>
  );
}
