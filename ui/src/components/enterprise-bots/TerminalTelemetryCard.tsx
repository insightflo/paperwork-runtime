import { Activity, Clock, Cpu, Gauge, Monitor, Radio, Tag } from "lucide-react";
import type { BotTerminalTransport } from "../../api/enterprise-bots";
import { BotHealthSparkline, type BotHealthSample } from "./BotHealthSparkline";

export interface TerminalTelemetryData {
  transport: BotTerminalTransport | string;
  os?: string | null;
  arch?: string | null;
  daemonVersion?: string | null;
  rttMs?: number | null;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  lastHeartbeatAt?: string | null;
  samples?: BotHealthSample[];
}

export interface TerminalTelemetryCardProps {
  telemetry: TerminalTelemetryData;
  /** Reference epoch ms or ISO timestamp for deterministic age rendering. */
  now?: number | string;
  className?: string;
}

export type HeartbeatFreshness = "fresh" | "stale" | "offline";

export function evaluateHeartbeatAge(
  lastHeartbeatAt: string | null | undefined,
  nowMs: number,
): { ageSeconds: number | null; state: HeartbeatFreshness; label: string } {
  if (!lastHeartbeatAt) {
    return { ageSeconds: null, state: "offline", label: "never · offline" };
  }
  const parsed = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(parsed)) {
    return { ageSeconds: null, state: "offline", label: "unknown · offline" };
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  const formatted =
    ageSeconds < 60
      ? `${ageSeconds}s ago`
      : ageSeconds < 3600
        ? `${Math.floor(ageSeconds / 60)}m ago`
        : `${Math.floor(ageSeconds / 3600)}h ago`;

  if (ageSeconds > 120) {
    return { ageSeconds, state: "offline", label: `${formatted} · offline` };
  }
  if (ageSeconds > 45) {
    return { ageSeconds, state: "stale", label: `${formatted} · stale` };
  }
  return { ageSeconds, state: "fresh", label: formatted };
}

function formatOsArch(os?: string | null, arch?: string | null): string {
  if (os && arch) return `${os}/${arch}`;
  if (os) return os;
  if (arch) return arch;
  return "—";
}

function formatCpuMem(cpuPercent?: number | null, memoryMb?: number | null): string {
  const parts: string[] = [];
  if (cpuPercent != null && Number.isFinite(cpuPercent)) {
    parts.push(`${Math.round(cpuPercent)}%`);
  }
  if (memoryMb != null && Number.isFinite(memoryMb)) {
    parts.push(`${Math.round(memoryMb)}MB`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

const BADGE_BASE =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-200/90 bg-slate-50/80 px-2 py-1 text-[11px] font-medium text-slate-700 dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#cbd5e1]";

export function TerminalTelemetryCard({
  telemetry,
  now,
  className = "",
}: TerminalTelemetryCardProps) {
  const nowMs =
    typeof now === "number" ? now : typeof now === "string" ? Date.parse(now) : Date.now();
  const hb = evaluateHeartbeatAge(telemetry.lastHeartbeatAt, nowMs);
  const samples = telemetry.samples ?? [];

  const hbStyle =
    hb.state === "fresh"
      ? {
          borderColor: "var(--openbot-success)",
          backgroundColor: "var(--openbot-success-soft)",
          color: "var(--openbot-success-text)",
        }
      : hb.state === "stale"
        ? {
            borderColor: "var(--openbot-warning)",
            backgroundColor: "var(--openbot-warning-soft)",
            color: "var(--openbot-warning-text)",
          }
        : {
            borderColor: "var(--openbot-danger)",
            backgroundColor: "var(--openbot-danger-soft)",
            color: "var(--openbot-danger-text)",
          };

  const rttColor =
    telemetry.rttMs == null
      ? undefined
      : telemetry.rttMs > 500
        ? "var(--openbot-warning-text)"
        : "var(--openbot-success-text)";

  return (
    <div
      data-terminal-telemetry-card
      className={`tactile-card space-y-2.5 rounded-xl border border-slate-200/90 bg-white p-3 text-xs tabular-nums dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">
          <Activity className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
          <span>Terminal Telemetry</span>
        </div>

        <span
          data-heartbeat-badge
          data-heartbeat-state={hb.state}
          title={telemetry.lastHeartbeatAt ? `Last heartbeat: ${telemetry.lastHeartbeatAt}` : "No heartbeat received"}
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium"
          style={hbStyle}
        >
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          {hb.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Terminal telemetry metrics">
        <span role="listitem" data-metric="transport" className={BADGE_BASE}>
          <Radio className="h-3 w-3 text-blue-600 dark:text-[#60a5fa]" aria-hidden />
          <span className="font-mono">{telemetry.transport}</span>
        </span>

        <span role="listitem" data-metric="os-arch" className={BADGE_BASE}>
          <Monitor className="h-3 w-3 text-slate-400 dark:text-[#8b97ad]" aria-hidden />
          <span className="font-mono">{formatOsArch(telemetry.os, telemetry.arch)}</span>
        </span>

        <span role="listitem" data-metric="version" className={BADGE_BASE}>
          <Tag className="h-3 w-3 text-slate-400 dark:text-[#8b97ad]" aria-hidden />
          <span className="font-mono">{telemetry.daemonVersion ?? "—"}</span>
        </span>

        <span role="listitem" data-metric="rtt" className={BADGE_BASE}>
          <Gauge className="h-3 w-3 text-slate-400 dark:text-[#8b97ad]" aria-hidden />
          <span className="font-mono font-semibold" style={rttColor ? { color: rttColor } : undefined}>
            {telemetry.rttMs != null && Number.isFinite(telemetry.rttMs)
              ? `${Math.round(telemetry.rttMs)}ms`
              : "—"}
          </span>
        </span>

        <span role="listitem" data-metric="cpu-mem" className={BADGE_BASE}>
          <Cpu className="h-3 w-3 text-slate-400 dark:text-[#8b97ad]" aria-hidden />
          <span className="font-mono">{formatCpuMem(telemetry.cpuPercent, telemetry.memoryMb)}</span>
        </span>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-200/70 pt-2.5 dark:border-white/[0.06]">
        <span className="text-[11px] text-slate-500 dark:text-[#8b97ad]">
          Latency &amp; status ({Math.min(samples.length, 20)}/20)
        </span>
        <BotHealthSparkline samples={samples} slots={20} />
      </div>
    </div>
  );
}
