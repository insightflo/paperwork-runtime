import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  worktreeApi,
  type WorktreeProposal,
  type ProposalStatus,
  type ProposedRuleChange,
} from "../api/worktree";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  GitPullRequest,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Bot,
} from "lucide-react";
import { cn } from "../lib/utils";
import { HumanReviewPacket } from "../components/HumanReviewPacket";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";

const MAX_PROPOSALS_PER_AGENT_PER_DAY = 3;
const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" };

type StatusFilter = ProposalStatus | "all";

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
/** One table drives the strip cells (filter shortcuts) and the per-row status styling. */
const STATUS_TABLE: { value: ProposalStatus; label: string; color: string; icon: React.ElementType }[] = [
  { value: "proposed", label: "Pending", color: "#fbbf24", icon: Clock },
  { value: "approved", label: "Approved", color: "#34d399", icon: CheckCircle2 },
  { value: "rejected", label: "Rejected", color: "#f87171", icon: XCircle },
];

const SEVERITY_COLORS: Record<string, string> = {
  MUST: "bg-[#f87171]/15 text-[#f87171]",
  SHOULD: "bg-[#fbbf24]/15 text-[#fbbf24]",
  MAY: "bg-[#5f8dff]/15 text-[#5f8dff]",
};

/** Fixed column tracks: name (flexes, truncates) | severity | agent | date | status | action (never wrap). */
const ROW_TRACKS =
  "grid grid-cols-[minmax(0,1fr)_max-content_max-content] items-center gap-3 px-3 sm:grid-cols-[minmax(0,1fr)_4rem_max-content_max-content] lg:grid-cols-[minmax(0,1fr)_4rem_10rem_9.5rem_max-content_max-content]";
const STRIP_CELL_ACTIVE = "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]";
const STRIP_CELL_IDLE = "hover:bg-[#151b28] hover:text-[#e6edf7]";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", DATE_FORMAT).format(new Date(date));
}

// ── DiffView — shows proposed change fields ───────────────────────────────────

function DiffView({ change }: { change: ProposedRuleChange }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-[#242d3f] bg-[#151b28] p-3 text-xs">
      <span className="pt-0.5 font-medium text-[#8b97ad]">Name</span>
      <span className="min-w-0 truncate font-medium text-[#e6edf7]">{change.name}</span>
      <span className="pt-0.5 font-medium text-[#8b97ad]">Severity</span>
      <span className={cn("justify-self-start rounded px-1.5 py-0.5 font-mono font-medium text-xs", SEVERITY_COLORS[change.severity] ?? "bg-[#151b28] text-[#8b97ad]")}>
        {change.severity}
      </span>
      <span className="pt-0.5 font-medium text-[#8b97ad]">Action</span>
      <span className="min-w-0 truncate font-mono text-[#e6edf7]">{change.action}</span>
      {change.message && (
        <>
          <span className="pt-0.5 font-medium text-[#8b97ad]">Message</span>
          <span className="whitespace-pre-wrap break-words text-[#8b97ad]">{change.message}</span>
        </>
      )}
      <span className="self-start pt-0.5 font-medium text-[#8b97ad]">Predicate</span>
      <pre className="overflow-x-auto rounded-md border border-[#242d3f] bg-[#0b0e14] p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {JSON.stringify(change.predicate, null, 2)}
      </pre>
    </div>
  );
}

// ── ReviewForm ────────────────────────────────────────────────────────────────

interface ReviewFormProps {
  proposal: WorktreeProposal;
  onDone: () => void;
}

function ReviewForm({ proposal, onDone }: ReviewFormProps) {
  const lang = useCompanyLanguage();
  const queryClient = useQueryClient();
  const [reviewNote, setReviewNote] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);

  // Board actor uses the existing server-accepted reviewer sentinel.
  const REVIEWER_ID = "board";

  const mutation = useMutation({
    mutationFn: (status: "approved" | "rejected") =>
      worktreeApi.reviewProposal(proposal.id, { status, reviewedByAgentId: REVIEWER_ID, reviewNote: reviewNote.trim() || undefined, reviewAcknowledged }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.worktree.proposals(proposal.companyId) }); onDone(); },
    onError: (err) => setReviewError(err instanceof Error ? err.message : "Review failed"),
  });

  return (
    <div className="mt-3 space-y-2 border-t border-[#242d3f] pt-3">
      <HumanReviewPacket packet={{
        schemaVersion: "human-review-v1", decisionSubject: `${proposal.proposedChange.name} 운영 규칙 변경을 적용할까요?`,
        evidence: [{ label: "규칙 변경 제안 원본", href: `/worktree/proposals#proposal-${proposal.id}`, location: `제안 ${proposal.id} > Proposed rule`, description: proposal.rationale }],
        interpretation: `${proposal.proposedChange.action} 작업에 ${proposal.proposedChange.severity} 수준으로 적용될 규칙 변경입니다.`,
        impact: { ifApproved: "제안된 조건과 판단 방식이 회사 운영 규칙에 반영됩니다.", ifRejected: "현재 운영 규칙을 유지합니다.", ifWrong: "정상 업무가 차단되거나 허용하면 안 되는 Agent 행동이 허용될 수 있습니다." },
        unresolvedFacts: [], questions: ["조건식, 결정 결과, 심각도와 기존 규칙과의 충돌을 확인했습니까?"],
        recommendedNextStep: "아래 규칙 원문과 조건식을 확인한 뒤 결정하세요.", requiredReviewer: "회사 운영 정책 권한이 있는 Human Operator",
      }} />
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={reviewAcknowledged} onChange={(event) => setReviewAcknowledged(event.target.checked)} /><span>원본 규칙, 적용 영향과 오판 위험을 확인했습니다.</span></label>
      <textarea
        className="h-16 w-full resize-none rounded-md border border-input bg-[#0b0e14] px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder={L(lang, { en: "Review note (optional)", ko: "검토 메모(선택)" })}
        value={reviewNote}
        onChange={(e) => setReviewNote(e.target.value)}
      />
      {reviewError && <p className="text-xs text-destructive">{reviewError}</p>}
      <div className="flex items-center gap-2">
        {/* Deep-cobalt primary: the one governing action of this page */}
        <Button size="sm" variant="outline" className="h-7 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]"
          onClick={() => mutation.mutate("approved")} disabled={mutation.isPending || !reviewAcknowledged}>
          <CheckCircle2 className="h-3.5 w-3.5" />{L(lang, { en: "Approve", ko: "승인" })}
        </Button>
        <Button size="sm" variant="outline" className="h-7 border-[#f87171]/50 text-xs text-[#f87171] hover:bg-[#f87171]/10 hover:text-[#f87171]"
          onClick={() => mutation.mutate("rejected")} disabled={mutation.isPending}>
          <XCircle className="h-3.5 w-3.5" />{L(lang, { en: "Reject", ko: "거절" })}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-[#8b97ad] hover:text-[#e6edf7]" onClick={onDone} disabled={mutation.isPending}>
          {L(lang, { en: "Cancel", ko: "취소" })}
        </Button>
      </div>
    </div>
  );
}

// ── ProposalRow ───────────────────────────────────────────────────────────────

interface ProposalRowProps {
  proposal: WorktreeProposal;
  agentMap: Record<string, string>;
  /** 0 = untouched; each "Review next" click bumps the sequence so exactly the requested row opens. */
  reviewSeq: number;
}

function ProposalRow({ proposal, agentMap, reviewSeq }: ProposalRowProps) {
  const lang = useCompanyLanguage();
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const status = proposal.status as ProposalStatus;
  const isPending = status === "proposed";

  // Toolbar CTA expands this row's review form without stealing the row's own toggle state.
  useEffect(() => {
    if (reviewSeq === 0) return;
    setExpanded(true);
    setReviewing(isPending);
    document.getElementById(`proposal-${proposal.id}`)?.scrollIntoView({ block: "nearest" });
  }, [reviewSeq, isPending, proposal.id]);

  const statusInfo = STATUS_TABLE.find((s) => s.value === status);
  const StatusIcon = statusInfo?.icon ?? Clock;
  const change = proposal.proposedChange;

  return (
    <div id={`proposal-${proposal.id}`} className="border-b border-[#242d3f] transition-colors last:border-b-0 hover:bg-[#151b28]">
      {/* Row header */}
      <div className={cn(ROW_TRACKS, "h-10 text-sm")}>
        <span className="flex min-w-0 items-center gap-3">
          <button
            className="shrink-0 p-0.5 text-[#8b97ad] hover:text-[#e6edf7]"
            onClick={() => { setExpanded((v) => !v); if (reviewing) setReviewing(false); }}
            aria-label={expanded ? "Collapse proposal" : "Expand proposal"}
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <GitPullRequest className="h-4 w-4 shrink-0 text-[#8b97ad]" />
          <span className="min-w-0 flex-1 truncate font-medium text-[#e6edf7]">{change.name}</span>
        </span>

        {/* Severity badge */}
        <span className={cn(
          "justify-self-start rounded px-1.5 py-0.5 font-mono font-medium text-xs",
          SEVERITY_COLORS[change.severity] ?? "bg-[#151b28] text-[#8b97ad]",
        )}>
          {change.severity}
        </span>

        {/* Agent */}
        <span className="hidden min-w-0 items-center gap-1 text-xs text-[#8b97ad] sm:flex">
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{agentMap[proposal.proposedBy] ?? proposal.proposedBy}</span>
        </span>

        {/* Date */}
        <span className="hidden min-w-0 truncate text-xs text-[#8b97ad] lg:block">{formatDate(proposal.createdAt)}</span>

        {/* Status */}
        <span className="hidden shrink-0 items-center gap-1 text-xs lg:flex" style={{ color: statusInfo?.color }}>
          <StatusIcon className="h-3.5 w-3.5" />
          <span title={status}>{humanLabel(lang, "approvalStatus", status === "proposed" ? "pending" : status).label}</span>
        </span>

        {/* Review button — only for pending */}
        {isPending ? (
          <Button
            size="sm"
            variant="outline"
            aria-pressed={reviewing}
            className="h-6 shrink-0 text-xs"
            onClick={() => { setExpanded(true); setReviewing((v) => !v); }}
          >
            Review
          </Button>
        ) : (
          <span className="h-6 w-16" aria-hidden />
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="space-y-3 px-10 pb-4">
          <div>
            <p className="mb-1 text-xs font-medium text-[#8b97ad]">Rationale</p>
            <p className="whitespace-pre-wrap break-words text-xs text-[#e6edf7]">{proposal.rationale}</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-[#8b97ad]">Proposed rule</p>
            <DiffView change={change} />
          </div>

          {/* Review info if already decided */}
          {!isPending && proposal.reviewedBy && (
            <div className="space-y-0.5 border-t border-[#242d3f] pt-2 text-xs text-[#8b97ad]">
              <p><span className="font-medium text-[#e6edf7]">Reviewed by:</span> {agentMap[proposal.reviewedBy] ?? proposal.reviewedBy}</p>
              <p><span className="font-medium text-[#e6edf7]">Reviewed at:</span> {formatDate(proposal.reviewedAt)}</p>
              {proposal.ruleId && (
                <p><span className="font-medium text-[#e6edf7]">Rule ID:</span> <span className="font-mono">{proposal.ruleId}</span></p>
              )}
            </div>
          )}

          {/* Review form */}
          {reviewing && isPending && <ReviewForm proposal={proposal} onDone={() => setReviewing(false)} />}
        </div>
      )}
    </div>
  );
}

// ── AgentRateLimitBar — shows proposals used today per agent ──────────────────

/** One #111622 hairline card; one line per agent that proposed today (client-side approximate — server is authoritative). */
function AgentRateLimitBar({ proposals, agentMap }: { proposals: WorktreeProposal[]; agentMap: Record<string, string> }) {
  const today = new Date().toDateString();
  const countByAgent: Record<string, number> = {};
  for (const p of proposals) {
    if (new Date(p.createdAt).toDateString() === today) {
      countByAgent[p.proposedBy] = (countByAgent[p.proposedBy] ?? 0) + 1;
    }
  }

  const agents = Object.entries(countByAgent).sort((a, b) => b[1] - a[1]);
  if (agents.length === 0) return null;

  return (
    <div className="space-y-1.5 rounded-md border border-[#242d3f] bg-[#111622] px-3 py-2">
      <p className="text-[10.5px] uppercase tracking-[0.08em] text-[#8b97ad]">Today's proposal usage</p>
      {agents.map(([agentId, count]) => {
        const capped = count >= MAX_PROPOSALS_PER_AGENT_PER_DAY;
        return (
          <div key={agentId} className="flex items-center gap-3 text-xs">
            <span className="flex min-w-0 w-48 items-center gap-1.5 text-[#8b97ad]">
              <Bot className="h-3 w-3 shrink-0" />
              <span className="truncate">{agentMap[agentId] ?? agentId}</span>
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[#151b28]">
              <span
                className={cn("block h-full rounded-full transition-all", capped ? "bg-[#f87171]" : "bg-[#2563eb]")}
                style={{ width: `${Math.min((count / MAX_PROPOSALS_PER_AGENT_PER_DAY) * 100, 100)}%` }}
              />
            </span>
            <span className={cn("shrink-0 font-mono", capped ? "font-medium text-[#f87171]" : "text-[#8b97ad]")}>
              {count}/{MAX_PROPOSALS_PER_AGENT_PER_DAY}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── WorktreeProposals page ────────────────────────────────────────────────────

export function WorktreeProposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("proposed");
  const [reviewSeq, setReviewSeq] = useState(0);
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Worktree Proposals" }]);
  }, [setBreadcrumbs]);

  const { data: proposals, isLoading, error } = useQuery({
    queryKey: queryKeys.worktree.proposals(selectedCompanyId!),
    queryFn: () => worktreeApi.listProposals(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap: Record<string, string> = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  const allProposals = proposals ?? [];
  const counts = useMemo(() => {
    const byStatus = Object.fromEntries(STATUS_TABLE.map((s) => [s.value, 0])) as Record<ProposalStatus, number>;
    const today = new Date().toDateString();
    let todayCount = 0;
    for (const p of allProposals) {
      byStatus[p.status as ProposalStatus] = (byStatus[p.status as ProposalStatus] ?? 0) + 1;
      if (new Date(p.createdAt).toDateString() === today) todayCount += 1;
    }
    return { ...byStatus, today: todayCount };
  }, [allProposals]);

  const filtered = statusFilter === "all" ? allProposals : allProposals.filter((p) => p.status === statusFilter);
  const nextPending = allProposals.find((p) => p.status === "proposed");

  /** Opens the review form of the oldest pending proposal (or the one already targeted) without new API calls. */
  const reviewNext = () => {
    const target = (reviewTarget && allProposals.find((p) => p.id === reviewTarget && p.status === "proposed")) || nextPending;
    if (!target) return;
    setReviewTarget(target.id);
    setStatusFilter(target.status);
    setReviewSeq((n) => n + 1);
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={GitPullRequest} message="Select a company to view proposals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-2 tabular-nums">
      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p>}

      {/* 1-row cockpit strip: proposal counts double as status-filter shortcuts */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Rule-change proposals by status">
        <span className="cockpit-cell shrink-0">
          <GitPullRequest className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="uppercase tracking-wide">Proposals</span>
        </span>
        <button
          type="button"
          aria-pressed={statusFilter === "all"}
          title="Show all proposals"
          onClick={() => setStatusFilter("all")}
          className={cn("cockpit-cell min-w-0 flex-1 cursor-pointer justify-center transition-colors", statusFilter === "all" ? STRIP_CELL_ACTIVE : STRIP_CELL_IDLE)}
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#5f8dff]" />
          <span className="truncate uppercase tracking-wide">Total</span>
          <b className="ml-1">{allProposals.length}</b>
        </button>
        {STATUS_TABLE.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={statusFilter === s.value}
            title={`Show ${s.label.toLowerCase()} proposals`}
            onClick={() => setStatusFilter(s.value)}
            className={cn("cockpit-cell min-w-0 flex-1 cursor-pointer justify-center transition-colors", statusFilter === s.value ? STRIP_CELL_ACTIVE : STRIP_CELL_IDLE)}
          >
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="truncate uppercase tracking-wide">{s.label}</span>
            <b className="ml-1">{counts[s.value]}</b>
          </button>
        ))}
        <span className="cockpit-cell min-w-0 flex-1 justify-center" title="Proposals created today (3 per agent per day)">
          Today <b className="ml-1">{counts.today}</b>
        </span>
      </div>

      {/* Tight single-row 40px toolbar: visible/total readout · deep-cobalt review CTA. */}
      <div className="cockpit-toolbar h-10 w-full rounded-md border border-[#242d3f] bg-[#111622] pl-1.5 pr-1.5">
        <span className="shrink-0 text-[11px] text-[#8b97ad]">
          <b className="font-mono text-[#e6edf7]">{filtered.length}</b> of {allProposals.length} shown
        </span>
        <span className="hidden shrink-0 text-[11px] text-[#8b97ad] sm:block">
          · <b className="font-mono text-[#e6edf7]">{counts.proposed}</b> awaiting review
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={!nextPending}
          onClick={reviewNext}
          className="h-7 shrink-0 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8] disabled:opacity-45"
        >
          Review next
        </Button>
      </div>

      {/* Rate limit bar */}
      {allProposals.length > 0 && <AgentRateLimitBar proposals={allProposals} agentMap={agentMap} />}

      {/* Empty state */}
      {filtered.length === 0 && (
        <EmptyState
          icon={GitPullRequest}
          message={
            statusFilter === "all"
              ? "No proposals yet."
              : statusFilter === "proposed"
              ? "No pending proposals."
              : `No ${statusFilter} proposals.`
          }
        />
      )}

      {/* Proposal list */}
      {filtered.length > 0 && (
        <div aria-label="Rule-change proposals" className="overflow-hidden rounded-md border border-[#242d3f] bg-[#111622]">
          <div className={cn(ROW_TRACKS, "h-7 text-[10.5px] uppercase tracking-[0.08em] text-[#8b97ad]")}>
            <span>Proposed rule</span>
            <span>Sev.</span>
            <span className="hidden sm:block">Agent</span>
            <span className="hidden lg:block">Created</span>
            <span className="hidden lg:block">Status</span>
            <span className="text-right">Action</span>
          </div>
          {filtered.map((proposal) => (
            <ProposalRow
              key={proposal.id}
              proposal={proposal}
              agentMap={agentMap}
              reviewSeq={reviewTarget === proposal.id ? reviewSeq : 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
