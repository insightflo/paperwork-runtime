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

const MEMORY_STATUS_TABLE: Record<MemoryReviewStatus, BadgeTone> = {
  pending: { label: "대기", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  held: { label: "보류", className: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  approved: { label: "승인됨", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  rejected: { label: "반려됨", className: "bg-rose-500/10 text-rose-700 dark:text-rose-400" },
};

const DRAFT_STATUS_TABLE: Record<SkillDraftStatus, BadgeTone> = {
  draft: { label: "초안", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  promoted: { label: "승격됨", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  discarded: { label: "폐기됨", className: "bg-slate-500/10 text-slate-600 dark:text-slate-400" },
};

function StatusBadge({ tone }: { tone: BadgeTone }) {
  return (
    <span className={cn("ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", tone.className)}>
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
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs leading-relaxed">
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
    <section className="rounded-lg border border-border bg-card p-4" data-memory-review-id={proposal.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">{proposal.targetPath}</span>
        <StatusBadge tone={MEMORY_STATUS_TABLE[proposal.status]} />
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{proposal.summary}</p>
      {proposal.status === "held" && proposal.heldUntilMs != null && (
        <p className="mt-1 text-xs text-muted-foreground">
          보류 해제 예정: {new Date(proposal.heldUntilMs).toLocaleString()}
        </p>
      )}
      {!actionable && (
        <p className="mt-1 text-xs text-muted-foreground">
          검토자: {proposal.reviewedByUserId ?? "—"}
          {proposal.reviewNote ? ` · 메모: ${proposal.reviewNote}` : ""}
        </p>
      )}
      <div className="mt-3">
        <DiffBlock diffLines={proposal.diffLines} />
      </div>
      {actionable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => onDecide("approve")}>승인 (Approve)</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide("hold")}>보류 (Hold 24h)</Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => onDecide("reject")}>반려 (Reject)</Button>
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
    <section className="rounded-lg border border-border bg-card p-4" data-skill-draft-id={draft.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground">{draft.slug}</span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          v{draft.revision}
        </span>
        <span title={draft.contentSha256} className="font-mono text-[11px] text-muted-foreground">
          {draft.contentSha256.slice(0, 12)}
        </span>
        <span className="text-[11px] text-muted-foreground">소스 런 {draft.sourceRunIds.length}개</span>
        <StatusBadge tone={DRAFT_STATUS_TABLE[draft.status]} />
      </div>
      <p className="mt-1.5 text-sm font-medium text-foreground">{draft.title}</p>
      <p className="text-sm text-muted-foreground">{draft.description}</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          SKILL.md 미리보기
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">
          {draft.skillMarkdown}
        </pre>
      </details>
      {actionable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={onPromote}>승격 (Promote)</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onDiscard}>폐기 (Discard)</Button>
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
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-xl font-semibold">메모리 · 스킬 학습 리뷰</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        에이전트 메모리 변경 제안과 자동 학습 스킬 초안을 검토합니다.
      </p>
      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList>
          <TabsTrigger value="memory-reviews">메모리 Diff 리뷰</TabsTrigger>
          <TabsTrigger value="skill-drafts">자동 학습 스킬 초안</TabsTrigger>
        </TabsList>
        <TabsContent value="memory-reviews" className="mt-3 flex flex-col gap-3">
          {proposals.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">대기 중인 메모리 변경 제안이 없습니다.</p>
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
        <TabsContent value="skill-drafts" className="mt-3 flex flex-col gap-3">
          {drafts.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">검토할 스킬 초안이 없습니다.</p>
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
