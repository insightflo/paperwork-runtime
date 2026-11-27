// ui/src/components/workflows/WorkflowHarnessStatusBar.tsx
//
// [파일 목적] dgate 스타일 워크플로 실행 하네스 텔레메트리 스트립 (읽기 전용 — 뮤테이션·승인 없음).
//   stall watchdog 건강도, 활성 advisor gate(g1/g2/g3) 판정, 확률 게이팅 라우팅 배지, 롤링 신뢰도를
//   하나의 Compact Combo 1 tactile 바에 모아 보여준다. 모든 값은 호출자가 내려주는 표시 상태다.
// [연결] mount: (미사용 — 재사용 가능 프리젠테이션 컴포넌트). 소비자가 run/step 상태를 props로 주입한다.
import { cn } from "../../lib/utils";

export type HarnessRoute = "sharp" | "split" | "escalate";
export type HarnessStallStatus = "healthy" | "stalled" | "timed_out";
export type HarnessAdvisorVerdict = "pending" | "pass" | "challenge";

export interface HarnessAdvisorGate {
  gate: "g1" | "g2" | "g3";
  verdict: HarnessAdvisorVerdict;
  reason?: string;
}

export interface WorkflowHarnessStatusBarProps {
  route?: HarnessRoute;
  stallStatus?: HarnessStallStatus;
  idleMs?: number;
  advisorGate?: HarnessAdvisorGate | null;
  successRatePct?: number | null;
  className?: string;
}

const PANEL =
  "tactile-card min-w-0 overflow-hidden rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const CELL = "flex min-w-0 flex-1 flex-col gap-1 px-3 py-2";
const DIVIDER = "my-2 w-px shrink-0 self-stretch bg-slate-200/90 dark:bg-white/[0.07]";
const LABEL = "truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]";
const PILL =
  "inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none tracking-wide uppercase tabular-nums whitespace-nowrap";
const MUTED_PILL =
  "border-slate-200/90 bg-slate-50 text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]";
const DOT = "h-1.5 w-1.5 shrink-0 rounded-full";

const ROUTE_PILL: Record<HarnessRoute, string> = {
  sharp: "border-lime-600/25 bg-lime-500/10 text-lime-800 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  split: "border-blue-600/25 bg-blue-500/10 text-blue-800 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]",
  escalate: "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
};
const ROUTE_LABEL: Record<HarnessRoute, string> = { sharp: "SHARP", split: "SPLIT", escalate: "ESCALATE" };

const WATCHDOG_PILL: Record<HarnessStallStatus, string> = {
  healthy: "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:border-[#34d399]/30 dark:bg-[#34d399]/10 dark:text-[#34d399]",
  stalled: "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
  timed_out: "border-rose-600/25 bg-rose-500/10 text-rose-800 dark:border-[#fb7185]/30 dark:bg-[#fb7185]/10 dark:text-[#fb7185]",
};
const WATCHDOG_LABEL: Record<HarnessStallStatus, string> = {
  healthy: "HEALTHY",
  stalled: "STALLED",
  timed_out: "TIMED OUT",
};
const WATCHDOG_DOT: Record<HarnessStallStatus, string> = {
  healthy: "bg-emerald-500 dark:bg-[#34d399]",
  stalled: "animate-pulse bg-amber-500 shadow-[0_0_7px_rgba(245,158,11,0.45)] dark:bg-[#f59e0b]",
  timed_out: "bg-rose-500 dark:bg-[#fb7185]",
};

const GATE_LABEL: Record<HarnessAdvisorGate["gate"], string> = { g1: "G1 PLAN", g2: "G2 ERROR", g3: "G3 CLOSEOUT" };
const VERDICT_LABEL: Record<HarnessAdvisorVerdict, string> = { pending: "PENDING", pass: "PASS", challenge: "CHALLENGE" };
const VERDICT_PILL: Record<HarnessAdvisorVerdict, string> = {
  pending: "border-slate-300/90 bg-slate-100 text-slate-600 dark:border-white/[0.12] dark:bg-[#090c12] dark:text-[#a9b4c6]",
  pass: "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:border-[#34d399]/30 dark:bg-[#34d399]/10 dark:text-[#34d399]",
  challenge: "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
};

/** Idle duration in ms → compact "12.4s" / "3m 05s" / "1h 02m". Negative/NaN → "0s". */
export function formatIdleDuration(ms: number | undefined): string {
  const total = Number.isFinite(ms) && (ms ?? 0) > 0 ? Math.floor(ms as number) : 0;
  if (total === 0) return "0s";
  const sec = Math.floor(total / 1000);
  if (sec < 10) return `${(total / 1000).toFixed(1)}s`;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Success rate percent → "87%" / "87.5%"; null/NaN → "—". Clamped to 0–100. */
export function formatSuccessRate(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const clamped = Math.min(100, Math.max(0, pct));
  return `${Number.isInteger(clamped) ? clamped.toFixed(0) : clamped.toFixed(1)}%`;
}

export function WorkflowHarnessStatusBar({
  route,
  stallStatus,
  idleMs,
  advisorGate,
  successRatePct,
  className,
}: WorkflowHarnessStatusBarProps) {
  const gate = advisorGate ?? null;

  return (
    <section aria-label="Workflow harness status" className={cn(PANEL, className)}>
      <div className="flex min-w-0 items-stretch">
        <div className={CELL} data-testid="harness-route">
          <span className={LABEL}>Route</span>
          {route ? (
            <span className={cn(PILL, ROUTE_PILL[route])} title={`Probability-gated routing: ${ROUTE_LABEL[route]}`}>
              {ROUTE_LABEL[route]}
            </span>
          ) : (
            <span className={cn(PILL, MUTED_PILL)}>—</span>
          )}
        </div>
        <span aria-hidden className={DIVIDER} />
        <div className={CELL} data-testid="harness-watchdog">
          <span className={LABEL}>Watchdog</span>
          <span className="flex min-w-0 items-center gap-2">
            {stallStatus ? (
              <span
                className={cn(PILL, WATCHDOG_PILL[stallStatus])}
                data-stall-status={stallStatus}
                title={`Stall watchdog: ${WATCHDOG_LABEL[stallStatus]}`}
              >
                <span aria-hidden className={cn(DOT, WATCHDOG_DOT[stallStatus])} />
                {WATCHDOG_LABEL[stallStatus]}
              </span>
            ) : (
              <span className={cn(PILL, MUTED_PILL)}>—</span>
            )}
            <span className="truncate font-mono text-xs text-slate-500 tabular-nums dark:text-[#8b97ad]">
              idle {formatIdleDuration(idleMs)}
            </span>
          </span>
        </div>
        <span aria-hidden className={DIVIDER} />
        <div className={CELL} data-testid="harness-advisor">
          <span className={LABEL}>Advisor gate</span>
          {gate ? (
            <span className="flex min-w-0 items-center gap-1.5" title={gate.reason ?? undefined}>
              <span className={cn(PILL, "border-slate-200/90 bg-slate-50 text-slate-700 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#d5dce8]")}>
                {GATE_LABEL[gate.gate]}
              </span>
              <span className={cn(PILL, VERDICT_PILL[gate.verdict])} data-verdict={gate.verdict}>
                {gate.verdict === "pass" ? "✓ " : gate.verdict === "challenge" ? "! " : "○ "}
                {VERDICT_LABEL[gate.verdict]}
              </span>
              {gate.reason ? (
                <span className="hidden min-w-0 truncate text-[11px] text-slate-500 md:inline dark:text-[#8b97ad]">
                  {gate.reason}
                </span>
              ) : null}
            </span>
          ) : (
            <span className={cn(PILL, MUTED_PILL)}>no gate</span>
          )}
        </div>
        <span aria-hidden className={DIVIDER} />
        <div className={cn(CELL, "flex-none basis-24")} data-testid="harness-reliability">
          <span className={LABEL}>Reliability</span>
          <span
            className="font-mono text-base font-semibold leading-none tracking-tight tabular-nums text-slate-950 dark:text-[#eef2f8]"
            aria-label={`Rolling reliability ${formatSuccessRate(successRatePct)}`}
          >
            {formatSuccessRate(successRatePct)}
          </span>
        </div>
      </div>
    </section>
  );
}
