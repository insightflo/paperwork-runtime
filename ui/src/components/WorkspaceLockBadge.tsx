import { cn } from "@/lib/utils";

export type WorkspaceLockState = "unlocked" | "read" | "write";

export interface WorkspaceLockBadgeProps {
  state: WorkspaceLockState;
  holderCount?: number;
  workspaceLabel?: string;
  className?: string;
}

export function formatWorkspaceLockLabel(
  state: WorkspaceLockState,
  holderCount?: number,
): string {
  if (state === "write") return "쓰기 잠금";
  if (state === "read") {
    return holderCount && holderCount > 1 ? `읽기 공유 (${holderCount})` : "읽기 잠금";
  }
  return "잠금 없음";
}

const LOCK_TONES: Record<WorkspaceLockState, { pill: string; dot: string }> = {
  unlocked: {
    pill: "border-border bg-muted/70 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  read: {
    pill: "border-[var(--pw-lime)] bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]",
    dot: "bg-[var(--pw-lime)]",
  },
  write: {
    pill: "border-[var(--pw-amber)] bg-[var(--pw-amber-soft)] text-[var(--pw-amber)]",
    dot: "bg-[var(--pw-amber)]",
  },
};

export function WorkspaceLockBadge({
  state,
  holderCount,
  workspaceLabel,
  className,
}: WorkspaceLockBadgeProps) {
  const label = formatWorkspaceLockLabel(state, holderCount);
  const tone = LOCK_TONES[state];
  const ariaLabel = workspaceLabel ? `${workspaceLabel}: ${label}` : label;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap tabular-nums shadow-sm",
        tone.pill,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("inline-block size-1.5 rounded-full", tone.dot)}
      />
      {label}
    </span>
  );
}
