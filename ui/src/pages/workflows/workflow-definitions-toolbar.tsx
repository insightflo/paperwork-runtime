import { type JSX, type ReactNode } from "react";
import type { StatusFilter, WorkflowScopeFilter } from "./workflow-page-types.js";
import { cn } from "../../lib/utils";
import { HelpIcon } from "./shared-controls.js";

const SEGMENT_GROUP =
  "flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-white/[0.08] dark:bg-[#090c12]";
const SEGMENT_BASE =
  "h-6 cursor-pointer whitespace-nowrap rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 dark:focus-visible:ring-[#60a5fa]/35";
const SEGMENT_ACTIVE =
  "bg-white font-semibold text-slate-950 shadow-sm dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]";
const SEGMENT_IDLE =
  "text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#eef2f8]";
const INPUT_CLASS =
  "h-7 w-[200px] max-w-[36vw] rounded-md border border-slate-200/90 bg-white px-2 text-xs text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#eef2f8] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";

function ToolbarSegment({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className={cn(SEGMENT_BASE, pressed ? SEGMENT_ACTIVE : SEGMENT_IDLE)}>
      {children}
    </button>
  );
}

export function WorkflowDefinitionsToolbar({
  navigatorSearch,
  onNavigatorSearchChange,
  workflowScopeFilter,
  onWorkflowScopeFilterChange,
  workflowStatusFilter,
  onWorkflowStatusFilterChange,
  reusableCount,
  manualCount,
  activeCount,
  archivedCount,
  definitionsCollapsed,
  onToggleCollapsed,
}: {
  navigatorSearch: string;
  onNavigatorSearchChange: (value: string) => void;
  workflowScopeFilter: WorkflowScopeFilter;
  onWorkflowScopeFilterChange: (scope: WorkflowScopeFilter) => void;
  workflowStatusFilter: StatusFilter;
  onWorkflowStatusFilterChange: (status: StatusFilter) => void;
  reusableCount: number;
  manualCount: number;
  activeCount: number;
  archivedCount: number;
  definitionsCollapsed: boolean;
  onToggleCollapsed: () => void;
}): JSX.Element {
  return (
    <div key="definitions-toolbar" className="cockpit-toolbar h-10 w-full min-w-0 flex-1 gap-2 overflow-hidden border-b-0 tabular-nums">
      <div key="definition-controls" className="flex min-w-0 shrink-0 items-center gap-1.5">
        <label key="navigator-search-field" className="flex min-w-0 items-center gap-1.5">
          <input
            key="navigator-search"
            type="search"
            className={INPUT_CLASS}
            value={navigatorSearch}
            onChange={(event) => onNavigatorSearchChange(event.target.value)}
            placeholder="Search workflows..."
            aria-label="Search workflows"
          />
          <HelpIcon label="Filters the workflow list by name, description, or related metadata." />
        </label>
      </div>
      <div key="scope-filter" className="ml-auto flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden">
        <div role="group" aria-label="Workflow category" className={SEGMENT_GROUP}>
          <ToolbarSegment pressed={workflowScopeFilter === "reusable"} onClick={() => onWorkflowScopeFilterChange("reusable")}>
            Reusable <span className="font-mono tabular-nums">({reusableCount})</span>
          </ToolbarSegment>
          <ToolbarSegment pressed={workflowScopeFilter === "manual_mission"} onClick={() => onWorkflowScopeFilterChange("manual_mission")}>
            Manual <span className="font-mono tabular-nums">({manualCount})</span>
          </ToolbarSegment>
        </div>
        <div role="group" aria-label="Workflow status" className={SEGMENT_GROUP}>
          <ToolbarSegment pressed={workflowStatusFilter === "active"} onClick={() => onWorkflowStatusFilterChange("active")}>
            활성 <span className="font-mono tabular-nums">({activeCount})</span>
          </ToolbarSegment>
          <ToolbarSegment pressed={workflowStatusFilter === "archived"} onClick={() => onWorkflowStatusFilterChange("archived")}>
            보관 <span className="font-mono tabular-nums">({archivedCount})</span>
          </ToolbarSegment>
        </div>
        <button
          key="collapse-toggle"
          type="button"
          aria-label={definitionsCollapsed ? "Expand workflow definitions" : "Collapse workflow definitions"}
          aria-pressed={definitionsCollapsed}
          className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-200/90 bg-white text-xs font-semibold text-slate-600 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/35 hover:border-blue-500/40 hover:text-slate-950 dark:border-white/[0.09] dark:focus-visible:ring-[#60a5fa]/35 dark:bg-[#090c12] dark:text-[#8b97ad] dark:hover:border-[#60a5fa]/40 dark:hover:text-[#eef2f8]"
          onClick={() => onToggleCollapsed()}
        >
          {definitionsCollapsed ? "▼" : "▲"}
        </button>
        <HelpIcon label="Use Reusable/Manual to switch workflow categories, Active/Archived to switch status, and the arrow to collapse this list." />
      </div>
    </div>
  );
}
