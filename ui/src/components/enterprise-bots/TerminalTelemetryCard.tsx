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

function formatAgeKorean(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}초 전`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}분 전`;
  return `${Math.floor(ageSeconds / 3600)}시간 전`;
}

export function evaluateHeartbeatAge(
  lastHeartbeatAt: string | null | undefined,
  nowMs: number,
): { ageSeconds: number | null; state: HeartbeatFreshness; label: string } {
  if (!lastHeartbeatAt) {
    return { ageSeconds: null, state: "offline", label: "오프라인 · 신호 없음" };
  }
  const parsed = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(parsed)) {
    return { ageSeconds: null, state: "offline", label: "오프라인 · 시각 미상" };
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  const formatted = formatAgeKorean(ageSeconds);

  if (ageSeconds > 120) {
    return { ageSeconds, state: "offline", label: `오프라인 · ${formatted}` };
  }
  if (ageSeconds > 45) {
    return { ageSeconds, state: "stale", label: `지연 · ${formatted}` };
  }
  return { ageSeconds, state: "fresh", label: `정상 · ${formatted}` };
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
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[11px] font-medium text-muted-foreground";

const HEARTBEAT_BADGE: Record<HeartbeatFreshness, string> = {
  fresh: "border-emerald-500/40 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300",
  stale: "border-amber-500/40 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300",
  offline: "border-rose-500/40 bg-rose-50 text-rose-800 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300",
};

export function TerminalTelemetryCard({
  telemetry,
  now,
  className = "",
}: TerminalTelemetryCardProps) {
  const nowMs =
    typeof now === "number" ? now : typeof now === "string" ? Date.parse(now) : Date.now();
  const hb = evaluateHeartbeatAge(telemetry.lastHeartbeatAt, nowMs);
  const samples = telemetry.samples ?? [];

  const rttTone =
    telemetry.rttMs == null
      ? undefined
      : telemetry.rttMs > 500
        ? "text-amber-700 dark:text-amber-400"
        : "text-emerald-700 dark:text-emerald-400";

  return (
    <div
      data-terminal-telemetry-card
      className={`tactile-card space-y-2.5 rounded-xl border border-border bg-card p-3 text-xs tabular-nums ${className}`.trim()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span>노드 상태</span>
        </div>

        <span
          data-heartbeat-badge
          data-heartbeat-state={hb.state}
          title={telemetry.lastHeartbeatAt ? `마지막 하트비트: ${telemetry.lastHeartbeatAt}` : "하트비트 없음"}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${HEARTBEAT_BADGE[hb.state]}`}
        >
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          {hb.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="노드 상세 지표">
        <span role="listitem" data-metric="transport" className={BADGE_BASE}>
          <Radio className="h-3 w-3 text-primary" aria-hidden />
          <span className="font-mono">{telemetry.transport}</span>
        </span>

        <span role="listitem" data-metric="os-arch" className={BADGE_BASE}>
          <Monitor className="h-3 w-3" aria-hidden />
          <span className="font-mono">{formatOsArch(telemetry.os, telemetry.arch)}</span>
        </span>

        <span role="listitem" data-metric="version" className={BADGE_BASE}>
          <Tag className="h-3 w-3" aria-hidden />
          <span className="font-mono">{telemetry.daemonVersion ?? "—"}</span>
        </span>

        <span role="listitem" data-metric="rtt" className={BADGE_BASE}>
          <Gauge className="h-3 w-3" aria-hidden />
          <span className={`font-mono font-semibold ${rttTone ?? ""}`.trim()}>
            {telemetry.rttMs != null && Number.isFinite(telemetry.rttMs)
              ? `${Math.round(telemetry.rttMs)}ms`
              : "—"}
          </span>
        </span>

        <span role="listitem" data-metric="cpu-mem" className={BADGE_BASE}>
          <Cpu className="h-3 w-3" aria-hidden />
          <span className="font-mono">{formatCpuMem(telemetry.cpuPercent, telemetry.memoryMb)}</span>
        </span>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
        <span className="text-[11px] text-muted-foreground">지연 추이 ({Math.min(samples.length, 20)}/20)</span>
        <BotHealthSparkline samples={samples} slots={20} />
      </div>
    </div>
  );
}
