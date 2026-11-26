import { useEffect, useState } from "react";
import { ArrowRight, Bot, Check, Clock, Lock, ShieldCheck, X } from "lucide-react";

export interface ApprovalQueueItem {
  id: string;
  channelId: string;
  botId: string;
  botName: string;
  fromUserName: string;
  toTerminalId: string;
  toTerminalName: string;
  toOwnerName: string;
  toOwnerUserId?: string | null;
  capabilityKey?: string | null;
  action: string;
  requestedAt: string;
}

export interface ApprovalQueueDrawerProps {
  open: boolean;
  approvals: ApprovalQueueItem[];
  canAdmin?: boolean;
  viewerId?: string;
  viewerName?: string;
  busyApprovalId?: string | null;
  now?: number;
  onClose: () => void;
  onDecision?: (
    approvalId: string,
    decision: "approve" | "deny",
    note?: string,
  ) => Promise<unknown> | void;
}

function formatAge(requestedAt: string, nowMs: number): string {
  const parsed = Date.parse(requestedAt);
  if (Number.isNaN(parsed)) return "just now";
  const sec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function canDecideOwnerApproval(
  item: ApprovalQueueItem,
  opts: { canAdmin?: boolean; viewerId?: string; viewerName?: string },
): boolean {
  if (opts.canAdmin) return true;
  if (opts.viewerId && item.toOwnerUserId && item.toOwnerUserId === opts.viewerId) return true;
  if (opts.viewerName && item.toOwnerName && item.toOwnerName === opts.viewerName) return true;
  return false;
}

export function ApprovalQueueDrawer({
  open,
  approvals,
  canAdmin = false,
  viewerId,
  viewerName,
  busyApprovalId = null,
  now,
  onClose,
  onDecision,
}: ApprovalQueueDrawerProps) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const nowMs = now ?? Date.now();

  useEffect(() => {
    if (approvals.length === 0) {
      setFocusedIndex(0);
    } else if (focusedIndex >= approvals.length) {
      setFocusedIndex(approvals.length - 1);
    }
  }, [approvals.length, focusedIndex]);

  const submitDecision = (item: ApprovalQueueItem, decision: "approve" | "deny") => {
    if (!onDecision || busyApprovalId !== null) return;
    if (!canDecideOwnerApproval(item, { canAdmin, viewerId, viewerName })) return;
    const trimmed = notes[item.id]?.trim();
    void onDecision(item.id, decision, trimmed || undefined);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      if (approvals.length === 0) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setFocusedIndex((idx) => (idx + 1) % approvals.length);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setFocusedIndex((idx) => (idx - 1 + approvals.length) % approvals.length);
        return;
      }

      const active = approvals[focusedIndex];
      if (!active) return;

      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        submitDecision(active, "approve");
      } else if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        submitDecision(active, "deny");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (!open) return null;

  return (
    <div
      data-approval-drawer-backdrop
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/55 backdrop-blur-[2px]"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Pending Owner Approvals"
        className="tactile-card flex h-full w-full max-w-md flex-col border-l border-slate-200/90 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none"
      >
        <header className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3.5 dark:border-white/[0.06]">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-amber-600 dark:text-[#f59e0b]" aria-hidden />
            <h2 className="truncate text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">
              Pending Owner Approvals
            </h2>
            <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/15 dark:text-[#fcd34d]">
              {approvals.length}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close approvals drawer"
            onClick={onClose}
            className="inline-flex h-7.5 cursor-pointer items-center justify-center rounded-lg border border-slate-200/90 bg-white px-2 text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#cbd5e1] dark:hover:bg-[#141b29]"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
          {approvals.length === 0 ? (
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 text-center text-xs text-slate-500 dark:border-white/[0.06] dark:bg-[#090d14] dark:text-[#8b97ad]">
              No pending bot_channel_owner_approval requests.
            </div>
          ) : (
            approvals.map((item, idx) => {
              const focused = idx === focusedIndex;
              const allowed = canDecideOwnerApproval(item, { canAdmin, viewerId, viewerName });
              const isBusy = busyApprovalId !== null;
              const capability = item.capabilityKey || item.action;

              return (
                <article
                  key={item.id}
                  data-approval-card={item.id}
                  data-focused={focused || undefined}
                  onClick={() => setFocusedIndex(idx)}
                  className={`tactile-card space-y-2.5 rounded-xl border p-3 text-xs transition-colors ${
                    focused
                      ? "border-blue-500/50 bg-blue-50/50 ring-1 ring-blue-500/20 dark:border-[#60a5fa]/50 dark:bg-[#131c2e] dark:bg-none dark:ring-[#60a5fa]/20"
                      : "border-slate-200/80 bg-slate-50/60 hover:border-slate-300 dark:border-white/[0.07] dark:bg-[#090d14] dark:bg-none dark:hover:border-white/[0.14]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Bot className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
                      <span className="truncate font-semibold text-slate-950 dark:text-[#edf2fb]">
                        {item.botName}
                      </span>
                    </div>
                    <span
                      title={item.requestedAt}
                      className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]"
                    >
                      <Clock className="h-3 w-3" aria-hidden />
                      {formatAge(item.requestedAt, nowMs)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-700 dark:text-[#cbd5e1]">
                    <span className="font-medium text-slate-950 dark:text-[#edf2fb]">
                      {item.fromUserName}
                    </span>
                    <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                    <span className="font-medium text-blue-700 dark:text-[#60a5fa]">
                      {item.toTerminalName}
                    </span>
                    <span className="text-slate-500 dark:text-[#8b97ad]">({item.toOwnerName})</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="rounded border border-slate-200/90 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-800 dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#cbd5e1]">
                      {capability}
                    </code>
                  </div>

                  <input
                    type="text"
                    aria-label={`Decision note for ${item.botName}`}
                    value={notes[item.id] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    onClick={(e) => e.stopPropagation()}
                    disabled={!allowed || isBusy}
                    placeholder="Optional note..."
                    className="h-7.5 w-full rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus:border-[#60a5fa]"
                  />

                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    {allowed ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!onDecision || isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            submitDecision(item, "approve");
                          }}
                          className="inline-flex h-7.5 cursor-pointer items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden />
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={!onDecision || isBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            submitDecision(item, "deny");
                          }}
                          className="inline-flex h-7.5 cursor-pointer items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-medium text-rose-700 transition-colors hover:border-rose-500/50 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                          Deny
                        </button>
                      </div>
                    ) : (
                      <span
                        data-permission-locked
                        className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-[#fcd34d]"
                      >
                        <Lock className="h-3 w-3" aria-hidden />
                        Owner or admin required
                      </span>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200/80 px-4 py-2.5 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-[#8b97ad]">
          <span className="font-mono">Esc close · A approve · D deny</span>
          <span className="font-mono tabular-nums">
            {approvals.length > 0 ? `${focusedIndex + 1}/${approvals.length}` : "0/0"}
          </span>
        </footer>
      </aside>
    </div>
  );
}
