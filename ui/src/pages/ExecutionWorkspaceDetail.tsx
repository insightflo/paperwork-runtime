// ui/src/pages/ExecutionWorkspaceDetail.tsx
//
// [목적] 실행 컨텍스트(워크스페이스) 단건 조회 페이지 — 1행 cockpit strip(상태·모드·프로바이더·브랜치)과
//   40px toolbar(이름 · cobalt Open repo CTA), hairline 상세 카드로 구성한다. 읽기 전용.
// [외부 연결] executionWorkspacesApi.get — GET 조회만.
import { Link, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "@/lib/utils";

// Combo 1 Tactile Telemetry Cockpit surfaces: obsidian #07090d/#0e131d with 1px specular top highlight in dark mode, crisp slate/white in light mode.
const TACTILE_CARD =
  "tactile-card min-w-0 rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-14px_rgba(0,0,0,0.72)]";
const HAIRLINE_LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
/** Monospace value block: wraps long paths/refs instead of forcing horizontal scroll. */
const MONO_VALUE = "min-w-0 whitespace-pre-wrap break-all font-mono text-xs text-slate-800 dark:text-[#c9d3e4]";
const CTA_PRIMARY =
  "h-7 rounded-lg bg-blue-600 px-2.5 text-xs font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-700 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]";

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="cockpit-cell min-w-0 flex-1 border-slate-200/80 text-slate-500 dark:border-white/[0.07] dark:text-[#8b97ad]">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate text-[10.5px] font-semibold uppercase tracking-[0.1em]">{label}</span>
      <b className="truncate font-semibold normal-case tracking-normal text-slate-950 dark:text-[#edf2fb]" title={value}>
        {value}
      </b>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className={cn("w-32 shrink-0 truncate pt-0.5", HAIRLINE_LABEL)}>{label}</div>
      <div className="min-w-0 flex-1 text-sm text-slate-900 dark:text-[#edf2fb]">{children}</div>
    </div>
  );
}

function statusDot(status: string) {
  const value = status.toLowerCase();
  if (value.includes("clos") || value.includes("archiv") || value.includes("cleanup")) {
    return "bg-slate-400 dark:bg-[#8b97ad]";
  }
  if (value.includes("active") || value.includes("open") || value.includes("run")) {
    return "bg-lime-500 shadow-[0_0_8px_rgba(163,230,53,0.75)] dark:bg-[#a3e635]";
  }
  return "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.65)] dark:bg-[#f59e0b]";
}

function formatDateTime(value: Date | string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ExecutionWorkspaceDetail() {
  const { workspaceId } = useParams<{ workspaceId: string }>();

  const { data: workspace, isLoading, error } = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  if (isLoading) {
    return (
      <div aria-live="polite" className={cn(TACTILE_CARD, "inline-flex items-center gap-2 px-4 py-3 font-mono text-xs text-slate-500 dark:text-[#8b97ad]")}>
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-[#60a5fa]" />
        Loading...
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/12 dark:text-rose-300">
        {error instanceof Error ? error.message : "Failed to load execution context"}
      </p>
    );
  }
  if (!workspace) return null;

  const repoLink = workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? workspace.repoUrl : null;
  const cleanup = workspace.cleanupEligibleAt
    ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
    : "Not scheduled";

  return (
    <div className="space-y-3 tabular-nums">
      {/* 1-row 6-cell cockpit strip: runtime facts at a glance */}
      <div
        className={cn(
          "cockpit-strip h-9 w-full gap-0 rounded-xl border border-slate-200/90 bg-white px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_22px_-12px_rgba(0,0,0,0.65)]",
        )}
        role="group"
        aria-label="Execution context summary"
      >
        <StripFact label="Status" value={workspace.status} dot={statusDot(workspace.status)} />
        <StripFact label="Mode" value={workspace.mode} />
        <StripFact label="Provider" value={workspace.providerType} />
        <StripFact label="Branch" value={workspace.branchName ?? "—"} />
        <StripFact label="Base ref" value={workspace.baseRef ?? "—"} />
        <StripFact label="Last used" value={formatDateTime(workspace.lastUsedAt)} />
      </div>

      {/* Tight single-row 40px toolbar: name · scope · primary action. */}
      <div className={cn(TACTILE_CARD, "cockpit-toolbar h-11 w-full justify-between px-3")}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
          <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight text-slate-950 dark:text-[#edf2fb]">
            {workspace.name}
          </h1>
          <span className="hidden shrink-0 rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa] sm:inline-flex">
            Execution context
          </span>
        </div>
        {repoLink && (
          <a
            href={repoLink}
            target="_blank"
            rel="noreferrer"
            className={cn("inline-flex shrink-0 items-center gap-1.5", CTA_PRIMARY)}
          >
            Open repo
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <section aria-label="Execution context details" className={cn(TACTILE_CARD, "max-w-3xl overflow-hidden")}>
        <header className="flex items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-50/80 px-4 py-2.5 dark:border-white/[0.06] dark:bg-[#090d14]/80">
          <span className={HAIRLINE_LABEL}>Telemetry metadata</span>
          <span className="font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">{workspace.id}</span>
        </header>
        <div className="divide-y divide-slate-200/75 px-4 dark:divide-white/[0.06]">
          <DetailRow label="Work Context">
            {workspace.projectId ? (
              <Link
                to={`/projects/${workspace.projectId}`}
                className="font-mono text-xs text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
              >
                {workspace.projectId}
              </Link>
            ) : (
              <span className="text-slate-500 dark:text-[#8b97ad]">None</span>
            )}
          </DetailRow>
          <DetailRow label="Source work item">
            {workspace.sourceIssueId ? (
              <Link
                to={`/issues/${workspace.sourceIssueId}`}
                className="font-mono text-xs text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
              >
                {workspace.sourceIssueId}
              </Link>
            ) : (
              <span className="text-slate-500 dark:text-[#8b97ad]">None</span>
            )}
          </DetailRow>
          <DetailRow label="Branch"><span className={MONO_VALUE}>{workspace.branchName ?? "None"}</span></DetailRow>
          <DetailRow label="Base ref"><span className={MONO_VALUE}>{workspace.baseRef ?? "None"}</span></DetailRow>
          <DetailRow label="Working dir"><span className={MONO_VALUE}>{workspace.cwd ?? "None"}</span></DetailRow>
          <DetailRow label="Provider ref"><span className={MONO_VALUE}>{workspace.providerRef ?? "None"}</span></DetailRow>
          <DetailRow label="Repo URL">
            {repoLink ? (
              <a
                href={repoLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 text-blue-600 transition-colors hover:text-blue-700 hover:underline dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
              >
                <span className="min-w-0 whitespace-pre-wrap break-all font-mono text-xs">{repoLink}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className={MONO_VALUE}>{workspace.repoUrl ?? "None"}</span>
            )}
          </DetailRow>
          <DetailRow label="Opened"><span className="tabular-nums">{formatDateTime(workspace.openedAt)}</span></DetailRow>
          <DetailRow label="Last used"><span className="tabular-nums">{formatDateTime(workspace.lastUsedAt)}</span></DetailRow>
          <DetailRow label="Cleanup">
            {workspace.cleanupEligibleAt ? (
              <span className="inline-flex items-center gap-1.5 whitespace-pre-wrap text-amber-700 dark:text-[#f59e0b]">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-[#f59e0b]" />
                {cleanup}
              </span>
            ) : (
              <span className="text-slate-500 dark:text-[#8b97ad]">Not scheduled</span>
            )}
          </DetailRow>
        </div>
      </section>
    </div>
  );
}
