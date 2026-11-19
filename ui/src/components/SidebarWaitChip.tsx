import { ArrowRightLeft, Clock3, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { cn } from "../lib/utils";

export type AgentWaitKind = "question" | "approval" | "takeover" | "quota_reset" | "live";

export interface AgentWaitState {
  kind: AgentWaitKind;
  count: number;
  resetAt: string | null;
}

/** Map a pending operator card to the wait kind shown in the sidebar chip. */
export function classifyDecisionKind(decision: OperatorDecisionView): AgentWaitKind {
  const haystack = `${decision.sourceType} ${decision.title}`.toLowerCase();
  if (/takeover|handoff|인계|delegate/.test(haystack)) return "takeover";
  if (/quota|rate.?limit|reset|throttl/.test(haystack)) return "quota_reset";
  if (/question|질문|clarif|ask|choice/.test(haystack)) return "question";
  if (decision.interactionType === "action") return "approval";
  return "question";
}

/** Pure selector: pending human card first, otherwise live-run pulse. */
export function resolveAgentWaitState(args: {
  agentId: string;
  pendingDecisions?: OperatorDecisionView[] | null;
  liveRunCount?: number;
}): AgentWaitState | null {
  const mine = (args.pendingDecisions ?? []).filter(
    (d) => d.status === "pending" && d.requestedBy?.type === "agent" && d.requestedBy.id === args.agentId,
  );
  if (mine.length === 0) {
    const live = args.liveRunCount ?? 0;
    return live > 0 ? { kind: "live", count: live, resetAt: null } : null;
  }
  return { kind: classifyDecisionKind(mine[0]!), count: mine.length, resetAt: null };
}

const KIND_META: Record<Exclude<AgentWaitKind, "live">, { label: string; Icon: typeof Clock3; fg: string; bg: string }> = {
  question: { label: "질문", Icon: MessageCircleQuestion, fg: "--openbot-wait-question", bg: "--openbot-wait-question-soft" },
  approval: { label: "승인", Icon: ShieldAlert, fg: "--openbot-wait-approval", bg: "--openbot-wait-approval-soft" },
  takeover: { label: "인계", Icon: ArrowRightLeft, fg: "--openbot-wait-takeover", bg: "--openbot-wait-takeover-soft" },
  quota_reset: { label: "쿼터대기", Icon: Clock3, fg: "--openbot-wait-quota", bg: "--openbot-wait-quota-soft" },
};

export function SidebarWaitChip(props: {
  state: AgentWaitState | null;
  provider?: string | null;
  compact?: boolean;
  className?: string;
}) {
  const { state } = props;
  if (!state) return null;

  if (state.kind === "live") {
    return (
      <span
        data-provider={props.provider ?? undefined}
        className={cn("flex items-center gap-1.5 shrink-0", props.className)}
      >
        <span className="relative flex h-2 w-2">
          <span
            className="animate-pulse absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ backgroundColor: "var(--openbot-provider-current)" }}
          />
          <span
            className="relative inline-flex rounded-full h-2 w-2"
            style={{ backgroundColor: "var(--openbot-provider-current)" }}
          />
        </span>
        {!props.compact && (
          <span className="text-[11px] font-medium" style={{ color: "var(--openbot-provider-current)" }}>
            {state.count} live
          </span>
        )}
      </span>
    );
  }

  const meta = KIND_META[state.kind];
  return (
    <span
      className={cn(
        "flex items-center gap-1 shrink-0 rounded-full font-medium",
        props.compact ? "px-1 py-0.5" : "px-1.5 py-0.5 text-[10px]",
        props.className,
      )}
      style={{ color: `var(${meta.fg})`, backgroundColor: `var(${meta.bg})` }}
      title={`${meta.label}${state.resetAt ? ` · 리셋 ${state.resetAt}` : ""}`}
    >
      <meta.Icon className="h-3 w-3" />
      {!props.compact && (
        <span>
          {meta.label}
          {state.count > 1 ? ` ${state.count}` : ""}
        </span>
      )}
    </span>
  );
}
