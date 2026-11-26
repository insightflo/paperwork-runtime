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

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const HAIRLINE_CARD = "min-w-0 rounded-md border border-[#242d3f] bg-[#151b28]";
const HAIRLINE_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad]";
/** Monospace value block: wraps long paths/refs instead of forcing horizontal scroll. */
const MONO_VALUE = "min-w-0 whitespace-pre-wrap break-all font-mono text-xs text-[#c9d3e4]";
const CTA_PRIMARY = "h-7 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]";

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
    <span className="cockpit-cell min-w-0 flex-1">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="truncate normal-case tracking-normal" title={value}>{value}</b>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className={cn("w-28 shrink-0 truncate", HAIRLINE_LABEL)}>{label}</div>
      <div className="min-w-0 flex-1 text-sm text-[#e6edf7]">{children}</div>
    </div>
  );
}

function statusDot(status: string) {
  const value = status.toLowerCase();
  if (value.includes("clos") || value.includes("archiv") || value.includes("cleanup")) return "bg-[#8b97ad]";
  if (value.includes("active") || value.includes("open") || value.includes("run")) return "bg-[#34d399]";
  return "bg-[#fbbf24]";
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

  if (isLoading) return <p className="font-mono text-xs text-[#8b97ad]">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load execution context"}</p>;
  if (!workspace) return null;

  const repoLink = workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? workspace.repoUrl : null;
  const cleanup = workspace.cleanupEligibleAt
    ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
    : "Not scheduled";

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: runtime facts at a glance */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Execution context summary">
        <StripFact label="Status" value={workspace.status} dot={statusDot(workspace.status)} />
        <StripFact label="Mode" value={workspace.mode} />
        <StripFact label="Provider" value={workspace.providerType} />
        <StripFact label="Branch" value={workspace.branchName ?? "—"} />
        <StripFact label="Base ref" value={workspace.baseRef ?? "—"} />
        <StripFact label="Last used" value={formatDateTime(workspace.lastUsedAt)} />
      </div>

      {/* Tight single-row 40px toolbar: name · scope · primary action. */}
      <div className="cockpit-toolbar h-10 w-full rounded-md border border-[#242d3f] bg-[#111622] pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h1 className="min-w-0 truncate text-sm font-semibold text-[#e6edf7]">{workspace.name}</h1>
          <span className="hidden shrink-0 text-[11px] uppercase tracking-wider text-[#8b97ad] sm:inline">Execution context</span>
        </div>
        {repoLink && (
          <a
            href={repoLink}
            target="_blank"
            rel="noreferrer"
            className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium", CTA_PRIMARY)}
          >
            Open repo
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <section aria-label="Execution context details" className={cn("max-w-3xl divide-y divide-[#242d3f]/70", HAIRLINE_CARD)}>
        <div className="px-4">
          <DetailRow label="Work Context">
            {workspace.projectId ? <Link to={`/projects/${workspace.projectId}`} className="font-mono text-xs hover:text-[#5f8dff]">{workspace.projectId}</Link> : "None"}
          </DetailRow>
          <DetailRow label="Source work item">
            {workspace.sourceIssueId ? <Link to={`/issues/${workspace.sourceIssueId}`} className="font-mono text-xs hover:text-[#5f8dff]">{workspace.sourceIssueId}</Link> : "None"}
          </DetailRow>
          <DetailRow label="Branch"><span className={MONO_VALUE}>{workspace.branchName ?? "None"}</span></DetailRow>
          <DetailRow label="Base ref"><span className={MONO_VALUE}>{workspace.baseRef ?? "None"}</span></DetailRow>
          <DetailRow label="Working dir"><span className={MONO_VALUE}>{workspace.cwd ?? "None"}</span></DetailRow>
          <DetailRow label="Provider ref"><span className={MONO_VALUE}>{workspace.providerRef ?? "None"}</span></DetailRow>
          <DetailRow label="Repo URL">
            {repoLink ? (
              <a href={repoLink} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline">
                <span className={MONO_VALUE}>{repoLink}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className={MONO_VALUE}>{workspace.repoUrl ?? "None"}</span>
            )}
          </DetailRow>
          <DetailRow label="Opened">{formatDateTime(workspace.openedAt)}</DetailRow>
          <DetailRow label="Last used">{formatDateTime(workspace.lastUsedAt)}</DetailRow>
          <DetailRow label="Cleanup">
            {workspace.cleanupEligibleAt ? <span className="whitespace-pre-wrap">{cleanup}</span> : "Not scheduled"}
          </DetailRow>
        </div>
      </section>
    </div>
  );
}
