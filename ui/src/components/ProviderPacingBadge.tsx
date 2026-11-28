import { cn } from "@/lib/utils";

export type ProviderPacingReason = "ok" | "cooldown_active" | "provider_throttled" | "at_slot_limit";

export interface ProviderPacingBadgeProps {
  provider: string;
  effectiveSlots: number;
  reason: ProviderPacingReason;
  retryAfterMs?: number;
  className?: string;
}

interface ProviderPacingTone {
  badge: string;
  dot: string;
}

const TONES: Record<ProviderPacingReason, ProviderPacingTone> = {
  ok: {
    badge: "border-[var(--pw-lime)] bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]",
    dot: "bg-[var(--pw-lime)]",
  },
  cooldown_active: {
    badge: "border-[var(--pw-crimson)] bg-[var(--pw-crimson-soft)] text-[var(--pw-crimson)]",
    dot: "bg-[var(--pw-crimson)]",
  },
  provider_throttled: {
    badge: "border-[var(--pw-amber)] bg-[var(--pw-amber-soft)] text-[var(--pw-amber)]",
    dot: "bg-[var(--pw-amber)]",
  },
  at_slot_limit: {
    badge: "border-[var(--pw-cobalt)] bg-[var(--pw-cobalt-soft)] text-[var(--pw-cobalt)]",
    dot: "bg-[var(--pw-cobalt)]",
  },
};

const BADGE_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap tabular-nums";
const DOT_CLASS = "h-1.5 w-1.5 shrink-0 rounded-full";

export function formatProviderPacingLabel(
  reason: ProviderPacingReason,
  effectiveSlots: number,
  retryAfterMs?: number,
): string {
  if (reason === "cooldown_active") {
    return retryAfterMs && retryAfterMs > 0 ? `쿨다운 ${Math.ceil(retryAfterMs / 1000)}초` : "쿨다운 대기";
  }
  if (reason === "provider_throttled") return `슬롯 축소 (${effectiveSlots})`;
  if (reason === "at_slot_limit") return `슬롯 한도 (${effectiveSlots})`;
  return `정상 (${effectiveSlots})`;
}

export function ProviderPacingBadge({
  provider,
  effectiveSlots,
  reason,
  retryAfterMs,
  className,
}: ProviderPacingBadgeProps) {
  const tone = TONES[reason];
  const label = formatProviderPacingLabel(reason, effectiveSlots, retryAfterMs);
  const ariaLabel = `프로바이더 ${provider} 실행 슬롯 상태: ${label}`;

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-provider={provider}
      data-reason={reason}
      className={cn(BADGE_CLASS, tone.badge, className)}
    >
      <span aria-hidden="true" className={cn(DOT_CLASS, tone.dot)} />
      <span className="max-w-28 truncate font-semibold">{provider}</span>
      <span aria-hidden="true" className="h-3 w-px bg-current opacity-30" />
      <span>{label}</span>
    </span>
  );
}
