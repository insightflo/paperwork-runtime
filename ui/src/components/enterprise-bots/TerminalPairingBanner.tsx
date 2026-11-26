import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, Stethoscope, Terminal, X } from "lucide-react";

export interface TerminalPairingBannerProps {
  terminalId: string;
  terminalName: string;
  oneTimeToken: string;
  serverUrl: string;
  lastSeenAt?: string | null;
  onDismiss: () => void;
  className?: string;
}

function escapeSingleQuotedShell(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function escapeDoubleQuotedShell(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

/** Secret-safe pairing snippet: injects token via env var, never CLI args. */
export function buildDaemonPairingSnippet(
  oneTimeToken: string,
  serverUrl: string,
  terminalId: string,
): string {
  const safeToken = escapeSingleQuotedShell(oneTimeToken);
  const safeServer = escapeDoubleQuotedShell(serverUrl);
  const safeTerminalId = escapeDoubleQuotedShell(terminalId);
  return [
    `export PAPERWORK_TERMINAL_TOKEN='${safeToken}'`,
    `paperwork-bot daemon --server "${safeServer}" --terminal-id "${safeTerminalId}"`,
  ].join("\n");
}

/** Diagnostic doctor snippet for verifying terminal connectivity. */
export function buildDoctorSnippet(serverUrl: string, terminalId: string): string {
  const safeServer = escapeDoubleQuotedShell(serverUrl);
  const safeTerminalId = escapeDoubleQuotedShell(terminalId);
  return `paperwork-bot doctor --server "${safeServer}" --terminal-id "${safeTerminalId}"`;
}

const ACTION_BTN =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-2.5 text-[11px] font-medium text-slate-800 transition-colors hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090d14] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";

export function TerminalPairingBanner({
  terminalId,
  terminalName,
  oneTimeToken,
  serverUrl,
  lastSeenAt,
  onDismiss,
  className = "",
}: TerminalPairingBannerProps) {
  const [copiedTarget, setCopiedTarget] = useState<"daemon" | "doctor" | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const daemonSnippet = buildDaemonPairingSnippet(oneTimeToken, serverUrl, terminalId);
  const doctorSnippet = buildDoctorSnippet(serverUrl, terminalId);
  const connected = Boolean(lastSeenAt);

  const copySnippet = async (target: "daemon" | "doctor", text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedTarget(target);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopiedTarget(null), 2000);
    } catch {
      // Clipboard API may be unavailable; snippet remains selectable in <code>.
    }
  };

  return (
    <div
      role="status"
      data-terminal-pairing-banner
      data-pairing-status={connected ? "connected" : "waiting"}
      className={`tactile-card space-y-2.5 rounded-xl border px-3.5 py-3 text-xs tabular-nums ${
        connected
          ? "border-emerald-500/35 bg-emerald-50/70 dark:border-[#22c55e]/35 dark:bg-none dark:bg-[#0e131d]"
          : "border-amber-500/40 bg-amber-50/75 dark:border-[#f59e0b]/40 dark:bg-none dark:bg-[#0e131d]"
      } ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: connected ? "var(--openbot-success-text)" : "var(--openbot-warning-text)" }}
            aria-hidden
          />
          <span className="truncate font-semibold text-slate-950 dark:text-[#edf2fb]">
            Pair terminal <span className="font-mono">{terminalName}</span>
          </span>
          <span
            data-heartbeat-indicator
            title={connected ? `Connected · last seen ${lastSeenAt}` : "Listening for initial terminal heartbeat"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
            style={
              connected
                ? {
                    borderColor: "var(--openbot-success)",
                    backgroundColor: "var(--openbot-success-soft)",
                    color: "var(--openbot-success-text)",
                  }
                : {
                    borderColor: "var(--openbot-warning)",
                    backgroundColor: "var(--openbot-warning-soft)",
                    color: "var(--openbot-warning-text)",
                  }
            }
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${connected ? "" : "animate-pulse"}`}
              style={{ backgroundColor: connected ? "var(--openbot-success)" : "var(--openbot-warning)" }}
            />
            {connected ? "Connected" : "Waiting for first heartbeat..."}
          </span>
        </div>

        <button
          type="button"
          aria-label="Dismiss pairing banner"
          onClick={onDismiss}
          className={ACTION_BTN}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Dismiss
        </button>
      </div>

      <p className="text-[11px] text-slate-600 dark:text-[#9ca3af]">
        One-time token is injected via <code className="font-mono">PAPERWORK_TERMINAL_TOKEN</code> (never passed in CLI
        arguments) and will not be shown again after dismissal.
      </p>

      <pre
        data-pairing-snippet
        className="overflow-x-auto rounded-lg border border-slate-200/90 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 text-slate-100 select-all dark:border-white/[0.08] dark:bg-[#07090d]"
      >
        <code>{daemonSnippet}</code>
      </pre>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-copy-daemon
            onClick={() => void copySnippet("daemon", daemonSnippet)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 text-[11px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          >
            {copiedTarget === "daemon" ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Terminal className="h-3.5 w-3.5" aria-hidden />
            )}
            {copiedTarget === "daemon" ? "Copied daemon command" : "Copy daemon command"}
          </button>

          <button
            type="button"
            data-copy-doctor
            onClick={() => void copySnippet("doctor", doctorSnippet)}
            className={ACTION_BTN}
          >
            {copiedTarget === "doctor" ? (
              <Check className="h-3.5 w-3.5" style={{ color: "var(--openbot-success)" }} aria-hidden />
            ) : (
              <Stethoscope className="h-3.5 w-3.5" aria-hidden />
            )}
            {copiedTarget === "doctor" ? "Copied doctor check" : "Copy doctor command"}
          </button>
        </div>

        <code
          data-doctor-snippet
          className="hidden truncate font-mono text-[10.5px] text-slate-500 sm:inline dark:text-[#8b97ad]"
          title={doctorSnippet}
        >
          <Copy className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
          {doctorSnippet}
        </code>
      </div>
    </div>
  );
}
