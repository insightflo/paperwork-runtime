// ui/src/components/workflows/LiveWorkflowHarnessBar.tsx
//
// [purpose] 워크플로 실행 1건의 하네스 요약을 서버(실시간) 우선으로 보여주고, 서버 요약이 없으면
//   호출자가 넘긴 로컬 추정 fallback을 그대로 보여주는 래퍼.
//   useWorkflowRunHarnessStatus(runId, { isRunning })가 summary를 돌려주면 서버 요약을, 그 외
//   (runId 없음 · 첫 로딩 · 본문 불일치로 null · 조회 오류)에는 fallback을 렌더한다.
//   어느 쪽인지 출처 배지(실시간 서버 / 로컬 추정)로 구분하며 조회 오류는 가리지 않고 표시한다.
//   표시 전용이며 실행 제어(retry/wakeup/escalation)의 근거로 쓰지 않는다.
// [연결] hook: hooks/useWorkflowRunHarnessStatus. DTO: api/workflowHarness.
import type { ReactNode } from "react";
import type { WorkflowRunHarnessRoute, WorkflowRunHarnessSummary } from "../../api/workflowHarness";
import { useWorkflowRunHarnessStatus } from "../../hooks/useWorkflowRunHarnessStatus";
import { cn } from "../../lib/utils";

export type HarnessBarSource = "server" | "local";
export type HarnessStallTone = "ok" | "warn" | "bad";

/** Display model derived from one server summary (pure; no React). */
export interface HarnessBarModel {
  stallLabel: string;
  stallTone: HarnessStallTone;
  idleLabel: string;
  route: WorkflowRunHarnessRoute;
  gateLabel: string;
  successLabel: string;
  stepsLabel: string;
  evaluatedAtLabel: string;
}

export interface LiveWorkflowHarnessBarProps {
  /** Run whose server summary is polled. Blank/null disables the query and shows `fallback`. */
  runId: string | null | undefined;
  /** Forwarded to the hook; only a running run keeps polling. */
  isRunning: boolean;
  /** Client-derived estimate rendered whenever no server summary is available. */
  fallback: ReactNode;
  className?: string;
}

const STALL = {
  healthy: { label: "정상", tone: "ok" }, stalled: { label: "지연", tone: "warn" }, timed_out: { label: "시간 초과", tone: "bad" },
} as const satisfies Record<WorkflowRunHarnessSummary["stallStatus"], { label: string; tone: HarnessStallTone }>;
const GATE = { g1_pending: "G1 대기", g2_challenge: "G2 이의 검토", g3_pass: "G3 통과", none: "없음" } as const;
const TONE_CLASS = {
  ok: "text-emerald-700 dark:text-emerald-400", warn: "text-amber-700 dark:text-amber-400", bad: "text-destructive",
} as const satisfies Record<HarnessStallTone, string>;
const SOURCE_LABEL = { server: "실시간 서버", local: "로컬 추정" } as const satisfies Record<HarnessBarSource, string>;

const CHIP = "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none";
const FACT = "whitespace-nowrap tabular-nums";

/** `612_000` → `"10m 12s"`; `0` → `"0s"`. */
export function formatIdleMs(idleMs: number): string {
  const sec = Math.max(0, Math.floor(idleMs / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatEvaluatedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Pure adapter: server summary → display strings. */
export function toHarnessBarModel(s: WorkflowRunHarnessSummary): HarnessBarModel {
  return {
    stallLabel: STALL[s.stallStatus].label,
    stallTone: STALL[s.stallStatus].tone,
    idleLabel: formatIdleMs(s.idleMs),
    route: s.route,
    gateLabel: GATE[s.advisorGate],
    successLabel: s.successRatePct === null ? "집계 전" : `${s.successRatePct.toFixed(1)}%`,
    stepsLabel: `${s.completedSteps}/${s.totalSteps} 완료 · 실패 ${s.failedSteps} · 지연 ${s.stalledSteps}`,
    evaluatedAtLabel: formatEvaluatedAt(s.evaluatedAt),
  };
}

function Fact({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <span className={FACT}>
      <span className="text-muted-foreground">{label}</span> <span className={className}>{value}</span>
    </span>
  );
}

function ServerSummary({ summary }: { summary: WorkflowRunHarnessSummary }) {
  const m = toHarnessBarModel(summary);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-harness-summary={summary.runId}>
      <Fact label="단계 상태" value={m.stallLabel} className={cn("font-semibold", TONE_CLASS[m.stallTone])} />
      <Fact label="유휴" value={m.idleLabel} />
      <Fact label="경로" value={m.route} />
      <Fact label="어드바이저" value={m.gateLabel} />
      <Fact label="성공률" value={m.successLabel} />
      <Fact label="단계" value={m.stepsLabel} />
      <Fact label="평가 시각" value={m.evaluatedAtLabel} />
    </div>
  );
}

/**
 * Live harness bar. Renders the server summary when the hook has one; otherwise renders
 * `fallback` unchanged. The source badge is always present so the two states are
 * distinguishable; the error chip appears only when the server lookup actually failed.
 */
export function LiveWorkflowHarnessBar({ runId, isRunning, fallback, className }: LiveWorkflowHarnessBarProps) {
  const { summary, isLoading, error } = useWorkflowRunHarnessStatus(runId, { isRunning });
  const source: HarnessBarSource = summary ? "server" : "local";
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;
  const badgeTitle = source === "server" ? "서버에서 평가한 하네스 요약"
    : !runId || !runId.trim() ? "실행 ID가 없어 로컬 추정을 표시합니다"
    : isLoading ? "서버 요약을 불러오는 중입니다"
    : "서버 하네스 요약이 없어 로컬 추정을 표시합니다";

  return (
    <section aria-label="워크플로 하네스 상태" data-harness-source={source} className={cn("flex min-w-0 items-start gap-2 text-sm", className)}>
      <div className="min-w-0 flex-1">{summary ? <ServerSummary summary={summary} /> : fallback}</div>
      {errorMessage ? (
        <span className={cn(CHIP, "border-destructive/30 bg-destructive/10 text-destructive")} title={errorMessage} role="status">
          서버 조회 실패
        </span>
      ) : null}
      <span
        className={cn(CHIP, source === "server" ? "border-border bg-muted/30 text-muted-foreground" : "border-dashed border-border text-muted-foreground")}
        title={badgeTitle}
        data-testid="harness-source-badge"
      >
        {SOURCE_LABEL[source]}
      </span>
    </section>
  );
}
