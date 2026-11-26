import { useId } from "react";
import { Link } from "@/lib/router";
import { ArrowUpRight, Activity, Cpu, Clock, Radio } from "lucide-react";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { cn, formatCents, formatTokens, relativeTime } from "@/lib/utils";

export interface AgentLiveRunSummary {
  runId: string;
  liveCount: number;
  status?: string;
  startedAt?: string | null;
  triggerDetail?: string | null;
  invocationSource?: string | null;
  issueId?: string | null;
}

export interface AgentUsageSummary {
  tokens: number;
  costCents: number;
  runs: number;
  sharePct: number;
}

export type TelemetryTone = "lime" | "cobalt" | "amber" | "rose" | "neutral";

export interface BudgetMetrics {
  hasBudget: boolean;
  spentCents: number;
  budgetCents: number;
  utilizationPct: number | null;
  filledDots: number;
  tone: TelemetryTone;
}

export interface AgentTelemetryCardProps {
  agent: Agent;
  roleLabel: string;
  adapterLabel: string;
  detailHref: string;
  liveRun?: AgentLiveRunSummary;
  liveRunHref?: string;
  recentRuns?: HeartbeatRun[];
  usageShare?: AgentUsageSummary | null;
  onSelect?: (agent: Agent) => void;
  className?: string;
}

export type TelemetryStatusFilter = "all" | "running" | "idle" | "attention";

export interface TelemetryFilterOptions {
  status: TelemetryStatusFilter;
  query: string;
  adapter: string;
  role: string;
  showTerminated: boolean;
  liveAgentIds?: ReadonlySet<string>;
  roleLabels?: Readonly<Record<string, string>>;
  adapterLabels?: Readonly<Record<string, string>>;
}

const DOT_COUNT = 20;

const STATUS_META: Record<
  string,
  { label: string; tone: TelemetryTone; pulse: boolean }
> = {
  running: { label: "실행 중", tone: "lime", pulse: true },
  active: { label: "활성", tone: "cobalt", pulse: false },
  idle: { label: "대기", tone: "amber", pulse: false },
  paused: { label: "일시정지", tone: "amber", pulse: false },
  pending_approval: { label: "승인 대기", tone: "amber", pulse: false },
  error: { label: "오류", tone: "rose", pulse: false },
  terminated: { label: "종료", tone: "neutral", pulse: false },
};

const TONE_HEX: Record<TelemetryTone, { stroke: string; glow: string }> = {
  lime: { stroke: "#a3e635", glow: "rgba(163, 230, 53, 0.42)" },
  cobalt: { stroke: "#60a5fa", glow: "rgba(96, 165, 250, 0.35)" },
  amber: { stroke: "#f59e0b", glow: "rgba(245, 158, 11, 0.35)" },
  rose: { stroke: "#fb7185", glow: "rgba(251, 113, 133, 0.38)" },
  neutral: { stroke: "#627089", glow: "rgba(98, 112, 137, 0.25)" },
};

const TONE_BADGE_CLASSES: Record<TelemetryTone, string> = {
  lime: "border-lime-500/30 bg-lime-500/12 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/14 dark:text-[#a3e635]",
  cobalt: "border-blue-500/30 bg-blue-500/12 text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/14 dark:text-[#60a5fa]",
  amber: "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/15 dark:text-[#f59e0b]",
  rose: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:border-[#fb7185]/30 dark:bg-[#fb7185]/14 dark:text-[#fb7185]",
  neutral: "border-border bg-muted text-muted-foreground dark:border-white/10 dark:bg-white/5 dark:text-[#9aa7bd]",
};

const TONE_DOT_CLASSES: Record<TelemetryTone, string> = {
  lime: "bg-lime-500 dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.55)]",
  cobalt: "bg-blue-500 dark:bg-[#60a5fa] dark:shadow-[0_0_8px_rgba(96,165,250,0.45)]",
  amber: "bg-amber-500 dark:bg-[#f59e0b] dark:shadow-[0_0_8px_rgba(245,158,11,0.45)]",
  rose: "bg-rose-500 dark:bg-[#fb7185] dark:shadow-[0_0_8px_rgba(251,113,133,0.45)]",
  neutral: "bg-slate-400 dark:bg-[#627089]",
};

export function extractAgentModel(agent: Agent): string | null {
  const sources = [agent.adapterConfig, agent.agentConfig, agent.runtimeConfig];
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of ["model", "modelId", "defaultModel"]) {
      const value = src[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return null;
}

export function extractRunTokens(run: HeartbeatRun): number {
  const payloads = [run.usageJson, run.resultJson];
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    const total = payload.totalTokens ?? payload.total_tokens;
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      return Math.round(total);
    }
    const input = Number(payload.inputTokens ?? payload.input_tokens ?? 0);
    const output = Number(payload.outputTokens ?? payload.output_tokens ?? 0);
    const cached = Number(payload.cachedInputTokens ?? payload.cached_input_tokens ?? 0);
    const sum = input + output + cached;
    if (Number.isFinite(sum) && sum > 0) {
      return Math.round(sum);
    }
  }
  return 0;
}

export function computeBudgetMetrics(
  spentMonthlyCents: number,
  budgetMonthlyCents: number,
): BudgetMetrics {
  const spent = Math.max(0, Number.isFinite(spentMonthlyCents) ? spentMonthlyCents : 0);
  const budget = Math.max(0, Number.isFinite(budgetMonthlyCents) ? budgetMonthlyCents : 0);
  if (budget <= 0) {
    return {
      hasBudget: false,
      spentCents: spent,
      budgetCents: 0,
      utilizationPct: null,
      filledDots: 0,
      tone: "neutral",
    };
  }

  const rawPct = (spent / budget) * 100;
  const utilizationPct = Math.round(rawPct);
  const clampedPct = Math.min(100, Math.max(0, rawPct));
  const filledDots = spent > 0 ? Math.max(1, Math.round((clampedPct / 100) * DOT_COUNT)) : 0;
  const tone: TelemetryTone =
    rawPct >= 95 ? "rose" : rawPct >= 75 ? "amber" : rawPct > 0 ? "lime" : "cobalt";

  return {
    hasBudget: true,
    spentCents: spent,
    budgetCents: budget,
    utilizationPct,
    filledDots: Math.min(DOT_COUNT, filledDots),
    tone,
  };
}

export function buildActivitySparklinePoints(recentRuns: HeartbeatRun[]): number[] {
  if (!recentRuns || recentRuns.length === 0) return [];
  const chronological = [...recentRuns]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-14);

  const tokenValues = chronological.map((run) => extractRunTokens(run));
  const hasTokenData = tokenValues.some((v) => v > 0);
  if (hasTokenData) {
    return tokenValues;
  }

  // Fallback to actual run duration (seconds) when token counts are absent on runs
  return chronological.map((run) => {
    if (run.startedAt && run.finishedAt) {
      const sec = Math.max(
        1,
        Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000),
      );
      return sec;
    }
    return run.status === "failed" || run.status === "timed_out" ? 2 : 1;
  });
}

export function computeRunSuccessRate(recentRuns: HeartbeatRun[]): number | null {
  if (!recentRuns || recentRuns.length === 0) return null;
  const finished = recentRuns.filter(
    (r) => r.status === "succeeded" || r.status === "failed" || r.status === "timed_out",
  );
  if (finished.length === 0) return null;
  const succeeded = finished.filter((r) => r.status === "succeeded").length;
  return Math.round((succeeded / finished.length) * 100);
}

export function filterTelemetryAgents(
  agents: Agent[],
  opts: TelemetryFilterOptions,
): Agent[] {
  const q = opts.query.trim().toLowerCase();
  return agents.filter((agent) => {
    if (agent.status === "terminated" && !opts.showTerminated) return false;

    const isLive = opts.liveAgentIds?.has(agent.id) ?? false;
    if (opts.status === "running") {
      if (agent.status !== "running" && agent.status !== "active" && !isLive) return false;
    } else if (opts.status === "idle") {
      if (agent.status !== "idle") return false;
    } else if (opts.status === "attention") {
      if (
        agent.status !== "error" &&
        agent.status !== "paused" &&
        agent.status !== "pending_approval"
      ) {
        return false;
      }
    }

    if (opts.adapter !== "all" && agent.adapterType !== opts.adapter) return false;
    if (opts.role !== "all" && agent.role !== opts.role) return false;

    if (q.length > 0) {
      const model = extractAgentModel(agent) ?? "";
      const roleText = opts.roleLabels?.[agent.role] ?? agent.role;
      const adapterText = opts.adapterLabels?.[agent.adapterType] ?? agent.adapterType;
      const haystack = [
        agent.name,
        agent.title ?? "",
        roleText,
        adapterText,
        agent.adapterType,
        model,
        agent.status.replace("_", " "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

function getInitials(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9가-힣]+/g, " ").trim();
  if (!cleaned) return "AG";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

function formatRunStatusKorean(status: string): string {
  switch (status) {
    case "running":
      return "실행 중";
    case "queued":
      return "대기열";
    case "succeeded":
      return "성공";
    case "failed":
      return "실패";
    case "timed_out":
      return "시간 초과";
    case "cancelled":
      return "취소됨";
    default:
      return status;
  }
}

function ActivitySparkline({
  points,
  tone,
}: {
  points: number[];
  tone: TelemetryTone;
}) {
  const gradId = useId();
  const width = 220;
  const height = 34;
  const hex = TONE_HEX[tone].stroke;

  if (points.length === 0) {
    return (
      <div
        data-testid="agent-sparkline-empty"
        className="flex h-[34px] items-center justify-between rounded-md border border-dashed border-border/70 bg-muted/30 px-2.5 text-[10.5px] text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#627089]"
      >
        <span>최근 실행 기록 없음</span>
        <span className="font-mono text-[10px]">—</span>
      </div>
    );
  }

  const normalized = points.length === 1 ? [points[0]!, points[0]!] : points;
  const max = Math.max(...normalized);
  const min = Math.min(...normalized);
  const range = max - min || 1;
  const coords = normalized.map((val, idx) => {
    const x = (idx / (normalized.length - 1)) * width;
    const y = height - 4 - ((val - min) / range) * (height - 10);
    return [x, y] as const;
  });

  const linePath = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${width} ${height} L0 ${height} Z`;
  const last = coords[coords.length - 1]!;

  return (
    <svg
      data-testid="agent-sparkline-svg"
      className="block h-[34px] w-full overflow-visible"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label="에이전트 활동 추이 스파크라인"
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={hex} stopOpacity="0.32" />
          <stop offset="100%" stopColor={hex} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={hex}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={last[0]}
        cy={last[1]}
        r="3"
        fill={hex}
        stroke="currentColor"
        className="text-background dark:text-[#0e131d]"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MiniRadialMeter({
  pct,
  label,
  tone,
}: {
  pct: number | null;
  label: string;
  tone: TelemetryTone;
}) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const dash = ((circumference * clamped) / 100).toFixed(1);
  const hex = TONE_HEX[tone].stroke;

  return (
    <div
      data-testid="agent-radial-meter"
      className="relative flex h-14 w-14 shrink-0 items-center justify-center"
      aria-label={`${label} ${pct === null ? "데이터 없음" : `${pct}%`}`}
    >
      <svg width="56" height="56" viewBox="0 0 56 56" className="-rotate-90">
        <circle
          cx="28"
          cy="28"
          r={radius}
          fill="none"
          stroke="currentColor"
          className="text-border dark:text-white/[0.08]"
          strokeWidth="5"
        />
        <circle
          cx="28"
          cy="28"
          r={radius}
          fill="none"
          stroke={hex}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference.toFixed(1)}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center leading-none">
        <span className="font-mono text-xs font-bold tabular-nums text-foreground dark:text-[#eef2f8]">
          {pct === null ? "—" : `${pct}%`}
        </span>
        <span className="mt-0.5 text-[9px] font-medium text-muted-foreground dark:text-[#627089]">
          {label}
        </span>
      </div>
    </div>
  );
}

export function AgentTelemetryCard({
  agent,
  roleLabel,
  adapterLabel,
  detailHref,
  liveRun,
  liveRunHref,
  recentRuns = [],
  usageShare = null,
  onSelect,
  className,
}: AgentTelemetryCardProps) {
  const isLive = Boolean(liveRun) || agent.status === "running";
  const statusMeta = STATUS_META[agent.status] ?? {
    label: agent.status,
    tone: "neutral" as TelemetryTone,
    pulse: false,
  };
  const effectiveTone: TelemetryTone = isLive ? "lime" : statusMeta.tone;
  const model = extractAgentModel(agent);
  const budget = computeBudgetMetrics(agent.spentMonthlyCents, agent.budgetMonthlyCents);
  const sparkPoints = buildActivitySparklinePoints(recentRuns);
  const successRate = computeRunSuccessRate(recentRuns);

  // Radial meter shows budget utilization when budget is configured, else recent run success rate
  const radialPct = budget.hasBudget ? budget.utilizationPct : successRate;
  const radialLabel = budget.hasBudget ? "예산" : successRate !== null ? "성공률" : "대기";
  const radialTone: TelemetryTone = budget.hasBudget
    ? budget.tone
    : successRate !== null
      ? successRate >= 85
        ? "lime"
        : successRate >= 60
          ? "amber"
          : "rose"
      : "neutral";

  // 20-dot bar shows budget utilization when configured, else run success ratio when runs exist
  const dotBarFilled = budget.hasBudget
    ? budget.filledDots
    : successRate !== null
      ? Math.round((successRate / 100) * DOT_COUNT)
      : 0;
  const dotBarLabel = budget.hasBudget
    ? `${formatCents(budget.spentCents)} / ${formatCents(budget.budgetCents)}`
    : budget.spentCents > 0
      ? `${formatCents(budget.spentCents)} · 한도 없음`
      : successRate !== null
        ? `성공 ${successRate}%`
        : "예산 미설정";

  const totalRecentTokens = recentRuns.reduce((sum, r) => sum + extractRunTokens(r), 0);
  const displayTokens = usageShare?.tokens ?? totalRecentTokens;
  const latestRun = recentRuns.length > 0 ? recentRuns[0] : null;
  const heartbeatText = agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "기록 없음";

  return (
    <article
      data-testid="agent-telemetry-card"
      data-agent-id={agent.id}
      data-agent-status={agent.status}
      className={cn(
        "group relative flex min-w-0 flex-col justify-between gap-3 rounded-xl border p-4 tabular-nums transition-all duration-150",
        "border-border bg-card text-card-foreground shadow-sm hover:border-foreground/20 hover:shadow-md",
        "dark:border-white/[0.075] dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.095),0_10px_28px_-18px_rgba(0,0,0,0.85)] dark:hover:border-white/[0.16] dark:hover:bg-[#121826]",
        isLive && "dark:border-[#a3e635]/28",
        className,
      )}
    >
      {/* Header: Status dot + Name + Role/Title + Adapter/Model chip */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={cn(
              "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-xs font-bold tracking-tight",
              "border-border bg-muted/60 text-foreground dark:border-white/10 dark:bg-[#161e2e] dark:text-[#eef2f8]",
              isLive && "dark:border-[#a3e635]/35",
            )}
          >
            {getInitials(agent.name)}
            <span
              data-testid="agent-status-dot"
              data-live={isLive ? "true" : "false"}
              className={cn(
                "absolute -right-1 -top-1 flex h-2.5 w-2.5 rounded-full ring-2 ring-card dark:ring-[#0e131d]",
                TONE_DOT_CLASSES[effectiveTone],
                (isLive || statusMeta.pulse) && "animate-pulse",
              )}
            />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Link
                to={detailHref}
                onClick={() => onSelect?.(agent)}
                className="truncate text-sm font-semibold tracking-tight text-foreground no-underline transition-colors hover:text-primary dark:text-[#eef2f8] dark:hover:text-[#a3e635]"
              >
                {agent.name}
              </Link>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                  TONE_BADGE_CLASSES[effectiveTone],
                )}
              >
                {isLive && (
                  <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                )}
                {isLive ? "실행 중" : statusMeta.label}
              </span>
            </div>

            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground dark:text-[#9aa7bd]">
              <span className="truncate font-medium">{roleLabel}</span>
              {agent.title && (
                <>
                  <span aria-hidden className="text-border dark:text-white/20">·</span>
                  <span className="truncate">{agent.title}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Adapter + Model chip */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="inline-flex max-w-[160px] items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#9aa7bd]">
            <Cpu className="h-3 w-3 shrink-0 opacity-75" aria-hidden />
            <span className="truncate">{adapterLabel}</span>
          </span>
          {model && (
            <span
              title={model}
              className="max-w-[160px] truncate font-mono text-[10px] text-muted-foreground/80 dark:text-[#627089]"
            >
              {model}
            </span>
          )}
        </div>
      </div>

      {/* Telemetry Body: Sparkline + Key Metric (left) & Mini Radial Meter (right) */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 dark:border-white/[0.06] dark:bg-[#090c12]/70">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="font-mono text-base font-bold leading-none tabular-nums text-foreground dark:text-[#eef2f8]">
                {displayTokens > 0
                  ? formatTokens(displayTokens)
                  : budget.spentCents > 0
                    ? formatCents(budget.spentCents)
                    : recentRuns.length > 0
                      ? String(recentRuns.length)
                      : "—"}
              </span>
              <span className="truncate text-[10.5px] font-medium text-muted-foreground dark:text-[#627089]">
                {displayTokens > 0
                  ? "토큰"
                  : budget.spentCents > 0
                    ? "월 누적"
                    : recentRuns.length > 0
                      ? "최근 실행"
                      : "활동 대기"}
              </span>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground dark:text-[#627089]">
              {recentRuns.length > 0 ? `최근 ${recentRuns.length}회` : "활동 없음"}
            </span>
          </div>

          <ActivitySparkline points={sparkPoints} tone={effectiveTone} />
        </div>

        <MiniRadialMeter pct={radialPct} label={radialLabel} tone={radialTone} />
      </div>

      {/* 20-Dot Budget / Utilization Bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-[10.5px]">
          <span className="font-medium text-muted-foreground dark:text-[#9aa7bd]">
            {budget.hasBudget ? "월 예산 사용률" : "실행 상태 / 비용"}
          </span>
          <span className="font-mono text-[10.5px] font-medium tabular-nums text-foreground dark:text-[#eef2f8]">
            {dotBarLabel}
          </span>
        </div>
        <div
          data-testid="agent-dot-bar"
          data-filled-dots={dotBarFilled}
          className="flex items-center gap-[3px]"
          aria-label={`사용률 바 ${dotBarFilled} / ${DOT_COUNT}`}
        >
          {Array.from({ length: DOT_COUNT }, (_, idx) => {
            const filled = idx < dotBarFilled;
            const dotToneClass = !filled
              ? "bg-border/70 dark:bg-white/[0.08]"
              : idx >= 17
                ? "bg-rose-500 dark:bg-[#fb7185] dark:shadow-[0_0_6px_rgba(251,113,133,0.45)]"
                : idx >= 14
                  ? "bg-amber-500 dark:bg-[#f59e0b]"
                  : "bg-lime-500 dark:bg-[#a3e635] dark:shadow-[0_0_6px_rgba(163,230,53,0.45)]";
            return (
              <span
                key={idx}
                data-filled={filled ? "true" : "false"}
                className={cn("h-1.5 flex-1 rounded-[2px] transition-colors", dotToneClass)}
              />
            );
          })}
          <span className="ml-1.5 shrink-0 font-mono text-[10px] font-semibold tabular-nums text-muted-foreground dark:text-[#9aa7bd]">
            {dotBarFilled}/{DOT_COUNT}
          </span>
        </div>
      </div>

      {/* Current Work Footer: Live Run / Recent Status + Heartbeat + 1-Click Detail Jump */}
      <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2.5 text-[11px] dark:border-white/[0.065]">
        <div className="flex min-w-0 items-center gap-2">
          {liveRun && liveRunHref ? (
            <Link
              to={liveRunHref}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-lime-500/35 bg-lime-500/12 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-lime-700 no-underline transition-colors hover:bg-lime-500/20 dark:border-[#a3e635]/35 dark:bg-[#a3e635]/14 dark:text-[#a3e635] dark:hover:bg-[#a3e635]/22"
            >
              <Radio className="h-3 w-3 animate-pulse" aria-hidden />
              <span>
                LIVE{liveRun.liveCount > 1 ? ` (${liveRun.liveCount})` : ""}
              </span>
            </Link>
          ) : latestRun ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground dark:text-[#9aa7bd]">
              <Activity className="h-3 w-3 opacity-75" aria-hidden />
              <span>최근: {formatRunStatusKorean(latestRun.status)}</span>
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground dark:text-[#627089]">
              <Activity className="h-3 w-3 opacity-60" aria-hidden />
              <span>대기 중</span>
            </span>
          )}

          <span
            className="inline-flex min-w-0 items-center gap-1 truncate text-muted-foreground dark:text-[#627089]"
            title={
              agent.lastHeartbeatAt
                ? new Date(agent.lastHeartbeatAt).toLocaleString()
                : undefined
            }
          >
            <Clock className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{heartbeatText}</span>
          </span>
        </div>

        <Link
          to={detailHref}
          onClick={() => onSelect?.(agent)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-[11px] font-semibold text-foreground no-underline transition-colors hover:border-foreground/25 hover:bg-muted dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-[#eef2f8] dark:hover:border-[#a3e635]/40 dark:hover:text-[#a3e635]"
        >
          <span>상세</span>
          <ArrowUpRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
    </article>
  );
}
