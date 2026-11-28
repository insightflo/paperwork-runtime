import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentGovernanceLearningApi,
  type LocalSkillDraft,
  type MemoryReviewDecision,
  type MemoryReviewDecisionBody,
  type MemoryReviewProposal,
  type MemoryReviewStatus,
  type SkillDraftStatus,
} from "../api/agentGovernanceLearning";
import { useCompany } from "../context/CompanyContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "../lib/utils";

type BadgeTone = { label: string; className: string };

const CARD_SURFACE =
  "tactile-card rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.7)]";
const INSET_SURFACE =
  "rounded-lg border border-slate-200/80 bg-slate-50/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";
const TEXT_MUTED = "text-slate-500 dark:text-[#8b97ad]";
const TEXT_STRONG = "text-slate-950 dark:text-[#eef2f8]";
const ACTION_PRIMARY =
  "h-8 border-blue-600/20 bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]";
const ACTION_OUTLINE =
  "h-8 border-slate-200/90 bg-white text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-[#b8c2d4] dark:hover:bg-white/[0.07]";

const MEMORY_STATUS_TABLE: Record<MemoryReviewStatus, BadgeTone> = {
  pending: { label: "대기", className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-400" },
  held: { label: "보류", className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:border-sky-400/20 dark:text-sky-400" },
  approved: { label: "승인됨", className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/20 dark:text-emerald-400" },
  rejected: { label: "반려됨", className: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:border-rose-400/20 dark:text-rose-400" },
};

const DRAFT_STATUS_TABLE: Record<SkillDraftStatus, BadgeTone> = {
  draft: { label: "초안", className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/20 dark:text-amber-400" },
  promoted: { label: "승격됨", className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/20 dark:text-emerald-400" },
  discarded: { label: "폐기됨", className: "border-slate-400/25 bg-slate-500/10 text-slate-600 dark:border-white/[0.08] dark:text-slate-400" },
};

function StatusBadge({ tone }: { tone: BadgeTone }) {
  return (
    <span className={cn("ml-auto inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[11px] font-semibold", tone.className)}>
      {tone.label}
    </span>
  );
}

function diffLineType(line: string): "add" | "del" | "hunk" | "context" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "context";
}

function DiffBlock({ diffLines }: { diffLines: string[] }) {
  return (
    <pre className={cn("overflow-x-auto p-3 font-mono text-xs leading-relaxed", INSET_SURFACE)}>
      {diffLines.map((line, index) => {
        const type = diffLineType(line);
        return (
          <div
            key={index}
            data-diff-type={type === "add" || type === "del" ? type : undefined}
            className={cn(
              "whitespace-pre",
              type === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
              type === "del" && "bg-rose-500/10 text-rose-700 dark:text-rose-400",
              type === "hunk" && "text-muted-foreground",
            )}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function MemoryReviewCard({
  proposal,
  busy,
  onDecide,
}: {
  proposal: MemoryReviewProposal;
  busy: boolean;
  onDecide: (decision: MemoryReviewDecision) => void;
}) {
  const actionable = proposal.status === "pending" || proposal.status === "held";
  return (
    <section className={cn(CARD_SURFACE, "p-4 sm:p-5")} data-memory-review-id={proposal.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-6 items-center rounded-md border border-slate-200/80 bg-slate-50 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]">
          Memory diff
        </span>
        <span className={cn("min-w-0 truncate font-mono text-xs font-medium", TEXT_STRONG)}>{proposal.targetPath}</span>
        <StatusBadge tone={MEMORY_STATUS_TABLE[proposal.status]} />
      </div>
      <p className="mt-2 text-sm font-medium leading-6 text-slate-800 dark:text-[#c7d0e0]">{proposal.summary}</p>
      {proposal.status === "held" && proposal.heldUntilMs != null && (
        <p className={cn("mt-1 text-xs tabular-nums", TEXT_MUTED)}>
          보류 해제 예정: {new Date(proposal.heldUntilMs).toLocaleString()}
        </p>
      )}
      {!actionable && (
        <p className={cn("mt-1 text-xs", TEXT_MUTED)}>
          검토자: {proposal.reviewedByUserId ?? "—"}
          {proposal.reviewNote ? ` · 메모: ${proposal.reviewNote}` : ""}
        </p>
      )}
      <div className="mt-4">
        <DiffBlock diffLines={proposal.diffLines} />
      </div>
      {actionable && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200/70 pt-3 dark:border-white/[0.07]">
          <Button size="sm" className={ACTION_PRIMARY} disabled={busy} onClick={() => onDecide("approve")}>승인 (Approve)</Button>
          <Button size="sm" variant="outline" className={ACTION_OUTLINE} disabled={busy} onClick={() => onDecide("hold")}>보류 (Hold 24h)</Button>
          <Button size="sm" variant="destructive" className="h-8 text-xs font-semibold" disabled={busy} onClick={() => onDecide("reject")}>반려 (Reject)</Button>
        </div>
      )}
    </section>
  );
}

function SkillDraftCard({
  draft,
  busy,
  onPromote,
  onDiscard,
}: {
  draft: LocalSkillDraft;
  busy: boolean;
  onPromote: () => void;
  onDiscard: () => void;
}) {
  const actionable = draft.status === "draft";
  return (
    <section className={cn(CARD_SURFACE, "p-4 sm:p-5")} data-skill-draft-id={draft.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-6 items-center rounded-md border border-slate-200/80 bg-slate-50 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]">
          Skill draft
        </span>
        <span className={cn("min-w-0 truncate font-mono text-xs font-medium", TEXT_STRONG)}>{draft.slug}</span>
        <span className={cn("shrink-0 rounded-md border border-slate-200/80 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] tabular-nums dark:border-white/[0.08] dark:bg-white/[0.04]", TEXT_MUTED)}>
          v{draft.revision}
        </span>
        <span title={draft.contentSha256} className={cn("font-mono text-[11px] tabular-nums", TEXT_MUTED)}>
          {draft.contentSha256.slice(0, 12)}
        </span>
        <span className={cn("text-[11px] tabular-nums", TEXT_MUTED)}>소스 런 {draft.sourceRunIds.length}개</span>
        <StatusBadge tone={DRAFT_STATUS_TABLE[draft.status]} />
      </div>
      <p className={cn("mt-2.5 text-sm font-semibold", TEXT_STRONG)}>{draft.title}</p>
      <p className={cn("mt-0.5 text-sm leading-6", TEXT_MUTED)}>{draft.description}</p>
      <details className="mt-3">
        <summary className={cn("cursor-pointer text-xs font-semibold transition-colors hover:text-slate-950 dark:hover:text-[#eef2f8]", TEXT_MUTED)}>
          SKILL.md 미리보기
        </summary>
        <pre className={cn("mt-2 overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed", INSET_SURFACE)}>
          {draft.skillMarkdown}
        </pre>
      </details>
      {actionable && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200/70 pt-3 dark:border-white/[0.07]">
          <Button size="sm" className={ACTION_PRIMARY} disabled={busy} onClick={onPromote}>승격 (Promote)</Button>
          <Button size="sm" variant="outline" className={ACTION_OUTLINE} disabled={busy} onClick={onDiscard}>폐기 (Discard)</Button>
        </div>
      )}
    </section>
  );
}

export function MemoryAndSkillsReview() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("memory-reviews");

  const memoryQuery = useQuery({
    queryKey: ["memory-reviews", selectedCompanyId],
    queryFn: () => agentGovernanceLearningApi.listMemoryReviews(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const draftsQuery = useQuery({
    queryKey: ["skill-drafts", selectedCompanyId],
    queryFn: () => agentGovernanceLearningApi.listSkillDrafts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = (queryKey: string[]) => queryClient.invalidateQueries({ queryKey });
  const decideMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: MemoryReviewDecisionBody }) =>
      agentGovernanceLearningApi.decideMemoryReview(selectedCompanyId!, id, body),
    onSuccess: () => invalidate(["memory-reviews"]),
  });
  const promoteMutation = useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      agentGovernanceLearningApi.promoteSkillDraft(companyId, id),
    onSuccess: () => invalidate(["skill-drafts"]),
  });
  const discardMutation = useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      agentGovernanceLearningApi.discardSkillDraft(companyId, id),
    onSuccess: () => invalidate(["skill-drafts"]),
  });
  const busy = decideMutation.isPending || promoteMutation.isPending || discardMutation.isPending;

  if (!selectedCompanyId) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">회사를 먼저 선택하세요.</div>;
  }
  if (memoryQuery.isLoading || draftsQuery.isLoading) return <PageSkeleton />;
  if (memoryQuery.error || draftsQuery.error) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">목록을 불러오지 못했습니다.</div>;
  }

  const proposals = memoryQuery.data ?? [];
  const drafts = draftsQuery.data ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <div className={cn("cockpit-strip h-8 w-full gap-0 overflow-hidden px-0", CARD_SURFACE)} role="group" aria-label="학습 리뷰 요약">
        <span className={cn("cockpit-cell min-w-0 flex-1 justify-center text-[11px]", TEXT_MUTED)}>
          <span className="truncate uppercase tracking-wide">Learning review</span>
        </span>
        <span className={cn("cockpit-cell min-w-0 flex-1 justify-center text-[11px]", TEXT_MUTED)}>
          Memory diffs <b className={cn("ml-1 font-mono tabular-nums", TEXT_STRONG)}>{proposals.length}</b>
        </span>
        <span className={cn("cockpit-cell min-w-0 flex-1 justify-center text-[11px]", TEXT_MUTED)}>
          Skill drafts <b className={cn("ml-1 font-mono tabular-nums", TEXT_STRONG)}>{drafts.length}</b>
        </span>
      </div>

      <header className="px-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Governance cockpit</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 dark:text-[#eef2f8]">메모리 · 스킬 학습 리뷰</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-600 dark:text-[#8b97ad]">
          에이전트 메모리 변경 제안과 자동 학습 스킬 초안을 검토합니다.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="mt-1">
        <TabsList className={cn(CARD_SURFACE, "h-10 w-full justify-start gap-1 overflow-hidden p-1 sm:w-fit")}>
          <TabsTrigger value="memory-reviews" className="h-8 rounded-lg px-3 text-xs font-semibold data-[state=active]:bg-slate-950 data-[state=active]:text-white dark:data-[state=active]:bg-white/[0.08] dark:data-[state=active]:text-[#eef2f8]">
            메모리 Diff 리뷰 <span aria-hidden="true" className="font-mono text-[10px] tabular-nums opacity-70">{proposals.length}</span>
          </TabsTrigger>
          <TabsTrigger value="skill-drafts" className="h-8 rounded-lg px-3 text-xs font-semibold data-[state=active]:bg-slate-950 data-[state=active]:text-white dark:data-[state=active]:bg-white/[0.08] dark:data-[state=active]:text-[#eef2f8]">
            자동 학습 스킬 초안 <span aria-hidden="true" className="font-mono text-[10px] tabular-nums opacity-70">{drafts.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="memory-reviews" className="mt-4 flex flex-col gap-3">
          {proposals.length === 0 ? (
            <div className={cn(CARD_SURFACE, "border-dashed px-4 py-8 text-center")}>
              <p className={cn("text-sm", TEXT_MUTED)}>대기 중인 메모리 변경 제안이 없습니다.</p>
            </div>
          ) : (
            proposals.map((proposal) => (
              <MemoryReviewCard
                key={proposal.id}
                proposal={proposal}
                busy={busy}
                onDecide={(decision) => decideMutation.mutate({ id: proposal.id, body: { decision } })}
              />
            ))
          )}
        </TabsContent>
        <TabsContent value="skill-drafts" className="mt-4 flex flex-col gap-3">
          {drafts.length === 0 ? (
            <div className={cn(CARD_SURFACE, "border-dashed px-4 py-8 text-center")}>
              <p className={cn("text-sm", TEXT_MUTED)}>검토할 스킬 초안이 없습니다.</p>
            </div>
          ) : (
            drafts.map((draft) => (
              <SkillDraftCard
                key={draft.id}
                draft={draft}
                busy={busy}
                onPromote={() => promoteMutation.mutate({ companyId: draft.companyId, id: draft.id })}
                onDiscard={() => discardMutation.mutate({ companyId: draft.companyId, id: draft.id })}
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
