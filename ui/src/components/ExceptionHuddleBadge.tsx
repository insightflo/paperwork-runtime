import { cn } from "@/lib/utils";

export type ExceptionHuddleBadgeStatus = "open" | "timed_out" | "decided" | "cancelled";
export type ExceptionHuddleBadgeDecisionKind =
  | "retry_with_guidance"
  | "accept_with_waiver"
  | "replan_remaining"
  | "escalate";

export interface ExceptionHuddleBadgeProps {
  status: ExceptionHuddleBadgeStatus;
  currentRound: number;
  maxRounds: number;
  decisionKind?: ExceptionHuddleBadgeDecisionKind | null;
  forcedByChair?: boolean;
  onOpen?: () => void;
  className?: string;
}

const DECISION_KIND_LABELS: Record<ExceptionHuddleBadgeDecisionKind, string> = {
  retry_with_guidance: "Retry with guidance",
  accept_with_waiver: "Accept with waiver",
  replan_remaining: "Replan remaining work",
  escalate: "Escalate",
};

function humanLabel(kind: ExceptionHuddleBadgeDecisionKind | null | undefined): string {
  if (!kind) return "Decided";
  return DECISION_KIND_LABELS[kind] ?? kind;
}

function pillTone(status: ExceptionHuddleBadgeStatus): string {
  if (status === "open") {
    return "border-blue-600/40 bg-blue-500/15 text-blue-800 dark:border-[#60a5fa]/40 dark:bg-[#60a5fa]/15 dark:text-[#93c5fd]";
  }
  if (status === "timed_out") {
    return "border-red-600/45 bg-orange-500/15 text-red-700 dark:border-[#f87171]/45 dark:bg-[#fb923c]/15 dark:text-[#fca5a5]";
  }
  if (status === "decided") {
    return "border-lime-600/40 bg-lime-500/15 text-lime-800 dark:border-[#a3e635]/40 dark:bg-[#a3e635]/15 dark:text-[#a3e635]";
  }
  return "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:border-white/20 dark:bg-white/[0.06] dark:text-slate-300";
}

function dotTone(status: ExceptionHuddleBadgeStatus): string {
  if (status === "open") return "bg-blue-600 dark:bg-[#60a5fa]";
  if (status === "timed_out") return "bg-red-600 dark:bg-[#f87171]";
  if (status === "decided") return "bg-lime-600 dark:bg-[#a3e635]";
  return "bg-slate-500 dark:bg-slate-400";
}

function visibleText(props: ExceptionHuddleBadgeProps): string {
  if (props.status === "open") return `Huddle R${props.currentRound}/${props.maxRounds}`;
  if (props.status === "timed_out") return "Huddle Timeout · Chair Decision";
  if (props.status === "decided") {
    const base = `Huddle: ${humanLabel(props.decisionKind)}`;
    return props.forcedByChair ? `${base} (Chair)` : base;
  }
  return "Huddle Cancelled";
}

function describeStatus(props: ExceptionHuddleBadgeProps): string {
  if (props.status === "open") {
    return `round ${props.currentRound} of ${props.maxRounds} in progress`;
  }
  if (props.status === "timed_out") return "timed out, chair decision";
  if (props.status === "decided") {
    const base = `decided, ${humanLabel(props.decisionKind)}`;
    return props.forcedByChair ? `${base}, forced by chair` : base;
  }
  return "cancelled";
}

/**
 * Compact status pill for an exception huddle. Renders as an interactive
 * button when `onOpen` is provided (deep-link into the huddle), otherwise as
 * a non-interactive live-region status badge.
 */
export function ExceptionHuddleBadge(props: ExceptionHuddleBadgeProps) {
  const { status, onOpen, className } = props;
  const text = visibleText(props);
  const description = describeStatus(props);
  const classes = cn(
    "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap shadow-sm",
    pillTone(status),
    onOpen &&
      "cursor-pointer transition-[color,box-shadow,filter] hover:brightness-95 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none dark:hover:brightness-110",
    className,
  );
  const dot = (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 rounded-full",
        dotTone(status),
        status === "open" && "motion-safe:animate-pulse",
      )}
    />
  );

  if (onOpen) {
    return (
      <button
        type="button"
        aria-label={`Open exception huddle: ${description}`}
        className={classes}
        onClick={onOpen}
      >
        {dot}
        {text}
      </button>
    );
  }

  return (
    <span role="status" aria-label={`Exception huddle: ${description}`} className={classes}>
      {dot}
      {text}
    </span>
  );
}
