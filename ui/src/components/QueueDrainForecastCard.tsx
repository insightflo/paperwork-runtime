export interface QueueDrainForecastView {
  currentSlots: number;
  estimatedDrainMs: number;
  suggestedSlots: number;
  suggestedDrainMs: number;
  speedupRatio: number;
}

const CARD_CLASS =
  "rounded-xl border border-border/70 bg-card/95 text-card-foreground shadow-sm " +
  "dark:border-[var(--pw-token-border)] dark:bg-[var(--pw-token-bg-surface-raised)]";

const LABEL_CLASS = "text-[11px] font-medium text-muted-foreground dark:text-[var(--pw-token-text-muted)]";
const VALUE_CLASS = "mt-0.5 text-sm font-semibold tabular-nums text-foreground dark:text-[var(--pw-token-text-primary)]";

export function formatDrainEtaMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "즉시";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}초`;

  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}분`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}시간 ${minutes}분`;
}

export function QueueDrainForecastCard({
  forecast,
  onApplySuggestedSlots,
}: {
  forecast: QueueDrainForecastView | null | undefined;
  onApplySuggestedSlots?: (slots: number) => void;
}) {
  if (!forecast || forecast.estimatedDrainMs <= 0) return null;

  const hasSuggestion = forecast.suggestedSlots > forecast.currentSlots;

  return (
    <section
      role="region"
      aria-label="대기열 소진 예상"
      data-testid="queue-drain-forecast-card"
      className={CARD_CLASS}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground dark:text-[var(--pw-token-text-muted)]">
            대기열 소진 예상
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div>
              <p className={LABEL_CLASS}>현재 슬롯</p>
              <p className={VALUE_CLASS}>{forecast.currentSlots}개</p>
            </div>
            <div>
              <p className={LABEL_CLASS}>현재 예상 소진</p>
              <p className={VALUE_CLASS}>{formatDrainEtaMs(forecast.estimatedDrainMs)}</p>
            </div>
          </div>
        </div>

        {hasSuggestion && (
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-2 dark:border-[var(--pw-token-accent)]/35 dark:bg-[var(--pw-token-accent-soft)]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <div>
                <p className={LABEL_CLASS}>제안 슬롯</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-primary dark:text-[var(--pw-token-accent-text)]">
                  {forecast.suggestedSlots}개
                </p>
              </div>
              <div>
                <p className={LABEL_CLASS}>확장 시 예상</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums text-primary dark:text-[var(--pw-token-accent-text)]">
                  {formatDrainEtaMs(forecast.suggestedDrainMs)}
                </p>
              </div>
              <span className="rounded-full border border-primary/25 bg-background/80 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary dark:border-[var(--pw-token-accent)]/35 dark:bg-[var(--pw-token-bg-surface)] dark:text-[var(--pw-token-accent-text)]">
                {forecast.speedupRatio}x 빠름
              </span>
            </div>
            {onApplySuggestedSlots && (
              <button
                type="button"
                onClick={() => onApplySuggestedSlots(forecast.suggestedSlots)}
                className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:border-[var(--pw-token-accent)]/40 dark:bg-[var(--pw-token-accent-soft)] dark:text-[var(--pw-token-accent-text)] dark:hover:border-[var(--pw-token-accent)]/60"
              >
                슬롯 {forecast.suggestedSlots}개 적용
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
