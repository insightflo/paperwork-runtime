import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { FileText, History, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MissionExceptionHuddleDrawerProps {
  open: boolean;
  missionTitle?: string;
  onClose: () => void;
  telemetrySlot?: ReactNode;
  timeoutBannerSlot?: ReactNode;
  historySlot?: ReactNode;
  auditSlot?: ReactNode;
  initialTab?: "history" | "audit";
  className?: string;
}

type HuddleDrawerTab = NonNullable<MissionExceptionHuddleDrawerProps["initialTab"]>;

export function MissionExceptionHuddleDrawer({
  open,
  missionTitle,
  onClose,
  telemetrySlot,
  timeoutBannerSlot,
  historySlot,
  auditSlot,
  initialTab = "history",
  className,
}: MissionExceptionHuddleDrawerProps) {
  const idBase = useId();
  const [activeTab, setActiveTab] = useState<HuddleDrawerTab>(initialTab);
  const titleId = `${idBase}-title`;
  const historyPanelId = `${idBase}-history-panel`;
  const auditPanelId = `${idBase}-audit-panel`;
  const historyTabId = `${idBase}-history-tab`;
  const auditTabId = `${idBase}-audit-tab`;
  const title = missionTitle?.trim() || "예외 허들 / Exception Huddles";

  useEffect(() => {
    if (!open) return;
    setActiveTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      data-mission-exception-huddle-drawer-backdrop
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/55 backdrop-blur-[2px]"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "tactile-card flex h-full w-full max-w-md flex-col border-l border-slate-200/90 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none",
          className,
        )}
      >
        <header className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3.5 dark:border-white/[0.06]">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-[#f59e0b]" aria-hidden />
            <h2 id={titleId} className="truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="inline-flex h-7.5 cursor-pointer items-center justify-center rounded-lg border border-slate-200/90 bg-white px-2 text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#cbd5e1] dark:hover:bg-[#141b29]"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          {timeoutBannerSlot != null ? <div className="shrink-0">{timeoutBannerSlot}</div> : null}
          {telemetrySlot != null ? <div className="shrink-0">{telemetrySlot}</div> : null}

          <div
            role="tablist"
            aria-label="예외 허들 기록 탭"
            className="tactile-card inline-flex w-fit shrink-0 items-center gap-1 rounded-[10px] border border-slate-200/90 bg-slate-100/80 p-1 dark:border-white/[0.08] dark:bg-background dark:bg-none"
          >
            <button
              type="button"
              role="tab"
              id={historyTabId}
              aria-selected={activeTab === "history"}
              aria-controls={historyPanelId}
              onClick={() => setActiveTab("history")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                activeTab === "history"
                  ? "bg-white text-slate-950 shadow-sm ring-1 ring-[#84cc16]/40 dark:bg-[#151d2e] dark:text-[#eef2f8]"
                  : "text-slate-600 hover:text-slate-950 dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]",
              )}
            >
              <History className="h-3.5 w-3.5" aria-hidden />
              <span>이력 / History</span>
            </button>
            <button
              type="button"
              role="tab"
              id={auditTabId}
              aria-selected={activeTab === "audit"}
              aria-controls={auditPanelId}
              onClick={() => setActiveTab("audit")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                activeTab === "audit"
                  ? "bg-white text-slate-950 shadow-sm ring-1 ring-[var(--pw-cobalt)]/45 dark:bg-[#151d2e] dark:text-[#eef2f8]"
                  : "text-slate-600 hover:text-slate-950 dark:text-[#9aa7bd] dark:hover:text-[#eef2f8]",
              )}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              <span>감사 기록 / Audit</span>
            </button>
          </div>

          {activeTab === "history" ? (
            <div
              id={historyPanelId}
              role="tabpanel"
              aria-labelledby={historyTabId}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {historySlot}
            </div>
          ) : (
            <div
              id={auditPanelId}
              role="tabpanel"
              aria-labelledby={auditTabId}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {auditSlot}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
