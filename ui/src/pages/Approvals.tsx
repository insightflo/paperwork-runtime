import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import type { ApprovalStatus } from "@paperclipai/shared";

type StatusFilter = "pending" | "all";

/* ── Cockpit summary strip ──
 * 1-row / 6-cell status telemetry. Cells double as shortcuts to the two route-backed
 * filters (pending queue vs. full history) and use micro status dots like the Work page. */
const STATUS_GROUPS: { status: ApprovalStatus; label: { en: string; ko: string }; dot: string; to: StatusFilter }[] = [
  { status: "pending", label: { en: "Pending", ko: "대기" }, dot: "bg-[#fbbf24]", to: "pending" },
  { status: "revision_requested", label: { en: "Revision", ko: "수정 요청" }, dot: "bg-[#5f8dff]", to: "pending" },
  { status: "approved", label: { en: "Approved", ko: "승인됨" }, dot: "bg-[#34d399]", to: "all" },
  { status: "rejected", label: { en: "Rejected", ko: "거절됨" }, dot: "bg-[#f87171]", to: "all" },
  { status: "cancelled", label: { en: "Cancelled", ko: "취소됨" }, dot: "bg-[#8b97ad]", to: "all" },
];

const STRIP_CELL_CLASS =
  "cockpit-cell min-w-0 flex-1 justify-center transition-colors hover:bg-[#151b28] hover:text-[#e6edf7]";
const STRIP_CELL_ACTIVE_CLASS = "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]";
/** Semantic left rail per status so a long queue scans instantly without reading labels. */
const STATUS_RAIL: Record<ApprovalStatus, string> = {
  pending: "border-l-[#fbbf24]",
  revision_requested: "border-l-[#5f8dff]",
  approved: "border-l-[#34d399]",
  rejected: "border-l-[#f87171]",
  cancelled: "border-l-[#8b97ad]",
};
/** Decision evidence (plan / raw payload blocks) renders as monospace, wrapped, on the canvas colour. */
const ROW_EVIDENCE_CLASS =
  "[&_pre]:whitespace-pre-wrap [&_pre]:border [&_pre]:border-[#242d3f] [&_pre]:bg-[#0b0e14] [&_pre]:text-[#b6c2d6] [&_.whitespace-pre-wrap]:font-mono";

export function Approvals() {
  const lang = useCompanyLanguage();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: L(lang, { en: "Approvals", ko: "승인" }) }]);
  }, [setBreadcrumbs, lang]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(data!.find(a => a.id === id)!),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : L(lang, { en: "Failed to approve", ko: "승인하지 못했습니다." }));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(data!.find(a => a.id === id)!),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : L(lang, { en: "Failed to reject", ko: "거절하지 못했습니다." }));
    },
  });

  const statusCounts = (data ?? []).reduce<Record<ApprovalStatus, number>>(
    (acc, a) => { acc[a.status as ApprovalStatus] = (acc[a.status as ApprovalStatus] ?? 0) + 1; return acc; },
    { pending: 0, revision_requested: 0, approved: 0, rejected: 0, cancelled: 0 },
  );
  const pendingCount = statusCounts.pending + statusCounts.revision_requested;

  const filtered = (data ?? [])
    .filter(
      (a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested",
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">{L(lang, { en: "Select a company first.", ko: "먼저 회사를 선택하세요." })}</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: status counts double as route-backed filter shortcuts */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label={L(lang, { en: "Approvals by status", ko: "상태별 승인" })}>
        {STATUS_GROUPS.map((group) => {
          const active = group.to === statusFilter;
          return (
            <button
              key={group.status}
              type="button"
              aria-pressed={active}
              disabled={isLoading}
              title={L(lang, { en: `Show ${group.label.en.toLowerCase()} approvals`, ko: `${group.label.ko} 승인 보기` })}
              onClick={() => navigate(`/approvals/${group.to}`)}
              className={cn(STRIP_CELL_CLASS, active && STRIP_CELL_ACTIVE_CLASS)}
            >
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${group.dot}`} />
              <span className="truncate uppercase tracking-wide">{L(lang, group.label)}</span>
              <b className="ml-1">{data ? statusCounts[group.status] : "—"}</b>
            </button>
          );
        })}
        <div className="cockpit-cell min-w-0 shrink-0">
          <span className="truncate uppercase tracking-wide">{L(lang, { en: "Queue", ko: "대기열" })}</span>
          <b className="ml-1 text-[#fbbf24]">{data ? pendingCount : "—"}</b>
        </div>
      </div>

      {/* Tight 40px toolbar: status tabs + shown count pinned right */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            { value: "pending", label: <>{L(lang, { en: "Pending", ko: "대기 중" })}{pendingCount > 0 && (
              <span className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                "bg-[#fbbf24]/15 text-[#fbbf24]"
              )}>
                {pendingCount}
              </span>
            )}</> },
            { value: "all", label: L(lang, { en: "All", ko: "전체" }) },
          ]} />
        </Tabs>
        <div className="ml-auto flex shrink-0 items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-[0.16em] text-[#8b97ad]">
            {L(lang, { en: "Shown", ko: "표시" })}
          </span>
          <b className="font-mono text-sm font-semibold leading-none text-[#e6edf7]">{filtered.length}</b>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-md border border-[#242d3f] bg-[#111622] py-14 text-center">
          <ShieldCheck className="h-7 w-7 text-[#34d399] mb-3" />
          <p className="text-xs text-[#8b97ad]">
            {statusFilter === "pending" ? L(lang, { en: "No pending approvals.", ko: "대기 중인 승인이 없습니다." }) : L(lang, { en: "No approvals yet.", ko: "아직 승인 요청이 없습니다." })}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className={cn(
          "divide-y divide-[#242d3f] overflow-hidden rounded-md border border-[#242d3f] bg-[#111622]",
          ROW_EVIDENCE_CLASS,
        )}>
          {filtered.map((approval) => (
            <div
              key={approval.id}
              className={cn(
                "border-l-2 bg-[#111622] px-3 py-2 transition-colors hover:bg-[#151b28]",
                "[&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none",
                STATUS_RAIL[approval.status as ApprovalStatus] ?? "border-l-[#8b97ad]",
              )}
            >
              <ApprovalCard
                approval={approval}
                requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                onApprove={() => approveMutation.mutate(approval.id)}
                onReject={() => rejectMutation.mutate(approval.id)}
                detailLink={`/approvals/${approval.id}`}
                isPending={approveMutation.isPending || rejectMutation.isPending}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
