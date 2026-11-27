import { cn } from "../../lib/utils";

/** Advisor gate state for a workflow run, as reported by the harness summary. */
export type WorkflowAdvisorGate = "g1_pending" | "g2_challenge" | "g3_pass" | "none";

type Tone = "pending" | "challenge" | "pass" | "none";

interface GateMeta {
  readonly code: string;
  readonly label: string;
  readonly tone: Tone;
}

const GATE_META: Record<WorkflowAdvisorGate, GateMeta> = {
  g1_pending: { code: "G1", label: "G1 검토 대기", tone: "pending" },
  g2_challenge: { code: "G2", label: "G2 자문 반려", tone: "challenge" },
  g3_pass: { code: "G3", label: "G3 통과", tone: "pass" },
  none: { code: "—", label: "게이트 없음", tone: "none" },
};

/** Explicit light + dark tones so the badge stays readable in both cockpit themes. */
const TONE_CLASS: Record<Tone, string> = {
  pending:
    "border-amber-600/30 bg-amber-50 text-amber-800 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 dark:text-[#fbbf24]",
  challenge:
    "border-red-600/30 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-500/10 dark:text-red-300",
  pass: "border-[#65a30d]/30 bg-[#65a30d]/10 text-[#4d7c0f] dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  none: "border-slate-200/80 bg-slate-50 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#a7b3c6]",
};

/** Secondary shape cue so the state is not conveyed by color alone. */
const DOT_CLASS: Record<Tone, string> = {
  pending: "rounded-full bg-amber-500 dark:bg-[#f59e0b]",
  challenge: "rounded-sm bg-red-500 dark:bg-red-400",
  pass: "rounded-full bg-[#65a30d] dark:bg-[#a3e635]",
  none: "rounded-full border border-current opacity-60",
};

const BASE_CLASS =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap tabular-nums";

const UNKNOWN_META: GateMeta = { code: "?", label: "자문 게이트 알 수 없음", tone: "none" };

function resolveMeta(gate: string): GateMeta {
  return (GATE_META as Record<string, GateMeta | undefined>)[gate] ?? UNKNOWN_META;
}

export interface WorkflowAdvisorGateBadgeProps {
  /** Advisor gate state. Unknown runtime values fall back to a neutral "unknown" badge. */
  readonly advisorGate: WorkflowAdvisorGate | (string & {});
  /** When true, shows only the short code; the full Korean label stays in `aria-label`/`title`. */
  readonly compact?: boolean;
  readonly className?: string;
}

export function WorkflowAdvisorGateBadge({ advisorGate, compact = false, className }: WorkflowAdvisorGateBadgeProps) {
  const meta = resolveMeta(advisorGate);
  const accessibleLabel = `자문 게이트: ${meta.label}`;

  return (
    <span
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-advisor-gate={advisorGate}
      data-tone={meta.tone}
      className={cn(BASE_CLASS, TONE_CLASS[meta.tone], className)}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0", DOT_CLASS[meta.tone])} />
      {compact ? meta.code : meta.label}
    </span>
  );
}
