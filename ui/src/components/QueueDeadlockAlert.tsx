import { AlertTriangle } from "lucide-react";

export interface DeadlockCycleView {
  nodes: string[];
  recommendedBreakTarget: {
    waiterId: string;
    targetId: string;
    runId?: string | null;
    waitedMs?: number;
  };
}

export function formatDeadlockCycleChain(nodes: readonly string[]): string {
  if (nodes.length === 0) return "";
  return [...nodes, nodes[0]].join(" → ");
}

function formatWaitedMs(waitedMs: number | undefined): string | null {
  if (waitedMs === undefined || !Number.isFinite(waitedMs) || waitedMs < 0) return null;
  if (waitedMs < 1000) return `${Math.round(waitedMs)}ms`;

  const totalSeconds = Math.round(waitedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function QueueDeadlockAlert({
  cycles,
  onInspectRun,
}: {
  cycles: readonly DeadlockCycleView[];
  onInspectRun?: (runId: string) => void;
}) {
  if (cycles.length === 0) return null;

  return (
    <section
      role="alert"
      aria-live="assertive"
      data-testid="queue-deadlock-alert"
      className="tactile-card border-[var(--pw-token-warning)]/35 bg-[var(--pw-token-warning-soft)] px-3 py-2.5 text-[var(--pw-token-text-primary)]"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--pw-token-warning)]/40 bg-[var(--pw-token-warning-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--pw-token-warning-text)] tabular-nums">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          순환 대기 감지 {cycles.length}건
        </span>
      </div>

      <ul className="mt-2 space-y-1.5">
        {cycles.map((cycle, index) => {
          const target = cycle.recommendedBreakTarget;
          const chain = formatDeadlockCycleChain(cycle.nodes);
          const waited = formatWaitedMs(target.waitedMs);
          const runId = target.runId ?? null;

          return (
            <li
              key={`${index}:${chain}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--pw-token-border)] bg-[var(--pw-token-bg-surface-raised)] px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-medium text-[var(--pw-token-text-secondary)]" title={chain}>
                  {chain}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                  <span className="font-semibold text-[var(--pw-token-warning-text)]">권장 해제 대상</span>
                  <span className="font-mono text-[var(--pw-token-text-secondary)]">
                    {target.waiterId} → {target.targetId}
                  </span>
                  {waited ? (
                    <span className="text-[var(--pw-token-text-muted)] tabular-nums">대기 {waited}</span>
                  ) : null}
                </p>
              </div>

              {runId && onInspectRun ? (
                <button
                  type="button"
                  onClick={() => onInspectRun(runId)}
                  className="shrink-0 rounded-md border border-[var(--pw-token-warning)]/45 bg-[var(--pw-token-warning-soft)] px-2 py-1 text-xs font-semibold text-[var(--pw-token-warning-text)] transition-colors hover:border-[var(--pw-token-warning)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-token-warning)]"
                >
                  실행 보기
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
