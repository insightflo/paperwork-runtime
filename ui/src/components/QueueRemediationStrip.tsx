export interface QueueRemediationItem {
  agentId: string;
  agentName?: string;
  action: "none" | "provider_cooldown_wait" | "promote_aged_run" | "recommend_slot_increase";
  suggestedSlots?: number;
  reason: string;
}

type RemediationAction = QueueRemediationItem["action"];

const MAX_VISIBLE_ITEMS = 5;

const ROW_CLASS =
  "flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left text-card-foreground tabular-nums";

export function formatRemediationActionLabel(
  action: RemediationAction,
  suggestedSlots?: number,
): string {
  if (action === "recommend_slot_increase") {
    return suggestedSlots ? `슬롯 ${suggestedSlots}개 증설 권장` : "슬롯 증설 권장";
  }
  if (action === "promote_aged_run") return "장기 대기 우선 승격";
  if (action === "provider_cooldown_wait") return "프로바이더 쿨다운 대기";
  return "정상";
}

function actionBadgeClass(action: RemediationAction): string {
  if (action === "recommend_slot_increase") {
    return "border-primary/40 bg-primary/10 text-primary";
  }
  if (action === "promote_aged_run") {
    return "border-primary/30 bg-accent text-accent-foreground";
  }
  if (action === "provider_cooldown_wait") {
    return "border-border bg-muted text-muted-foreground";
  }
  return "border-border bg-secondary text-secondary-foreground";
}

export function QueueRemediationStrip({
  items,
  onOpenAgent,
}: {
  items: readonly QueueRemediationItem[];
  onOpenAgent?: (agentId: string) => void;
}) {
  const actionableItems = items.filter((item) => item.action !== "none");
  if (actionableItems.length === 0) return null;

  const visibleItems = actionableItems.slice(0, MAX_VISIBLE_ITEMS);
  const hiddenCount = actionableItems.length - visibleItems.length;

  return (
    <section
      role="region"
      aria-label="큐 기아 해소 권고"
      data-testid="queue-remediation-strip"
      className="rounded-xl border border-primary/35 bg-primary/5 px-3 py-2 text-foreground shadow-sm tabular-nums"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-primary">큐 기아 해소 권고</span>
        <span className="rounded-full border border-primary/35 bg-card px-2 py-0.5 text-xs font-semibold text-primary">
          {actionableItems.length}건
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {visibleItems.map((item, index) => {
          const trimmedAgentName = item.agentName?.trim();
          const displayName = trimmedAgentName || item.agentId;
          const content = (
            <>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
                  {trimmedAgentName ? (
                    <span className="truncate font-mono text-xs text-muted-foreground">{item.agentId}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={item.reason}>
                  {item.reason}
                </span>
              </span>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${actionBadgeClass(item.action)}`}>
                {formatRemediationActionLabel(item.action, item.suggestedSlots)}
              </span>
            </>
          );

          return (
            <li key={`${item.agentId}:${item.action}:${index}`}>
              {onOpenAgent ? (
                <button
                  type="button"
                  aria-label={`${displayName} 에이전트 열기`}
                  onClick={() => onOpenAgent(item.agentId)}
                  className={`${ROW_CLASS} transition-colors hover:border-primary/50 hover:bg-accent`}
                >
                  {content}
                </button>
              ) : (
                <div className={ROW_CLASS}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 ? (
        <p className="mt-2 text-right text-xs font-medium text-primary">+{hiddenCount}건 더 있음</p>
      ) : null}
    </section>
  );
}
