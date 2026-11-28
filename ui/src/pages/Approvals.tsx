import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Lock, ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { CompactPagination, PAGE_SIZE, PAGE_WINDOW_KEY, pageOffset, splitFetchedPage, usePageNumber, useScrollToTopOnPageChange } from "../components/CompactPagination";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import type { Approval, ApprovalStatus } from "@paperclipai/shared";

type StatusFilter = "pending" | "all";

/* ── Cockpit summary strip ──
 * 1-row / 6-cell status telemetry. Cells double as shortcuts to the two route-backed
 * filters (pending queue vs. full history) and use micro status dots like the Work page. */
const STATUS_GROUPS: { status: ApprovalStatus; label: { en: string; ko: string }; dot: string; to: StatusFilter }[] = [
  { status: "pending", label: { en: "Pending", ko: "대기" }, dot: "bg-amber-500 dark:bg-[#f59e0b]", to: "pending" },
  { status: "revision_requested", label: { en: "Revision", ko: "수정 요청" }, dot: "bg-blue-500 dark:bg-primary", to: "pending" },
  { status: "approved", label: { en: "Approved", ko: "승인됨" }, dot: "bg-emerald-700 dark:bg-emerald-300", to: "all" },
  { status: "rejected", label: { en: "Rejected", ko: "거절됨" }, dot: "bg-rose-500 dark:bg-[#f87171]", to: "all" },
  { status: "cancelled", label: { en: "Cancelled", ko: "취소됨" }, dot: "bg-slate-400 dark:bg-[#8b97ad]", to: "all" },
];

const STRIP_CELL_CLASS =
  "flex h-10 min-w-0 items-center justify-center gap-2 px-3 text-[11px] transition-colors text-slate-600 hover:bg-slate-50 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]";
const STRIP_CELL_ACTIVE_CLASS = "bg-slate-100/90 text-slate-950 shadow-[inset_0_-2px_0_var(--color-emerald-700)] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_var(--color-emerald-300)]";
/** Semantic left rail per status so a long queue scans instantly without reading labels. */
const STATUS_RAIL: Record<ApprovalStatus, string> = {
  pending: "border-l-amber-500 dark:border-l-[#f59e0b]",
  revision_requested: "border-l-blue-500 dark:border-l-primary",
  approved: "border-l-emerald-700 dark:border-l-emerald-300",
  rejected: "border-l-rose-500 dark:border-l-[#f87171]",
  cancelled: "border-l-slate-400 dark:border-l-[#8b97ad]",
};
/** Decision evidence (plan / raw payload blocks) renders as monospace, wrapped, on the canvas colour. */
const ROW_EVIDENCE_CLASS =
  "[&_pre]:whitespace-pre-wrap [&_pre]:border [&_pre]:border-slate-200/90 dark:[&_pre]:border-white/[0.08] [&_pre]:bg-slate-100 dark:[&_pre]:bg-[#090c12] [&_pre]:text-slate-600 dark:[&_pre]:text-[#cbd5e1] [&_.whitespace-pre-wrap]:font-mono";
/** Server status filter behind each tab; the Pending tab additionally pins `revision_requested` rows (still actionable). */
const TAB_STATUS: Record<StatusFilter, string | undefined> = { pending: "pending", all: undefined };
const ACTIONABLE_FOLLOWUP_STATUS = "revision_requested";
/** A freshly prefetched next page is not re-requested when the user simply returns to the previous page. */
const NEXT_PAGE_PREFETCH_STALE_MS = 30_000;
const newestFirst = (a: Pick<Approval, "createdAt">, b: Pick<Approval, "createdAt">) =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

export function Approvals() {
  const lang = useCompanyLanguage();
  const { selectedCompanyId, canAdmin = true, currentRole } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);
  const t = (en: string, ko: string) => L(lang, { en, ko });
  // Explicit server-backed paging: page resets to 1 when the tab or company changes.
  const [page, setPage] = usePageNumber(`${selectedCompanyId ?? ""}|${statusFilter}`);
  const listRef = useRef<HTMLDivElement>(null);
  useScrollToTopOnPageChange(page, listRef);
  const rowStatus = TAB_STATUS[statusFilter];

  useEffect(() => {
    setBreadcrumbs([{ label: t("Approvals", "승인") }]);
  }, [setBreadcrumbs, lang]);

  // Unfiltered snapshot feeds the status strip / queue badge (cache-shared with the inbox badge).
  const { data } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const {
    data: pageData,
    isLoading,
    isFetching,
    isPlaceholderData,
    error,
  } = useQuery({
    queryKey: [...queryKeys.approvals.list(selectedCompanyId!, rowStatus), PAGE_WINDOW_KEY, PAGE_SIZE, page] as const,
    queryFn: () => approvalsApi.list(selectedCompanyId!, { status: rowStatus, limit: PAGE_SIZE + 1, offset: pageOffset(page) }),
    enabled: !!selectedCompanyId,
    placeholderData: keepPreviousData,
  });
  const { items: pageRows, hasMore } = useMemo(() => splitFetchedPage(pageData), [pageData]);
  const { data: revisionData } = useQuery({
    queryKey: [...queryKeys.approvals.list(selectedCompanyId!, ACTIONABLE_FOLLOWUP_STATUS), PAGE_WINDOW_KEY] as const,
    queryFn: () => approvalsApi.list(selectedCompanyId!, { status: ACTIONABLE_FOLLOWUP_STATUS, limit: PAGE_SIZE + 1 }),
    enabled: !!selectedCompanyId && statusFilter === "pending",
  });
  const { items: revisionRows } = useMemo(() => splitFetchedPage(revisionData), [revisionData]);

  // Resolving the last row of a trailing page must not strand the user on an empty page.
  useEffect(() => {
    if (pageData && !isPlaceholderData && pageRows.length === 0 && page > 1) setPage(page - 1);
  }, [pageData, isPlaceholderData, pageRows.length, page, setPage]);

  // Prefetch the next page so Prev/Next feels instant.
  useEffect(() => {
    if (!selectedCompanyId || !hasMore || isPlaceholderData) return;
    const next = page + 1;
    void queryClient.prefetchQuery({
      queryKey: [...queryKeys.approvals.list(selectedCompanyId!, rowStatus), PAGE_WINDOW_KEY, PAGE_SIZE, next] as const,
      queryFn: () => approvalsApi.list(selectedCompanyId!, { status: rowStatus, limit: PAGE_SIZE + 1, offset: pageOffset(next) }),
      staleTime: NEXT_PAGE_PREFETCH_STALE_MS,
    });
  }, [queryClient, selectedCompanyId, rowStatus, hasMore, isPlaceholderData, page]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // One prefix covers every tab's page window plus the unfiltered count snapshot.
  const invalidateApprovals = () => queryClient.invalidateQueries({ queryKey: ["approvals", selectedCompanyId!] });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(data!.find(a => a.id === id)!),
    onSuccess: (_approval, id) => {
      setActionError(null);
      invalidateApprovals();
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
      invalidateApprovals();
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : L(lang, { en: "Failed to reject", ko: "거절하지 못했습니다." }));
    },
  });

  const rows = useMemo(() => [...pageRows].sort(newestFirst), [pageRows]);
  const revisionQueue = useMemo(() => (statusFilter === "pending" ? [...revisionRows].sort(newestFirst) : []), [statusFilter, revisionRows]);

  const statusCounts = (data ?? []).reduce<Record<ApprovalStatus, number>>(
    (acc, a) => { acc[a.status as ApprovalStatus] = (acc[a.status as ApprovalStatus] ?? 0) + 1; return acc; },
    { pending: 0, revision_requested: 0, approved: 0, rejected: 0, cancelled: 0 },
  );
  const pendingCount = statusCounts.pending + statusCounts.revision_requested;
  const requestAgent = (approval: Approval) =>
    approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null;
  const renderRow = (approval: Approval) => (
    <div
      key={approval.id}
      title={
        !canAdmin && (approval.status === "pending" || approval.status === "revision_requested")
          ? t(
              "Admin or owner role required to approve, reject, or request revision",
              "승인, 거절 또는 수정 요청은 관리자 이상 권한이 필요합니다.",
            )
          : undefined
      }
      className={cn(
        "border-l-2 bg-white dark:bg-card px-3 py-2 transition-colors hover:bg-slate-50 dark:hover:bg-[#141b29]",
        "[&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0 [&>div]:shadow-none",
        STATUS_RAIL[approval.status as ApprovalStatus] ?? "border-l-slate-400 dark:border-l-[#8b97ad]",
      )}
    >
      <ApprovalCard
        approval={approval}
        requesterAgent={requestAgent(approval)}
        onApprove={() => {
          if (!canAdmin) return;
          approveMutation.mutate(approval.id);
        }}
        onReject={() => {
          if (!canAdmin) return;
          rejectMutation.mutate(approval.id);
        }}
        detailLink={`/approvals/${approval.id}`}
        isPending={!canAdmin || approveMutation.isPending || rejectMutation.isPending}
      />
    </div>
  );

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">{L(lang, { en: "Select a company first.", ko: "먼저 회사를 선택하세요." })}</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: status counts double as route-backed filter shortcuts */}
      <div className="grid w-full grid-cols-2 divide-x divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:divide-white/[0.06] dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)] sm:grid-cols-3 xl:grid-cols-6" role="group" aria-label={L(lang, { en: "Approvals by status", ko: "상태별 승인" })}>
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
              <b className="ml-1 font-semibold text-slate-950 dark:text-[#edf2fb]">{data ? statusCounts[group.status] : "—"}</b>
            </button>
          );
        })}
        <div className={cn(STRIP_CELL_CLASS, "cursor-default")}>
          <span className="truncate uppercase tracking-wide">{L(lang, { en: "Queue", ko: "대기열" })}</span>
          <b className="ml-1 text-amber-600 dark:text-[#f59e0b]">{data ? pendingCount : "—"}</b>
        </div>
      </div>

      {/* Tight 40px toolbar: status tabs + shown count pinned right */}
      <div className="cockpit-toolbar h-auto min-h-10 flex-wrap gap-2 rounded-xl border border-slate-200/90 bg-slate-50/95 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            { value: "pending", label: <>{L(lang, { en: "Pending", ko: "대기 중" })}{pendingCount > 0 && (
              <span className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                "bg-amber-500/15 dark:bg-[#f59e0b]/15 text-amber-600 dark:text-[#f59e0b]"
              )}>
                {pendingCount}
              </span>
            )}</> },
            { value: "all", label: L(lang, { en: "All", ko: "전체" }) },
          ]} />
        </Tabs>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!canAdmin && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#fde68a]"
              title={t(
                "Admin or owner role required to approve, reject, or request revision",
                "승인, 거절 또는 수정 요청은 관리자 이상 권한이 필요합니다.",
              )}
            >
              <Lock className="h-3 w-3 shrink-0" />
              {t(`Read-only${currentRole ? ` (${currentRole})` : ""}`, `읽기 전용${currentRole ? ` (${currentRole})` : ""}`)}
            </span>
          )}
          <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500 dark:text-[#8b97ad]">
            {L(lang, { en: "Shown", ko: "표시" })}
          </span>
          <b className="font-mono text-sm font-semibold leading-none text-slate-900 dark:text-[#edf2fb]">{rows.length + revisionQueue.length}</b>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

      <CompactPagination
        page={page}
        count={rows.length}
        hasMore={hasMore}
        loading={isFetching}
        onPageChange={setPage} className="rounded-xl border-slate-200/90 bg-slate-50/95 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] [&_button]:text-slate-600 dark:[&_button]:text-[#cbd5e1] [&_button:hover]:bg-white dark:[&_button:hover]:bg-[#141b29] [&_span]:text-slate-600 dark:[&_span]:text-[#8b97ad] [&_b]:text-slate-950 dark:[&_b]:text-[#edf2fb] [&_svg]:text-blue-600 dark:[&_svg]:text-primary"
        labels={{
          list: t("Approvals pagination", "승인 목록 페이징"),
          prev: t("Prev", "이전"),
          next: t("Next", "다음"),
          page: t("Page", "페이지"),
          showing: t("Showing", "표시"),
          loading: t("Loading…", "불러오는 중…"),
        }}
      />

      {rows.length === 0 && revisionQueue.length === 0 && !isFetching && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200/90 bg-white py-14 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)] text-center">
          <ShieldCheck className="h-7 w-7 text-emerald-700 dark:text-emerald-300 mb-3" />
          <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
            {statusFilter === "pending" ? L(lang, { en: "No pending approvals.", ko: "대기 중인 승인이 없습니다." }) : L(lang, { en: "No approvals yet.", ko: "아직 승인 요청이 없습니다." })}
          </p>
        </div>
      )}

      {(rows.length > 0 || revisionQueue.length > 0) && (
        <div
          ref={listRef}
          aria-busy={isFetching}
          className={cn(
            "divide-y divide-slate-200/75 dark:divide-white/[0.06] overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-opacity dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]",
            ROW_EVIDENCE_CLASS,
            isFetching && "opacity-70",
          )}
        >
          {revisionQueue.length > 0 && (
            <section aria-label={t("Revision requested", "수정 요청")}>
              <header className="flex items-center gap-2 bg-slate-100 dark:bg-[#090c12] px-3 py-1.5 text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#8b97ad]">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 dark:bg-primary" />
                <span className="truncate">{t("Revision requested", "수정 요청")}</span>
                <b className="ml-1 font-mono text-blue-600 dark:text-primary">
                  {revisionQueue.length}
                  {(revisionData?.length ?? 0) > PAGE_SIZE && "+"}
                </b>
                <span className="ml-auto normal-case tracking-normal">
                  {t("Still actionable · resubmission pending", "여전히 승인/거절 가능 · 재제출 대기")}
                </span>
              </header>
              <div className="divide-y divide-slate-200/75 dark:divide-white/[0.06]">{revisionQueue.map(renderRow)}</div>
            </section>
          )}
          {rows.length > 0 && <div className="divide-y divide-slate-200/75 dark:divide-white/[0.06]">{rows.map(renderRow)}</div>}
        </div>
      )}
    </div>
  );
}
