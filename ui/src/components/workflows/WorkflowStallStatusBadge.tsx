export type WorkflowStallStatus = "healthy" | "stalled" | "timed_out";

export interface WorkflowStallStatusBadgeProps {
  readonly stallStatus: WorkflowStallStatus;
  readonly idleMs?: number;
}

interface StallTone {
  readonly label: string;
  readonly className: string;
}

const TONES: Record<WorkflowStallStatus, StallTone> = {
  healthy: {
    label: "정상",
    className:
      "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300",
  },
  stalled: {
    label: "지연",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-amber-400/35 dark:bg-amber-400/10 dark:text-amber-300",
  },
  timed_out: {
    label: "시간 초과",
    className:
      "border-red-500/40 bg-red-500/10 text-red-700 dark:border-red-400/35 dark:bg-red-400/10 dark:text-red-300",
  },
};

/** Formats idle time as `0s`, `45s`, `5m 12s`, `1h 2m`; negative/NaN clamp to `0s`. */
export function formatStallIdleMs(idleMs: number | undefined): string {
  if (idleMs === undefined || !Number.isFinite(idleMs)) return "0s";
  const totalSeconds = Math.max(0, Math.floor(idleMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function WorkflowStallStatusBadge({ stallStatus, idleMs }: WorkflowStallStatusBadgeProps) {
  const tone = TONES[stallStatus];
  const idle = formatStallIdleMs(idleMs);
  const ariaLabel =
    idleMs === undefined ? `워크플로우 상태: ${tone.label}` : `워크플로우 상태: ${tone.label}, 대기 ${idle}`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums ${tone.className}`}
    >
      <span aria-hidden="true">{tone.label}</span>
      {idleMs !== undefined && (
        <span aria-hidden="true" className="text-muted-foreground dark:text-[#8f9db3]">
          {idle}
        </span>
      )}
    </span>
  );
}
