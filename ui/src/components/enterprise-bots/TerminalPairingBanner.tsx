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
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[11px] font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-accent";
const PRIMARY_BTN =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90";
const CODE_BLOCK =
  "overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-5 text-foreground select-all";
const STEP_INDEX =
  "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-[11px] font-semibold text-muted-foreground";

/** Numbered connection sheet: 1. 토큰 복사 → 2. 노드에서 실행 → 3. 신호 확인 */
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
      className={`tactile-card space-y-3 rounded-xl border bg-card p-4 text-xs tabular-nums ${
        connected ? "border-emerald-500/35" : "border-amber-500/40"
      } ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span className="truncate text-sm font-semibold text-foreground">
            노드 연결 <span className="font-mono text-xs">{terminalName}</span>
          </span>
          <span
            data-heartbeat-indicator
            title={connected ? `연결됨 · 마지막 신호 ${lastSeenAt}` : "노드의 첫 하트비트를 기다리는 중"}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              connected
                ? "border-emerald-500/40 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300"
                : "border-amber-500/40 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "bg-emerald-600 dark:bg-emerald-400" : "animate-pulse bg-amber-600 dark:bg-amber-400"
              }`}
            />
            {connected ? "연결됨" : "첫 신호 대기 중…"}
          </span>
        </div>

        <button type="button" aria-label="연결 안내 닫기" onClick={onDismiss} className={ACTION_BTN}>
          <X className="h-3.5 w-3.5" aria-hidden />
          닫기
        </button>
      </div>

      <ol className="space-y-3" aria-label="노드 연결 절차">
        <li data-pairing-step="1" className="flex gap-3">
          <span className={STEP_INDEX} aria-hidden>
            1
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-semibold text-foreground">토큰 복사</p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              아래 명령을 복사하세요. 토큰은 <code className="font-mono">PAPERWORK_TERMINAL_TOKEN</code> 환경 변수로만
              전달되며 CLI 인자에는 노출되지 않습니다. 이 안내를 닫은 뒤에는 다시 표시되지 않습니다.
            </p>
            <pre data-pairing-snippet className={CODE_BLOCK}>
              <code>{daemonSnippet}</code>
            </pre>
            <button
              type="button"
              data-copy-daemon
              onClick={() => void copySnippet("daemon", daemonSnippet)}
              className={PRIMARY_BTN}
            >
              {copiedTarget === "daemon" ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Terminal className="h-3.5 w-3.5" aria-hidden />
              )}
              {copiedTarget === "daemon" ? "복사됨" : "연결 명령 복사"}
            </button>
          </div>
        </li>

        <li data-pairing-step="2" className="flex gap-3">
          <span className={STEP_INDEX} aria-hidden>
            2
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">노드에서 실행</p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              연결할 노드의 터미널에 붙여넣어 실행하세요. 데몬이 이 서버에 접속해 대기합니다.
            </p>
          </div>
        </li>

        <li data-pairing-step="3" className="flex gap-3">
          <span
            className={`${STEP_INDEX} ${
              connected ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : ""
            }`.trim()}
            aria-hidden
          >
            {connected ? <Check className="h-3 w-3" /> : "3"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">신호 확인</p>
            <p className="text-[11px] leading-4 text-muted-foreground">
              첫 하트비트가 도착하면 위 상태가 <span className="font-medium text-foreground">연결됨</span>으로 바뀝니다.
              접속이 지연되면 진단 명령으로 경로를 확인하세요.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-copy-doctor
                onClick={() => void copySnippet("doctor", doctorSnippet)}
                className={ACTION_BTN}
              >
                {copiedTarget === "doctor" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                ) : (
                  <Stethoscope className="h-3.5 w-3.5" aria-hidden />
                )}
                {copiedTarget === "doctor" ? "복사됨" : "진단 명령 복사"}
              </button>
              <code
                data-doctor-snippet
                className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground"
                title={doctorSnippet}
              >
                <Copy className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />
                {doctorSnippet}
              </code>
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}
