import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceOperation } from "@paperclipai/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { cn, relativeTime } from "../lib/utils";
import { parseStoredLogContent } from "./agent-detail-log-content";
import { workspaceOperationPhaseLabel } from "./agent-detail-workspace-display";
import { asRecord, asNonEmptyString, redactPathText } from "./agent-detail-redaction";

const PANEL =
  "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const LOG_SURFACE =
  "rounded-md border border-slate-200/80 bg-white font-mono text-xs text-slate-800 dark:border-white/[0.07] dark:bg-[#07090d] dark:text-[#dbe4f0]";
const LABEL = "text-slate-500 dark:text-[#8b97ad]";
const VALUE = "text-slate-900 dark:text-[#edf2fb]";
const STATUS_TONE: Record<WorkspaceOperation["status"], string> = {
  succeeded: "border-lime-600/25 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  failed: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300",
  running: "border-blue-600/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]",
  skipped: "border-amber-600/25 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
};

function WorkspaceOperationStatusBadge({ status }: { status: WorkspaceOperation["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize tabular-nums",
        STATUS_TONE[status],
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function WorkspaceOperationLogViewer({
  operation,
  censorUsernameInLogs,
}: {
  operation: WorkspaceOperation;
  censorUsernameInLogs: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: logData, isLoading, error } = useQuery({
    queryKey: ["workspace-operation-log", operation.id],
    queryFn: () => heartbeatsApi.workspaceOperationLog(operation.id),
    enabled: open && Boolean(operation.logRef),
    refetchInterval: open && operation.status === "running" ? 2000 : false,
  });

  const chunks = useMemo(
    () => (logData?.content ? parseStoredLogContent(logData.content) : []),
    [logData?.content],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        className="text-[11px] font-medium text-blue-700 underline underline-offset-2 transition-colors hover:text-blue-600 dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide full log" : "Show full log"}
      </button>
      {open && (
        <div className={cn(INSET, "p-2")}>
          {isLoading && <div className={cn("text-xs", LABEL)}>Loading log...</div>}
          {error && (
            <div className="text-xs text-rose-700 dark:text-rose-300">
              {error instanceof Error ? error.message : "Failed to load execution-context operation log"}
            </div>
          )}
          {!isLoading && !error && chunks.length === 0 && (
            <div className={cn("text-xs", LABEL)}>No persisted log lines.</div>
          )}
          {chunks.length > 0 && (
            <div className={cn(LOG_SURFACE, "max-h-64 overflow-y-auto p-2 tabular-nums")}>
              {chunks.map((chunk, index) => (
                <div key={`${chunk.ts}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-slate-400 dark:text-[#627089]">
                    {new Date(chunk.ts).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span
                    className={cn(
                      "w-14 shrink-0",
                      chunk.stream === "stderr"
                        ? "text-rose-600 dark:text-rose-300"
                        : chunk.stream === "system"
                          ? "text-blue-600 dark:text-[#60a5fa]"
                          : LABEL,
                    )}
                  >
                    [{chunk.stream}]
                  </span>
                  <span className="whitespace-pre-wrap break-all">{redactPathText(chunk.chunk, censorUsernameInLogs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceOperationsSection({
  operations,
  censorUsernameInLogs,
}: {
  operations: WorkspaceOperation[];
  censorUsernameInLogs: boolean;
}) {
  if (operations.length === 0) return null;

  return (
    <div className={cn(PANEL, "space-y-3 p-3 tabular-nums")}>
      <div className="flex items-center gap-2 border-b border-slate-200/80 pb-2 dark:border-white/[0.07]">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(96,165,250,0.45)] dark:bg-[#60a5fa]" />
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-[#8b97ad]">
          Execution Context
        </div>
        <span className="ml-auto rounded-full border border-slate-200/90 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]">
          {operations.length}
        </span>
      </div>
      <div className="space-y-3">
        {operations.map((operation) => {
          const metadata = asRecord(operation.metadata);
          return (
            <div key={operation.id} className={cn(INSET, "space-y-2 p-3")}>
              <div className="flex flex-wrap items-center gap-2">
                <div className={cn("text-sm font-medium", VALUE)}>{workspaceOperationPhaseLabel(operation.phase)}</div>
                <WorkspaceOperationStatusBadge status={operation.status} />
                <div className={cn("text-[11px] tabular-nums", LABEL)}>
                  {relativeTime(operation.startedAt)}
                  {operation.finishedAt && ` to ${relativeTime(operation.finishedAt)}`}
                </div>
              </div>
              {operation.command && (
                <div className="break-all text-xs">
                  <span className={LABEL}>Command: </span>
                  <span className={cn("font-mono", VALUE)}>{operation.command}</span>
                </div>
              )}
              {operation.cwd && (
                <div className="break-all text-xs">
                  <span className={LABEL}>Working dir: </span>
                  <span className={cn("font-mono", VALUE)}>{operation.cwd}</span>
                </div>
              )}
              {(asNonEmptyString(metadata?.branchName)
                || asNonEmptyString(metadata?.baseRef)
                || asNonEmptyString(metadata?.worktreePath)
                || asNonEmptyString(metadata?.repoRoot)
                || asNonEmptyString(metadata?.cleanupAction)) && (
                <div className="grid gap-1 text-xs sm:grid-cols-2">
                  {asNonEmptyString(metadata?.branchName) && (
                    <div><span className={LABEL}>Branch: </span><span className={cn("font-mono", VALUE)}>{metadata?.branchName as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.baseRef) && (
                    <div><span className={LABEL}>Base ref: </span><span className={cn("font-mono", VALUE)}>{metadata?.baseRef as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.worktreePath) && (
                    <div className="break-all"><span className={LABEL}>Context path: </span><span className={cn("font-mono", VALUE)}>{metadata?.worktreePath as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.repoRoot) && (
                    <div className="break-all"><span className={LABEL}>Repo root: </span><span className={cn("font-mono", VALUE)}>{metadata?.repoRoot as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.cleanupAction) && (
                    <div><span className={LABEL}>Cleanup: </span><span className={cn("font-mono", VALUE)}>{metadata?.cleanupAction as string}</span></div>
                  )}
                </div>
              )}
              {typeof metadata?.created === "boolean" && (
                <div className={cn("text-xs", LABEL)}>
                  {metadata.created ? "Created by this run" : "Reused existing execution context"}
                </div>
              )}
              {operation.stderrExcerpt && operation.stderrExcerpt.trim() && (
                <div>
                  <div className="mb-1 text-xs font-medium text-rose-700 dark:text-rose-300">stderr excerpt</div>
                  <pre className="rounded-md border border-rose-500/20 bg-rose-50 p-2 text-xs whitespace-pre-wrap break-all text-rose-800 dark:border-rose-400/20 dark:bg-[#07090d] dark:text-rose-100">
                    {redactPathText(operation.stderrExcerpt, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {operation.stdoutExcerpt && operation.stdoutExcerpt.trim() && (
                <div>
                  <div className={cn("mb-1 text-xs font-medium", LABEL)}>stdout excerpt</div>
                  <pre className={cn(LOG_SURFACE, "p-2 whitespace-pre-wrap break-all")}>
                    {redactPathText(operation.stdoutExcerpt, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {operation.logRef && (
                <WorkspaceOperationLogViewer
                  operation={operation}
                  censorUsernameInLogs={censorUsernameInLogs}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
