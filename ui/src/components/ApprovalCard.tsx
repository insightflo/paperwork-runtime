import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Identity } from "./Identity";
import { approvalLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";
import { HumanReviewPacket } from "./HumanReviewPacket";
import { CardHumanSummary } from "./CardHumanSummary";
import type { HumanSummaryView } from "@/api/approvals";
import { approvalHumanReview } from "../lib/humanReview";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { humanLabel } from "../lib/humanLabels";
import { cn } from "../lib/utils";

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5" />;
  return null;
}

function statusPillClass(status: string) {
  if (status === "approved") {
    return "border-lime-600/25 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/12 dark:text-[#a3e635]";
  }
  if (status === "rejected") {
    return "border-red-600/25 bg-red-500/10 text-red-700 dark:border-[#fb7185]/35 dark:bg-[#fb7185]/12 dark:text-[#fb7185]";
  }
  if (status === "revision_requested" || status === "pending") {
    return "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]";
  }
  return "border-blue-600/25 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]";
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending,
}: {
  approval: Approval & { humanSummary?: HumanSummaryView | null };
  requesterAgent: Agent | null;
  onApprove: () => void;
  onReject: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending: boolean;
}) {
  const lang = useCompanyLanguage();
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null, lang);
  const showResolutionButtons =
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const reviewPacket = approvalHumanReview(approval);

  return (
    <div className="tactile-card relative overflow-hidden rounded-xl border border-border/80 bg-card/90 p-4 space-y-0 tabular-nums transition-[border-color,background-color,box-shadow] duration-150 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/10 to-transparent dark:via-white/15" />
      <div aria-hidden className="pointer-events-none absolute bottom-4 left-0 top-4 w-px bg-gradient-to-b from-blue-500/50 via-blue-500/10 to-transparent dark:from-[#60a5fa]/70 dark:via-[#60a5fa]/15" />

      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border/70 pb-3 dark:border-white/[0.07]">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/70 text-muted-foreground dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#60a5fa]">
            <Icon className="h-4 w-4 shrink-0" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-sm text-foreground dark:text-[#eef2f8]">{label}</span>
              {requesterAgent && (
                <span className="text-xs text-muted-foreground dark:text-[#9aa7bd]">
                  {L(lang, { en: "requested by", ko: "요청:" })} <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider tabular-nums", statusPillClass(approval.status))}>
            {statusIcon(approval.status)}
            <span title={approval.status}>{humanLabel(lang, "approvalStatus", approval.status).label}</span>
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums dark:text-[#8f9db3]">{timeAgo(approval.createdAt)}</span>
        </div>
      </div>

      {/* 초보자 해석 (표시 전용 — 원문 아래 유지, 실패 시 자동 숨김) */}
      <CardHumanSummary approvalId={approval.id} companyId={approval.companyId} summary={approval.humanSummary} />

      {/* Payload */}
      <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} />
      <HumanReviewPacket packet={reviewPacket} />

      {/* Decision note */}
      {approval.decisionNote && (
        <div className="mt-3 text-xs text-muted-foreground italic border-t border-border/70 pt-2 dark:border-white/[0.07] dark:text-[#9aa7bd]">
          {L(lang, { en: "Note:", ko: "결정 메모:" })} {approval.decisionNote}
        </div>
      )}

      {/* Actions */}
      {showResolutionButtons && (
        <div className="flex gap-2 mt-4 pt-3 border-t border-border/70 dark:border-white/[0.07]">
          <Button
            size="sm"
            className="border border-lime-700/25 bg-lime-700 text-white hover:bg-lime-600 dark:border-[#a3e635]/50 dark:bg-[#a3e635] dark:text-[#0b0f05] dark:hover:bg-[#bef264]"
            onClick={onApprove}
            disabled={isPending || !reviewPacket || (approval.type === "workflow_replacement" && approval.status !== "pending")}
            title={!reviewPacket ? L(lang, { en: "Review information and source locations are required before approval.", ko: "판단 정보와 원본 위치를 보완해야 승인할 수 있습니다." }) : undefined}
          >
            {L(lang, { en: "Approve", ko: "승인" })}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onReject}
            disabled={isPending}
          >
            {L(lang, { en: "Reject", ko: "거절" })}
          </Button>
        </div>
      )}
      <div className="mt-3">
        {detailLink ? (
          <Button variant="ghost" size="sm" className="text-xs px-0 dark:text-[#60a5fa] dark:hover:text-[#a3e635]" asChild>
            <Link to={detailLink}>{L(lang, { en: "View details", ko: "자세히 보기" })}</Link>
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="text-xs px-0 dark:text-[#60a5fa] dark:hover:text-[#a3e635]" onClick={onOpen}>
            {L(lang, { en: "View details", ko: "자세히 보기" })}
          </Button>
        )}
      </div>
    </div>
  );
}
