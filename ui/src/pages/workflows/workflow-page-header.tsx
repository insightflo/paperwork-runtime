import { type JSX } from "react";
import { cn } from "../../lib/utils";
import { HelpIcon } from "./shared-controls.js";

const ACTION_BASE =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-md px-2.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-[#60a5fa]/40";
const PRIMARY_ACTION =
  "bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-500 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]";
const SECONDARY_ACTION =
  "border border-slate-200/90 bg-white text-slate-700 hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";

export function WorkflowPageHeader({
  showHelp,
  onToggleHelp,
  showNewWorkflowForm,
  onNewWorkflow,
  isRefreshing,
  refreshButtonLabel,
  onRefresh,
}: {
  showHelp: boolean;
  onToggleHelp: () => void;
  showNewWorkflowForm: boolean;
  onNewWorkflow: () => void;
  isRefreshing: boolean;
  refreshButtonLabel: string;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div key="workflow-page-header" className="grid shrink-0 gap-1.5 tabular-nums">
      <div className="cockpit-strip tactile-card h-7 w-full gap-0 overflow-hidden rounded-[10px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]" role="group" aria-label="Workflow command summary">
        <span className="cockpit-cell shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#8b97ad]">Workflow ops</span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center text-[11px] text-slate-500 dark:text-[#8b97ad]">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lime-500 shadow-[0_0_7px_rgba(163,230,53,0.65)] dark:bg-[#a3e635]" />
          Definitions · runs · recovery
        </span>
      </div>
      <div id="wf-header" className="cockpit-toolbar tactile-card h-10 w-full rounded-xl border-slate-200/90 bg-white pl-2 pr-1.5 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <h1 key="title" className="truncate text-sm font-semibold tracking-tight text-slate-950 dark:text-[#eef2f8]">Workflows</h1>
          <button
            type="button"
            title={showHelp ? "도움말 닫기" : "도움말"}
            aria-label="Help"
            aria-pressed={showHelp}
            className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-slate-300/90 bg-slate-50 text-[11px] font-bold leading-none text-slate-600 transition-colors hover:border-blue-500/50 hover:text-slate-950 dark:border-white/[0.12] dark:bg-[#090c12] dark:text-[#8b97ad] dark:hover:border-[#60a5fa]/50 dark:hover:text-[#eef2f8]"
            onClick={onToggleHelp}
          >
            ?
          </button>
        </div>
        <div key="header-actions" className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            key="new-workflow"
            type="button"
            className={cn(ACTION_BASE, PRIMARY_ACTION)}
            disabled={showNewWorkflowForm}
            onClick={onNewWorkflow}
          >
            + New Workflow
          </button>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void onRefresh();
            }}
            disabled={isRefreshing}
            className={cn(ACTION_BASE, SECONDARY_ACTION)}
          >
            {refreshButtonLabel}
          </button>
          <HelpIcon label="New Workflow opens the creation form. Refresh reloads workflow definitions and run status from the server." />
        </div>
      </div>
    </div>
  );
}
