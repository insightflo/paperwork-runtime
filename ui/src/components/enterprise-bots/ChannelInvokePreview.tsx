import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Bot, CheckCircle2, Clock, Play, ShieldAlert, Terminal } from "lucide-react";

export type PreviewExecutionTarget = "channel_only" | "personal_terminal" | "worker_node";
export type PreviewPolicyOutcome = "allowed" | "requires_approval" | "denied";

export interface PreviewChannelBot {
  id: string;
  name: string;
  kind?: "personal" | "team" | "company";
  capabilities?: string[];
}

export interface ChannelInvokePreviewRequest {
  channelId: string;
  targetBotId: string;
  capabilityKey: string;
  executionTarget: PreviewExecutionTarget;
}

export interface ChannelInvokePreviewResult {
  outcome: PreviewPolicyOutcome;
  forcedFilter?: Record<string, string> | string | null;
  reasonCode?: string | null;
  summary?: string | null;
}

export interface ChannelAuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  outcome: string;
  detail?: string | null;
}

export interface ChannelInvokePreviewProps {
  channelId: string;
  channelName?: string;
  bots: PreviewChannelBot[];
  auditEntries?: ChannelAuditEntry[];
  initialResult?: ChannelInvokePreviewResult | null;
  busy?: boolean;
  onPreview?: (
    request: ChannelInvokePreviewRequest,
  ) => Promise<ChannelInvokePreviewResult | void> | ChannelInvokePreviewResult | void;
}

const TARGET_OPTIONS: { value: PreviewExecutionTarget; label: string }[] = [
  { value: "channel_only", label: "Channel only" },
  { value: "personal_terminal", label: "Personal terminal" },
  { value: "worker_node", label: "Worker node" },
];

const CONTROL =
  "h-8 w-full rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090d14] dark:text-[#edf2fb] dark:placeholder:text-[#8b97ad] dark:focus:border-[#60a5fa]";

const CARD =
  "tactile-card rounded-xl border border-slate-200/90 bg-white p-3.5 dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none";

const OUTCOME_STYLE: Record<PreviewPolicyOutcome, { box: string; label: string }> = {
  allowed: {
    box: "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200",
    label: "ALLOWED",
  },
  requires_approval: {
    box: "border-amber-500/35 bg-amber-500/10 text-amber-900 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#fde68a]",
    label: "REQUIRES OWNER APPROVAL",
  },
  denied: {
    box: "border-rose-500/35 bg-rose-500/10 text-rose-800 dark:border-rose-500/35 dark:bg-rose-500/10 dark:text-rose-200",
    label: "DENIED",
  },
};

function formatForcedFilter(filter: ChannelInvokePreviewResult["forcedFilter"]): string | null {
  if (!filter) return null;
  if (typeof filter === "string") return filter.trim() || null;
  const pairs = Object.entries(filter).map(([k, v]) => `${k} = ${v}`);
  return pairs.length > 0 ? pairs.join(" AND ") : null;
}

function formatAuditTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(11, 19);
}

function auditBadgeClass(outcome: string): string {
  const n = outcome.toLowerCase();
  if (n === "allowed" || n === "approved" || n === "executed" || n === "ok") {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (n === "requires_approval" || n === "pending") {
    return "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/15 dark:text-[#fcd34d]";
  }
  if (n === "denied" || n === "rejected" || n === "failed" || n === "revoked") {
    return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:border-rose-500/35 dark:bg-rose-500/15 dark:text-rose-300";
  }
  return "border-slate-200/90 bg-slate-100 text-slate-700 dark:border-white/[0.1] dark:bg-white/[0.05] dark:text-[#cbd5e1]";
}

export function ChannelInvokePreview({
  channelId,
  channelName,
  bots,
  auditEntries = [],
  initialResult = null,
  busy = false,
  onPreview,
}: ChannelInvokePreviewProps) {
  const [targetBotId, setTargetBotId] = useState(bots[0]?.id ?? "");
  const [capabilityKey, setCapabilityKey] = useState(bots[0]?.capabilities?.[0] ?? "");
  const [executionTarget, setExecutionTarget] = useState<PreviewExecutionTarget>("channel_only");
  const [result, setResult] = useState<ChannelInvokePreviewResult | null>(initialResult);
  const [running, setRunning] = useState(false);

  const selectedBot = useMemo(() => bots.find((b) => b.id === targetBotId) ?? bots[0], [bots, targetBotId]);

  useEffect(() => {
    if (!bots.some((b) => b.id === targetBotId)) {
      setTargetBotId(bots[0]?.id ?? "");
      setCapabilityKey(bots[0]?.capabilities?.[0] ?? "");
    }
  }, [bots, targetBotId]);

  useEffect(() => { setResult(initialResult); }, [initialResult, channelId]);

  const handleBotChange = (nextBotId: string) => {
    setTargetBotId(nextBotId);
    const nextBot = bots.find((b) => b.id === nextBotId);
    if (nextBot?.capabilities?.length) setCapabilityKey(nextBot.capabilities[0]);
  };

  const handleRunDryRun = async () => {
    if (!onPreview || !targetBotId || !capabilityKey.trim() || busy || running) return;
    setRunning(true);
    try {
      const next = await onPreview({ channelId, targetBotId, capabilityKey: capabilityKey.trim(), executionTarget });
      if (next) setResult(next);
    } catch (err) {
      setResult({ outcome: "denied", reasonCode: "preview_request_failed", summary: err instanceof Error ? err.message : "Dry-run simulation failed." });
    } finally {
      setRunning(false);
    }
  };

  const forcedFilterText = result ? formatForcedFilter(result.forcedFilter) : null;
  const datalistId = `channel-preview-caps-${channelId}`;
  const canRun = Boolean(onPreview && targetBotId && capabilityKey.trim() && !busy && !running);

  return (
    <div className="space-y-3" data-channel-invoke-preview={channelId}>
      <section aria-label="Test @mention / Dry-Run" className={CARD}>
        <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-slate-200/80 pb-2 dark:border-white/[0.06]">
          <div className="flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
            <h3 className="text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">Test @mention / Dry-Run</h3>
          </div>
          {channelName && <span className="font-mono text-[11px] text-slate-500 dark:text-[#8b97ad]">#{channelName}</span>}
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-[11px]">
            <span className="font-medium text-slate-600 dark:text-[#8b97ad]">Target Bot</span>
            <select aria-label="Target bot" value={targetBotId} onChange={(e) => handleBotChange(e.target.value)} disabled={bots.length === 0 || busy || running} className={CONTROL}>
              {bots.length === 0 ? <option value="">No bots in channel</option> : bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>

          <label className="space-y-1 text-[11px]">
            <span className="font-medium text-slate-600 dark:text-[#8b97ad]">Capability Key</span>
            <input type="text" aria-label="Capability key" list={datalistId} value={capabilityKey} onChange={(e) => setCapabilityKey(e.target.value)} placeholder="e.g. web.search" disabled={busy || running} className={`${CONTROL} font-mono`} />
            <datalist id={datalistId}>
              {(selectedBot?.capabilities ?? []).map((cap) => <option key={cap} value={cap} />)}
            </datalist>
          </label>

          <label className="space-y-1 text-[11px]">
            <span className="font-medium text-slate-600 dark:text-[#8b97ad]">Execution Target</span>
            <select aria-label="Execution target" value={executionTarget} onChange={(e) => setExecutionTarget(e.target.value as PreviewExecutionTarget)} disabled={busy || running} className={CONTROL}>
              {TARGET_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void handleRunDryRun()}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            {running ? "Running..." : "Run Dry-Run"}
          </button>

          {selectedBot && (
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-[#8b97ad]">
              <Bot className="h-3 w-3 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
              <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">{selectedBot.name}</span>
              {selectedBot.kind && <span className="font-mono">({selectedBot.kind})</span>}
            </span>
          )}
        </div>

        {result && (
          <div role="status" data-preview-outcome={result.outcome} className={`mt-3 rounded-lg border p-2.5 text-xs ${OUTCOME_STYLE[result.outcome].box}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 font-semibold tracking-wide">
                {result.outcome === "allowed" && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                {result.outcome === "requires_approval" && <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
                {result.outcome === "denied" && <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
                {OUTCOME_STYLE[result.outcome].label}
              </span>
              {result.outcome === "allowed" && forcedFilterText && (
                <code data-forced-filter className="rounded border border-emerald-500/30 bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-emerald-900 dark:border-emerald-400/30 dark:bg-[#090d14] dark:text-emerald-300">
                  {forcedFilterText}
                </code>
              )}
              {result.outcome !== "allowed" && result.reasonCode && (
                <code data-reason-code className="rounded border border-current/25 bg-white/70 px-1.5 py-0.5 font-mono text-[11px] dark:bg-[#090d14]">
                  {result.reasonCode}
                </code>
              )}
            </div>
            {result.summary && <p className="mt-1.5 text-[11px] opacity-90">{result.summary}</p>}
          </div>
        )}
      </section>

      <section aria-label="Audit Timeline" className={CARD}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">Audit Timeline</h3>
          </div>
          <span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]">{auditEntries.length}</span>
        </div>

        {auditEntries.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-[#8b97ad]">No recent channel invocations or policy decisions.</p>
        ) : (
          <ol className="divide-y divide-slate-200/70 dark:divide-white/[0.06]">
            {auditEntries.map((entry) => (
              <li key={entry.id} data-audit-entry={entry.id} className="flex items-start justify-between gap-2 py-2 text-xs first:pt-0.5 last:pb-0">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]">
                      <Clock className="h-3 w-3 shrink-0" aria-hidden />
                      <time dateTime={entry.timestamp} title={entry.timestamp}>{formatAuditTime(entry.timestamp)}</time>
                    </span>
                    <span className="font-medium text-slate-900 dark:text-[#edf2fb]">{entry.actor}</span>
                    <span className="truncate font-mono text-[11px] text-slate-600 dark:text-[#cbd5e1]">{entry.action}</span>
                  </div>
                  {entry.detail && <p className="truncate text-[11px] text-slate-500 dark:text-[#8b97ad]">{entry.detail}</p>}
                </div>
                <span data-audit-outcome={entry.outcome} className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${auditBadgeClass(entry.outcome)}`}>
                  {entry.outcome}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
