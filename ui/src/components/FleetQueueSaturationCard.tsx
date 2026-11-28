import { cn } from "../lib/utils";

export interface AgentQueueRow {
  agentId: string;
  agentName?: string;
  maxConcurrentRuns: number;
  runningCount: number;
  queuedCount: number;
  utilizationRatio: number;
  saturated: boolean;
  oldestQueuedWaitMs: number;
  starvationWarning: boolean;
  distinctQueuedIssues: number;
}

export interface FleetQueueSummary {
  totalSlots: number;
  totalRunning: number;
  totalQueued: number;
  saturatedAgents: number;
  starvingAgents: number;
  maxQueuedWaitMs: number;
  byAgent: AgentQueueRow[];
}

const CARD_CLASS = "tactile-card min-w-0 overflow-hidden rounded-[12px] border border-border/80 bg-card/90 text-card-foreground tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_10px_28px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.42)]";
const KPI_CARD = "rounded-[10px] border border-border/70 bg-background/70 px-3 py-2 dark:border-white/[0.08] dark:bg-[#07090d]";
const KPI_LABEL = "font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground dark:text-[#8f9db3]";
const KPI_VALUE = "mt-1 font-mono text-lg font-semibold leading-none text-foreground dark:text-[#eef2f8]";
const STARVING_BADGE = "inline-flex shrink-0 items-center rounded-full border border-amber-700/45 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-rose-950 dark:border-amber-300/50 dark:bg-amber-950/70 dark:text-rose-100";
const SATURATED_BADGE = "inline-flex shrink-0 items-center rounded-full border border-rose-700/35 bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-rose-950 dark:border-rose-300/40 dark:bg-rose-950/70 dark:text-rose-100";
const ROW_CLASS = "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2 text-left text-xs text-inherit transition-colors";
const ROW_INTERACTIVE_CLASS = "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 dark:hover:bg-white/[0.04]";
const BAR_TRACK = "col-span-2 h-1.5 overflow-hidden rounded-full border border-border/70 bg-muted dark:border-white/[0.07] dark:bg-[#07090d]";

export function formatQueueWaitMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1분";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}분`;
  return `${hours}시간 ${minutes}분`;
}

function agentDisplayName(row: AgentQueueRow): string {
  return row.agentName?.trim() || row.agentId;
}

function slotRatio(row: AgentQueueRow): number {
  const ratio = row.maxConcurrentRuns > 0
    ? row.runningCount / row.maxConcurrentRuns
    : row.utilizationRatio;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

function compareBusiest(a: AgentQueueRow, b: AgentQueueRow): number {
  const utilizationDelta = slotRatio(b) - slotRatio(a);
  if (utilizationDelta !== 0) return utilizationDelta;
  if (b.runningCount !== a.runningCount) return b.runningCount - a.runningCount;
  if (b.queuedCount !== a.queuedCount) return b.queuedCount - a.queuedCount;
  return agentDisplayName(a).localeCompare(agentDisplayName(b), "ko");
}

function Kpi({ label, value, alert = false }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <div className={cn(KPI_CARD, alert && "border-amber-700/40 bg-amber-100/80 dark:border-amber-300/35 dark:bg-amber-950/35")}>
      <dt className={KPI_LABEL}>{label}</dt>
      <dd className={cn(KPI_VALUE, alert && "text-rose-950 dark:text-amber-100")}>{value}</dd>
    </div>
  );
}

export function FleetQueueSaturationCard({ summary, onSelectAgent }: { summary: FleetQueueSummary | null | undefined; onSelectAgent?: (agentId: string) => void }) {
  if (!summary || (summary.totalSlots === 0 && summary.totalQueued === 0)) return null;

  const busiestAgents = [...summary.byAgent].sort(compareBusiest).slice(0, 5);
  const hasStarvation = summary.starvingAgents > 0;

  return (
    <section role="region" aria-label="실행 슬롯 및 큐 현황" className={CARD_CLASS}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/75 px-3 py-2 dark:border-white/[0.07]">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-foreground dark:text-[#eef2f8]">실행 슬롯 및 큐 현황</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground dark:text-[#8f9db3]">최장 대기 {formatQueueWaitMs(summary.maxQueuedWaitMs)}</p>
        </div>
        {hasStarvation ? <span className={STARVING_BADGE}>장기 대기 {summary.starvingAgents}개</span> : null}
      </header>

      <dl className="grid grid-cols-2 gap-2 px-3 py-3 sm:grid-cols-4">
        <Kpi label="실행 슬롯" value={`${summary.totalRunning} / ${summary.totalSlots}`} />
        <Kpi label="대기 큐" value={summary.totalQueued} />
        <Kpi label="포화 에이전트" value={summary.saturatedAgents} />
        <Kpi label="장기 대기 경보" value={summary.starvingAgents} alert={hasStarvation} />
      </dl>

      {busiestAgents.length > 0 ? (
        <ul className="divide-y divide-border/70 border-t border-border/75 dark:divide-white/[0.06] dark:border-white/[0.07]">
          {busiestAgents.map((row) => {
            const name = agentDisplayName(row);
            const percent = Math.round(slotRatio(row) * 100);
            const fillTone = row.starvationWarning || row.saturated
              ? "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.45)] dark:bg-rose-400"
              : "bg-blue-600 shadow-[0_0_6px_rgba(37,99,235,0.28)] dark:bg-[#60a5fa]";
            const content = (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-semibold text-foreground dark:text-[#eef2f8]">{name}</span>
                  {row.saturated ? <span className={SATURATED_BADGE}>포화</span> : null}
                  {row.starvationWarning ? <span className={STARVING_BADGE}>장기 대기</span> : null}
                </span>
                <span className="text-right text-muted-foreground dark:text-[#8f9db3]">
                  {row.runningCount} / {row.maxConcurrentRuns} · 큐 {row.queuedCount}
                </span>
                <span className={BAR_TRACK} role="progressbar" aria-label={`${name} 실행 슬롯 사용률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <span className={cn("block h-full rounded-full", fillTone)} style={{ width: `${percent}%` }} />
                </span>
                <span className="col-span-2 text-[11px] text-muted-foreground dark:text-[#8f9db3]">
                  최장 대기 {formatQueueWaitMs(row.oldestQueuedWaitMs)} · 대기 이슈 {row.distinctQueuedIssues}개
                </span>
              </>
            );
            return (
              <li key={row.agentId}>
                {onSelectAgent ? (
                  <button type="button" className={cn(ROW_CLASS, ROW_INTERACTIVE_CLASS)} onClick={() => onSelectAgent(row.agentId)}>
                    {content}
                  </button>
                ) : (
                  <div className={ROW_CLASS}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-t border-border/75 px-3 py-3 text-xs text-muted-foreground dark:border-white/[0.07] dark:text-[#8f9db3]">에이전트 큐 데이터가 없습니다.</p>
      )}
    </section>
  );
}
