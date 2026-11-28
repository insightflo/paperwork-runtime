import { cn } from "../lib/utils";

export type BackpressureReason =
  | "ok"
  | "always_admit_priority_lane"
  | "scheduled_backpressure_shed"
  | "workflow_backpressure_shed";

export interface QueueBackpressureBadgeProps {
  readonly reason: BackpressureReason;
  readonly currentQueuedCount: number;
  readonly highWaterMark: number;
  readonly className?: string;
}

const LABELS: Record<BackpressureReason, string> = {
  ok: "유입 정상",
  always_admit_priority_lane: "우선 레인 허용",
  scheduled_backpressure_shed: "예약 유입 제한",
  workflow_backpressure_shed: "워크플로 유입 제한",
};

const TONES: Record<BackpressureReason, string> = {
  ok: "border-chart-2/35 bg-chart-2/10 text-chart-2",
  always_admit_priority_lane: "border-chart-3/35 bg-chart-3/10 text-chart-3",
  scheduled_backpressure_shed: "border-chart-1/35 bg-chart-1/10 text-chart-1",
  workflow_backpressure_shed: "border-chart-5/35 bg-chart-5/10 text-chart-5",
};

const BASE_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 whitespace-nowrap tabular-nums";

export function formatBackpressureLabel(reason: BackpressureReason): string {
  return LABELS[reason];
}

function formatQueuedCount(value: number): string {
  return Number.isFinite(value) ? String(value) : "∞";
}

function formatQueueRatio(currentQueuedCount: number, highWaterMark: number): string {
  const current = formatQueuedCount(currentQueuedCount);
  if (!Number.isFinite(highWaterMark)) return current;
  return `${current}/${highWaterMark}`;
}

export function QueueBackpressureBadge({
  reason,
  currentQueuedCount,
  highWaterMark,
  className,
}: QueueBackpressureBadgeProps) {
  const label = formatBackpressureLabel(reason);
  const queueRatio = formatQueueRatio(currentQueuedCount, highWaterMark);
  const ariaLabel = `큐 유입 상태: ${label}, 대기 ${queueRatio}`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-backpressure-reason={reason}
      className={cn(BASE_CLASS, TONES[reason], className)}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-mono tabular-nums">{queueRatio}</span>
    </span>
  );
}
