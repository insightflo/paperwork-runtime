import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";
import { cn, formatDateTime } from "@/lib/utils";
import { ExceptionHuddleBadge } from "./ExceptionHuddleBadge";

export interface ExceptionHuddleHistoryItem {
  threadId: string;
  channelId: string;
  title: string;
  updatedAt: string;
  huddle: ExceptionHuddleMetadata;
}

export interface ExceptionHuddleHistoryListProps {
  items: ExceptionHuddleHistoryItem[];
  onOpenHuddle?: (item: ExceptionHuddleHistoryItem) => void;
  initialFilter?: "all" | ExceptionHuddleMetadata["status"];
  className?: string;
}

type HistoryFilter = "all" | ExceptionHuddleMetadata["status"];

const FILTER_TABS: ReadonlyArray<{ value: HistoryFilter; label: string; koreanLabel: string }> = [
  { value: "all", label: "All", koreanLabel: "전체" },
  { value: "open", label: "Open", koreanLabel: "진행 중" },
  { value: "timed_out", label: "Timed Out", koreanLabel: "시간 초과" },
  { value: "decided", label: "Decided", koreanLabel: "결정됨" },
  { value: "cancelled", label: "Cancelled", koreanLabel: "취소됨" },
];

function clipDecisionText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 179).trimEnd()}…`;
}

function decisionSnippet(huddle: ExceptionHuddleMetadata): string | null {
  if (huddle.status !== "decided" || !huddle.decision) return null;
  const decision = huddle.decision;
  const detail =
    decision.guidance ??
    decision.waiverCondition ??
    decision.replanSummary ??
    decision.escalationReason ??
    null;
  return clipDecisionText(detail ? `${decision.rationale} — ${detail}` : decision.rationale);
}

function emptyMessage(filter: HistoryFilter): string {
  if (filter === "all") return "No exception huddles yet. 아직 예외 허들이 없습니다.";
  const label = FILTER_TABS.find((tab) => tab.value === filter)?.label ?? "All";
  return `No exception huddles match the ${label} filter. ${label} 필터에 맞는 예외 허들이 없습니다.`;
}

export function ExceptionHuddleHistoryList({
  items,
  onOpenHuddle,
  initialFilter = "all",
  className,
}: ExceptionHuddleHistoryListProps) {
  const idBase = useId();
  const panelId = `${idBase}-huddle-history-panel`;
  const [activeFilter, setActiveFilter] = useState<HistoryFilter>(initialFilter);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const counts = useMemo(() => {
    const next: Record<HistoryFilter, number> = {
      all: items.length,
      open: 0,
      timed_out: 0,
      decided: 0,
      cancelled: 0,
    };
    for (const item of items) next[item.huddle.status] += 1;
    return next;
  }, [items]);

  const visibleItems = useMemo(
    () => (activeFilter === "all" ? items : items.filter((item) => item.huddle.status === activeFilter)),
    [activeFilter, items],
  );

  function selectTab(index: number) {
    const tab = FILTER_TABS[index];
    if (!tab) return;
    setActiveFilter(tab.value);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % FILTER_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + FILTER_TABS.length) % FILTER_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = FILTER_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(nextIndex);
  }

  const activeTabIndex = Math.max(0, FILTER_TABS.findIndex((tab) => tab.value === activeFilter));
  const activeTabId = `${idBase}-huddle-filter-${FILTER_TABS[activeTabIndex]!.value}`;

  return (
    <section
      aria-label="Exception huddle history · 예외 허들 이력"
      className={cn("space-y-3 tabular-nums", className)}
    >
      <div
        role="tablist"
        aria-label="Exception huddle status filters · 예외 허들 상태 필터"
        className="flex flex-wrap items-center gap-1 border-b border-slate-200/80 dark:border-white/[0.07]"
      >
        {FILTER_TABS.map((tab, index) => {
          const selected = activeFilter === tab.value;
          const tabId = `${idBase}-huddle-filter-${tab.value}`;
          const count = counts[tab.value];
          return (
            <button
              key={tab.value}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={tabId}
              aria-selected={selected}
              aria-controls={panelId}
              aria-label={`${tab.label} (${tab.koreanLabel}), ${count} ${count === 1 ? "item" : "items"}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(index)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                selected
                  ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
              )}
            >
              <span>{tab.label}</span>
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none",
                  selected
                    ? "border-blue-600/25 bg-blue-500/10 text-blue-700 dark:border-blue-400/30 dark:bg-blue-400/10 dark:text-blue-300"
                    : "border-slate-300/80 bg-slate-100 text-slate-500 dark:border-white/[0.09] dark:bg-white/[0.05] dark:text-slate-400",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={activeTabId}
        tabIndex={0}
        className="min-w-0"
      >
        {visibleItems.length === 0 ? (
          <p
            role="status"
            className="rounded-[10px] border border-dashed border-slate-300/80 bg-white/70 px-3 py-4 text-center text-xs text-slate-500 dark:border-white/[0.12] dark:bg-card/70 dark:text-muted-foreground"
          >
            {emptyMessage(activeFilter)}
          </p>
        ) : (
          <ul aria-label="Exception huddles · 예외 허들 목록" className="space-y-2">
            {visibleItems.map((item) => {
              const summary = decisionSnippet(item.huddle);
              return (
                <li
                  key={`${item.channelId}:${item.threadId}`}
                  className="rounded-[12px] border border-slate-200/90 bg-white px-3 py-2.5 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_22px_rgba(15,23,42,0.07)] dark:border-white/[0.08] dark:bg-card dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_8px_22px_rgba(0,0,0,0.34)]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <h3 className="min-w-0 truncate text-sm font-medium text-slate-950 dark:text-slate-50">
                          {item.title}
                        </h3>
                        <ExceptionHuddleBadge
                          status={item.huddle.status}
                          currentRound={item.huddle.currentRound}
                          maxRounds={item.huddle.maxRounds}
                          decisionKind={item.huddle.decision?.kind ?? null}
                          forcedByChair={item.huddle.decision?.forcedByChair ?? false}
                          onOpen={onOpenHuddle ? () => onOpenHuddle(item) : undefined}
                        />
                      </div>
                      {summary ? (
                        <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            Decision summary · 결정 요약:
                          </span>{" "}
                          {summary}
                        </p>
                      ) : null}
                    </div>
                    <time
                      dateTime={item.updatedAt}
                      className="shrink-0 pt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]"
                    >
                      {formatDateTime(item.updatedAt)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
