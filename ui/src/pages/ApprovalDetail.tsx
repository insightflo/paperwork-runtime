import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Identity } from "../components/Identity";
import { approvalLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { ApprovalComments } from "../components/ApprovalComments";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";
import { CheckCircle2, ChevronRight } from "lucide-react";
import { HumanReviewPacket } from "../components/HumanReviewPacket";
import { approvalHumanReview } from "../lib/humanReview";
import { cn } from "@/lib/utils";

// Combo 1 cockpit palette: light slate surfaces, obsidian #0e131d/#090c12 dark surfaces, cobalt/lime/amber signals.
const HAIRLINE_CARD = "tactile-card min-w-0 rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]";
/** Descendant override so ApprovalComments / payload blocks inherit the hairline card + mono log look. */
const HAIRLINE_DESCENDANTS =
  "[&_.border.rounded-lg]:rounded-[12px] [&_.border.rounded-lg]:border-slate-200/90 [&_.border.rounded-lg]:bg-white/95 " +
  "[&_.border.rounded-lg]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] " +
  "dark:[&_.border.rounded-lg]:border-white/[0.08] dark:[&_.border.rounded-lg]:bg-[#0e131d] " +
  "dark:[&_.border.rounded-lg]:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] " +
  "[&_.rounded-md.border.p-3]:border-slate-200/90 dark:[&_.rounded-md.border.p-3]:border-white/[0.08] [&_pre]:whitespace-pre-wrap [&_pre]:font-mono";
const STATUS_PILL: Record<string, string> = {
  pending: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
  approved: "border-lime-600/30 bg-lime-600/10 text-lime-700 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  rejected: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:border-[#f87171]/40 dark:bg-[#f87171]/10 dark:text-[#f87171]",
  revision_requested: "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/40 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]",
};
const STATUS_DOT: Record<string, string> = {
  pending: "bg-amber-500 dark:bg-[#f59e0b]",
  approved: "bg-lime-500 dark:bg-[#a3e635]",
  rejected: "bg-rose-500 dark:bg-[#f87171]",
  revision_requested: "bg-blue-600 dark:bg-[#60a5fa]",
};
const CTA_PRIMARY = "h-7 bg-blue-600 px-2.5 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]";
const CTA_GHOST = "h-7 border-slate-200/90 bg-white px-2.5 text-xs text-slate-700 hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";
const CTA_DANGER = "h-7 border-rose-500/35 bg-rose-500/10 px-2.5 text-xs text-rose-700 hover:bg-rose-500/15 hover:text-rose-800 dark:border-[#f87171]/45 dark:bg-[#f87171]/10 dark:text-[#f87171] dark:hover:bg-[#f87171]/20 dark:hover:text-[#fca5a5]";

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="cockpit-cell min-w-0 flex-1">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="truncate font-mono normal-case tracking-normal" title={value}>{value}</b>
    </span>
  );
}

const formatDateTime = (value: Date | null) => (value ? value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

export function ApprovalDetail() {
  const lang = useCompanyLanguage();
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId, canAdmin = true } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;
  // [RBAC] 승인 결정 계열(approve/reject/수정요청/재제출/에이전트 삭제)은 관리자 이상만 가능 — 목록(Approvals)과 동일 기준.
  const adminRequiredTitle = L(lang, { en: "Admin or owner role required to decide approvals", ko: "승인 결정은 관리자 이상 권한이 필요합니다." });

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!), queryFn: () => approvalsApi.listComments(approvalId!), enabled: !!approvalId,
  });
  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!), queryFn: () => approvalsApi.listIssues(approvalId!), enabled: !!approvalId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""), queryFn: () => agentsApi.list(resolvedCompanyId ?? ""), enabled: !!resolvedCompanyId,
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: L(lang, { en: "Approvals", ko: "승인" }), href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? L(lang, { en: "Approval", ko: "승인 요청" }) },
    ]);
  }, [setBreadcrumbs, approval, approvalId, lang]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId, "pending") });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approval!),
    onSuccess: () => { setError(null); refresh(); navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true }); },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Failed to approve", ko: "승인하지 못했습니다." })),
  });
  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approval!),
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Failed to reject", ko: "거절하지 못했습니다." })),
  });
  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approval!),
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Revision request failed", ko: "수정 요청을 보내지 못했습니다." })),
  });
  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approval!),
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Resubmit failed", ko: "재제출하지 못했습니다." })),
  });
  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => { setCommentBody(""); setError(null); refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Comment failed", ko: "댓글을 게시하지 못했습니다." })),
  });
  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => { setError(null); refresh(); navigate("/approvals"); },
    onError: (err) => setError(err instanceof Error ? err.message : L(lang, { en: "Delete failed", ko: "삭제하지 못했습니다." })),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">{L(lang, { en: "Approval not found.", ko: "승인 요청을 찾을 수 없습니다." })}</p>;

  const payload = approval.payload as Record<string, unknown>;
  const reviewPacket = approvalHumanReview(approval);
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? L(lang, { en: "Review linked work items", ko: "연관 업무 검토" })
              : L(lang, { en: "Review linked work item", ko: "연관 업무 검토" }),
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: L(lang, { en: "Open hired agent", ko: "고용된 에이전트 열기" }),
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: L(lang, { en: "Back to approvals", ko: "승인 목록으로" }),
            to: "/approvals",
          };

  return (
    <div className={cn("mx-auto w-full max-w-[1120px] space-y-3 tabular-nums", HAIRLINE_DESCENDANTS)}>
      {showApprovedBanner && (
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-lime-600/30 bg-lime-600/10 px-4 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] animate-in fade-in zoom-in-95 duration-300 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="flex min-w-0 items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-lime-600 dark:text-[#a3e635]" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-[#edf2fb]">{L(lang, { en: "Approval confirmed", ko: "승인이 확정되었습니다" })}</p>
              <p className="text-xs text-slate-600 dark:text-[#8b97ad]">
                {approval.type === "workflow_replacement" ? L(lang, { en: "Replacement approved. Actual creation and execution require a separate request and rechecking current conditions.", ko: "교체 요청을 승인했습니다. 실제 생성·실행은 별도 요청과 현재 조건 재검사를 거칩니다." }) : L(lang, { en: "Requesting agent was notified to review this approval and linked work items.", ko: "요청한 에이전트에게 승인 결과와 연관 업무를 확인하도록 알렸습니다." })}
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" className={CTA_GHOST} onClick={() => navigate(resolvedCta.to)}>{resolvedCta.label}</Button>
        </div>
      )}
      {/* 1-row 5-cell cockpit strip: status · requester · type · linked work · timeline */}
      <div className="cockpit-strip tactile-card w-full gap-0 border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]" role="group" aria-label="Approval summary">
        <StripFact label={L(lang, { en: "Status", ko: "상태" })} value={humanLabel(lang, "approvalStatus", approval.status).label} dot={STATUS_DOT[approval.status] ?? "bg-slate-400 dark:bg-[#8b97ad]"} />
        <StripFact label={L(lang, { en: "Requested by", ko: "요청" })} value={approval.requestedByAgentId ? agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8) : L(lang, approval.requestedByPluginId ? { en: "Plugin", ko: "플러그인" } : { en: "Board", ko: "보드" })} />
        <StripFact label={L(lang, { en: "Type", ko: "유형" })} value={approval.type} />
        <StripFact label={L(lang, { en: "Linked work", ko: "연관 업무" })} value={String(linkedIssues?.length ?? 0)} />
        <StripFact label={L(lang, { en: "Decided", ko: "결정" })} value={formatDateTime(approval.decidedAt)} />
      </div>

      {/* Tight single-row 40px toolbar: type icon · title · mono id · status pill. */}
      <div className="cockpit-toolbar tactile-card h-10 w-full rounded-[12px] border-slate-200/90 bg-white/95 pl-2 pr-1.5 dark:border-white/[0.08] dark:bg-[#0e131d]">
        <TypeIcon className="h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h2 className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">{approvalLabel(approval.type, approval.payload as Record<string, unknown> | null, lang)}</h2>
          <span className="min-w-0 shrink-0 truncate font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">{approval.id}</span>
        </div>
        <span title={approval.status} className={cn("inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[11px] font-semibold uppercase tracking-[0.18em]", STATUS_PILL[approval.status] ?? "border-slate-200/90 bg-slate-100 text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]")}>
          {humanLabel(lang, "approvalStatus", approval.status).label}
        </span>
      </div>
      <div className={cn(HAIRLINE_CARD, "space-y-3 p-4")}>
        <div className="text-sm space-y-1 [&_section]:rounded-md [&_section.border-border]:border-border/80 [&_section.border-border]:bg-card/60">
          {approval.requestedByAgentId && (
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Requested by", ko: "요청" })}</span>
              <Identity name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)} size="sm" />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <HumanReviewPacket packet={reviewPacket} />
          <button
            type="button"
            className="mt-2 flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-slate-900 dark:text-[#8b97ad] dark:hover:text-[#edf2fb]"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            {L(lang, { en: "See full request", ko: "전체 요청 보기" })}
          </button>
          {showRawPayload && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200/90 bg-slate-50 p-3 font-mono text-xs text-slate-700 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#c9d3e4]">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="whitespace-pre-wrap text-xs text-slate-600 dark:text-[#8b97ad]">{L(lang, { en: "Decision note:", ko: "결정 메모:" })} {approval.decisionNote}</p>
          )}
        </div>
        {error && <p role="alert" className="whitespace-pre-wrap font-mono text-xs text-rose-600 dark:text-[#f87171]">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="border-t border-slate-200/90 pt-3 dark:border-white/[0.08]">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">{L(lang, { en: "Linked Work Items", ko: "연관 업무" })}</p>
            <div className="divide-y divide-slate-200/80 rounded-md border border-slate-200/90 bg-slate-50 dark:divide-white/[0.065] dark:border-white/[0.08] dark:bg-[#090c12]">
              {linkedIssues.map((issue) => (
                <Link key={issue.id} to={`/issues/${issue.identifier ?? issue.id}`} className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-900 transition-colors hover:bg-white dark:text-[#edf2fb] dark:hover:bg-[#141b29]">
                  <span className="shrink-0 font-mono text-slate-500 dark:text-[#8b97ad]">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-[#8b97ad]">
              {L(lang, { en: "Linked work items remain open until the requesting agent follows up and closes them.", ko: "연관 업무는 요청한 에이전트가 후속 작업을 수행하고 종결할 때까지 열린 상태로 유지됩니다." })}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isBudgetApproval && (
            <>
              <Button
                size="sm" className={CTA_PRIMARY} onClick={() => approveMutation.mutate()}
                disabled={!canAdmin || approveMutation.isPending || !reviewPacket || (approval.type === "workflow_replacement" && approval.status !== "pending")}
                title={!canAdmin ? adminRequiredTitle : !reviewPacket ? L(lang, { en: "Review information and source locations are required before approval.", ko: "판단 정보와 원본 위치를 보완해야 승인할 수 있습니다." }) : undefined}
              >
                {L(lang, { en: "Approve", ko: "승인" })}
              </Button>
              <Button variant="outline" size="sm" className={CTA_DANGER} onClick={() => rejectMutation.mutate()} disabled={!canAdmin || rejectMutation.isPending} title={!canAdmin ? adminRequiredTitle : undefined}>
                {L(lang, { en: "Reject", ko: "거절" })}
              </Button>
            </>
          )}
          {isBudgetApproval && approval.status === "pending" && (
            <p className="text-sm text-muted-foreground">
              {L(lang, { en: "Resolve this budget stop from the budget controls on", ko: "예산 정지는 다음 페이지의 예산 설정에서 해결하세요:" })} <Link to="/costs" className="underline underline-offset-2">/costs</Link>.
            </p>
          )}
          {approval.status === "pending" && (
            <Button size="sm" variant="outline" className={CTA_GHOST} onClick={() => revisionMutation.mutate()} disabled={!canAdmin || revisionMutation.isPending} title={!canAdmin ? adminRequiredTitle : undefined}>
              {L(lang, { en: "Request revision", ko: "수정 요청" })}
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button size="sm" variant="outline" className={CTA_GHOST} onClick={() => resubmitMutation.mutate()} disabled={!canAdmin || resubmitMutation.isPending} title={!canAdmin ? adminRequiredTitle : undefined}>
              {L(lang, { en: "Mark resubmitted", ko: "재제출로 표시" })}
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm" variant="outline" className={CTA_DANGER}
              onClick={() => {
                if (!canAdmin) return;
                if (!window.confirm(L(lang, { en: "Delete this disapproved agent? This cannot be undone.", ko: "거절된 에이전트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다." }))) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={!canAdmin || deleteAgentMutation.isPending}
              title={!canAdmin ? adminRequiredTitle : undefined}
            >
              {L(lang, { en: "Delete disapproved agent", ko: "거절된 에이전트 삭제" })}
            </Button>
          )}
        </div>
      </div>

      <ApprovalComments comments={comments ?? []} agentNameById={agentNameById} commentBody={commentBody} setCommentBody={setCommentBody} isPending={addCommentMutation.isPending} onPost={() => addCommentMutation.mutate()} />
    </div>
  );
}
