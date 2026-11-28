import { cn } from "@/lib/utils";

export interface AdapterCapabilityView {
  adapterType: string;
  displayName: string;
  supportsSessionResume: boolean;
  supportsMultiSlot: boolean;
  requiresWorkspaceTrustBypass: boolean;
  defaultMaxConcurrentRuns: number;
  maxRecommendedSlots: number;
}

export interface AdapterCapabilityBadgesProps {
  profile: AdapterCapabilityView | null | undefined;
  className?: string;
}

type PillTone = "positive" | "neutral" | "attention";

interface CapabilityPill {
  key: string;
  label: string;
  tone: PillTone;
}

const PILL_BASE =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5 whitespace-nowrap";

const PILL_TONES: Record<PillTone, string> = {
  positive:
    "border-[var(--pw-token-success)]/35 bg-[var(--pw-token-success-soft)] text-[var(--pw-token-success-text)]",
  neutral:
    "border-[var(--pw-token-border)] bg-[var(--pw-token-bg-surface-raised)] text-[var(--pw-token-text-muted)]",
  attention:
    "border-[var(--pw-token-warning)]/35 bg-[var(--pw-token-warning-soft)] text-[var(--pw-token-warning-text)]",
};

function buildCapabilityPills(profile: AdapterCapabilityView): CapabilityPill[] {
  const pills: CapabilityPill[] = [
    {
      key: "slots",
      label: profile.supportsMultiSlot
        ? `멀티 슬롯 (최대 ${profile.maxRecommendedSlots})`
        : "단일 슬롯",
      tone: profile.supportsMultiSlot ? "positive" : "neutral",
    },
    {
      key: "session-resume",
      label: profile.supportsSessionResume ? "세션 재개 지원" : "세션 재개 미지원",
      tone: profile.supportsSessionResume ? "positive" : "neutral",
    },
  ];

  if (profile.requiresWorkspaceTrustBypass) {
    pills.push({
      key: "trust-bypass",
      label: "비대화형 신뢰 우회 적용",
      tone: "attention",
    });
  }

  return pills;
}

export function AdapterCapabilityBadges({
  profile,
  className,
}: AdapterCapabilityBadgesProps) {
  if (!profile) return null;

  return (
    <div
      role="group"
      aria-label={`${profile.displayName} 실행 역량`}
      data-testid="adapter-capability-badges"
      data-adapter-type={profile.adapterType}
      className={cn("flex flex-wrap items-center gap-1.5 tabular-nums", className)}
    >
      {buildCapabilityPills(profile).map((pill) => (
        <span key={pill.key} className={cn(PILL_BASE, PILL_TONES[pill.tone])}>
          {pill.label}
        </span>
      ))}
    </div>
  );
}
