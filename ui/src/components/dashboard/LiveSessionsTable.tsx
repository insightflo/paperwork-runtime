import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import type { DashboardLiveSession } from "@/api/dashboard";
import { cn, formatCents } from "@/lib/utils";
import { Search } from "lucide-react";

export type LiveSessionRow = DashboardLiveSession & {
  issueTitle?: string | null;
  recentTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  tokensPerHour?: number | null;
  finishedAt?: string | null;
};

export interface LiveSessionsTableProps {
  sessions: LiveSessionRow[];
  loading?: boolean;
  className?: string;
}

type StatusFilter = "all" | "active" | "idle";
type SortKey = "recent" | "total" | "burn" | "latest";

const ACTIVE_STATUSES = new Set(["running", "queued", "in_progress", "active"]);
const FAILED_STATUSES = new Set(["failed", "timed_out", "error", "cancelled"]);
const DONE_STATUSES = new Set(["succeeded", "completed", "done"]);

const PROVIDER_COLORS: Record<string, string> = {
  claude: "#f59e0b",
  anthropic: "#f59e0b",
  codex: "#10b981",
  openai: "#10b981",
  gemini: "#3b82f6",
  google: "#3b82f6",
  pi: "#a855f7",
  hermes: "#06b6d4",
  commandcode: "#84cc16",
};

function isSessionActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status.toLowerCase());
}

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function formatDuration(elapsedSec?: number | null, startedAt?: string | null): string {
  let sec = typeof elapsedSec === "number" && Number.isFinite(elapsedSec) ? Math.max(0, Math.floor(elapsedSec)) : null;
  if (sec === null && startedAt) {
    const startMs = new Date(startedAt).getTime();
    if (Number.isFinite(startMs)) {
      sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    }
  }
  if (sec === null) return "—";
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 ${sec % 60}초`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 ${String(min % 60).padStart(2, "0")}분`;
  const days = Math.floor(hr / 24);
  return `${days}일 ${hr % 24}시간`;
}

function shortModelName(model?: string | null): string {
  if (!model) return "모델 미지정";
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

function providerDotColor(adapterType?: string | null, model?: string | null): string {
  const hay = `${adapterType ?? ""} ${model ?? ""}`.toLowerCase();
  for (const [key, color] of Object.entries(PROVIDER_COLORS)) {
    if (hay.includes(key)) return color;
  }
  return "#64748b";
}

function adapterLabel(adapterType?: string | null): string {
  if (!adapterType) return "agent";
  return adapterType.replace(/_local$/i, "").replace(/-/g, " ");
}

function computeBurnRate(session: LiveSessionRow): number {
  if (typeof session.tokensPerHour === "number" && Number.isFinite(session.tokensPerHour)) {
    return Math.max(0, Math.round(session.tokensPerHour));
  }
  const tokens = Math.max(0, session.recentTokens ?? session.tokens ?? 0);
  if (tokens <= 0) return 0;
  let elapsed = typeof session.elapsedSec === "number" && Number.isFinite(session.elapsedSec) ? session.elapsedSec : null;
  if (elapsed === null && session.startedAt) {
    const ms = Date.now() - new Date(session.startedAt).getTime();
    if (Number.isFinite(ms) && ms > 0) elapsed = ms / 1000;
  }
  if (!elapsed || elapsed < 10) return tokens;
  return Math.round((tokens / elapsed) * 3600);
}

function burnArcColor(ratio: number): string {
  if (ratio >= 0.85) return "#f43f5e";
  if (ratio >= 0.6) return "#f59e0b";
  if (ratio >= 0.25) return "#22c55e";
  return "#84cc16";
}

function MiniBurnGauge({ rate, maxRate }: { rate: number; maxRate: number }) {
  const ratio = rate > 0 && maxRate > 0 ? Math.min(1, Math.max(0.08, rate / maxRate)) : 0;
  // Semicircle radius 10 centered at (14, 13): arc length = pi * 10 ~= 31.416
  const arcLen = Math.PI * 10;
  const dashOffset = arcLen * (1 - ratio);
  const color = burnArcColor(ratio);

  return (
    <svg
      width={28}
      height={16}
      viewBox="0 0 28 16"
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path
        d="M 4 13 A 10 10 0 0 1 24 13"
        fill="none"
        className="stroke-muted-foreground/20 dark:stroke-slate-700/70"
        strokeWidth={2.6}
        strokeLinecap="round"
      />
      {ratio > 0 && (
        <path
          d="M 4 13 A 10 10 0 0 1 24 13"
          fill="none"
          stroke={color}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeDasharray={arcLen}
          strokeDashoffset={dashOffset}
        />
      )}
    </svg>
  );
}

function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  if (ACTIVE_STATUSES.has(normalized)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        </span>
        작업 중
      </span>
    );
  }
  if (FAILED_STATUSES.has(normalized)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/35 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
        실패
      </span>
    );
  }
  if (DONE_STATUSES.has(normalized)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
        완료
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground dark:border-[#242d3f] dark:bg-[#151b28]">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      대기
    </span>
  );
}

export function LiveSessionsTable({
  sessions,
  loading = false,
  className,
}: LiveSessionsTableProps) {
  const [search, setSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortKey>("recent");

  const { activeCount, idleCount } = useMemo(() => {
    let active = 0;
    for (const s of sessions) {
      if (isSessionActive(s.status)) active += 1;
    }
    return { activeCount: active, idleCount: Math.max(0, sessions.length - active) };
  }, [sessions]);

  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.model) set.add(s.model);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const enriched = useMemo(() => {
    return sessions.map((s) => {
      const recentTokens = Math.max(0, s.recentTokens ?? s.tokens ?? 0);
      const totalTokens = Math.max(0, s.totalTokens ?? s.tokens ?? 0);
      const outputTokens = typeof s.outputTokens === "number" && Number.isFinite(s.outputTokens) ? s.outputTokens : null;
      const burnRate = computeBurnRate(s);
      const startedMs = s.startedAt ? new Date(s.startedAt).getTime() : 0;
      return {
        raw: s,
        recentTokens,
        totalTokens,
        outputTokens,
        burnRate,
        startedMs: Number.isFinite(startedMs) ? startedMs : 0,
        active: isSessionActive(s.status),
      };
    });
  }, [sessions]);

  const maxBurnRate = useMemo(() => {
    let max = 0;
    for (const row of enriched) {
      if (row.burnRate > max) max = row.burnRate;
    }
    return max;
  }, [enriched]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched
      .filter((row) => {
        if (statusFilter === "active" && !row.active) return false;
        if (statusFilter === "idle" && row.active) return false;
        if (modelFilter !== "all" && row.raw.model !== modelFilter) return false;
        if (q) {
          const hay = [
            row.raw.agentName,
            row.raw.projectName,
            row.raw.issueIdentifier,
            row.raw.issueTitle,
            row.raw.model,
            row.raw.adapterType,
            row.raw.runId,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "recent") {
          if (b.recentTokens !== a.recentTokens) return b.recentTokens - a.recentTokens;
          return Number(b.active) - Number(a.active);
        }
        if (sortBy === "total") {
          if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
          return Number(b.active) - Number(a.active);
        }
        if (sortBy === "burn") {
          if (b.burnRate !== a.burnRate) return b.burnRate - a.burnRate;
          return Number(b.active) - Number(a.active);
        }
        return b.startedMs - a.startedMs;
      });
  }, [enriched, search, statusFilter, modelFilter, sortBy]);

  if (loading) {
    return (
      <div
        className={cn(
          "rounded-lg border border-border bg-card p-4 dark:border-[#242d3f] dark:bg-[#0f1117]",
          className,
        )}
        aria-busy="true"
        aria-label="실행 중인 세션 로딩 중"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="h-4 w-36 animate-pulse rounded bg-muted" />
          <div className="h-7 w-64 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-2">
          {[0, 1, 2, 3].map((idx) => (
            <div
              key={idx}
              className="h-11 w-full animate-pulse rounded-md border border-border/60 bg-muted/30 dark:border-[#242d3f] dark:bg-[#131823]"
            />
          ))}
        </div>
      </div>
    );
  }

  const selectClass =
    "h-7 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none transition-colors hover:border-foreground/30 focus:border-[#5f8dff] dark:border-[#242d3f] dark:bg-[#131823]";

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card dark:border-[#242d3f] dark:bg-[#0f1117]",
        className,
      )}
    >
      {/* Header & Status Counters */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 dark:border-[#242d3f]">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold tracking-tight text-foreground">실행 중인 세션</h3>
          <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-[10px] font-semibold text-foreground tabular-nums dark:border-[#242d3f] dark:bg-[#151b28]">
            {sessions.length}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 tabular-nums dark:text-emerald-400">
            <span className="relative flex h-1.5 w-1.5">
              {activeCount > 0 && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
            </span>
            작업 중 {activeCount}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/35 px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums dark:border-[#242d3f] dark:bg-[#151b28]">
            대기 중 {idleCount}
          </span>
        </div>

        {/* Filter Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="에이전트, 프로젝트, 이슈, 모델 검색"
              aria-label="에이전트, 프로젝트, 이슈, 모델 검색"
              className="h-7 w-52 rounded-md border border-border bg-background pl-7 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground/75 outline-none transition-colors focus:border-[#5f8dff] dark:border-[#242d3f] dark:bg-[#131823]"
            />
          </div>

          <select
            aria-label="모델 필터"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className={selectClass}
          >
            <option value="all">모든 모델</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {shortModelName(m)}
              </option>
            ))}
          </select>

          <select
            aria-label="상태 필터"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className={selectClass}
          >
            <option value="all">모든 상태</option>
            <option value="active">작업 중</option>
            <option value="idle">완료·대기</option>
          </select>

          <select
            aria-label="정렬 기준"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className={selectClass}
          >
            <option value="recent">최근 토큰순</option>
            <option value="total">전체 누적순</option>
            <option value="burn">소진 속도순</option>
            <option value="latest">최신순</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center text-xs text-muted-foreground">
          <p className="font-medium text-foreground/80">
            {sessions.length === 0 ? "활성 또는 최근 실행 세션이 없습니다." : "검색·필터 조건에 맞는 세션이 없습니다."}
          </p>
          <p className="text-[11px] text-muted-foreground/80">
            {sessions.length === 0
              ? "에이전트가 작업을 시작하면 토큰 소비와 소진 속도가 실시간으로 표시됩니다."
              : "필터를 초기화하거나 다른 키워드로 검색해 보세요."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs tabular-nums">
            <thead>
              <tr className="border-b border-border/80 bg-muted/25 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground dark:border-[#242d3f] dark:bg-[#111520]">
                <th className="px-4 py-2">상태</th>
                <th className="px-3 py-2">실행 위치 · 프로젝트 / 이슈</th>
                <th className="px-3 py-2">AI 도구 · 모델</th>
                <th className="px-3 py-2 text-right">최근 윈도우</th>
                <th className="px-3 py-2 text-right">누적 토큰</th>
                <th className="px-3 py-2 text-right">소진 속도</th>
                <th className="px-4 py-2 text-right">경과 시간</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 dark:divide-[#242d3f]/70">
              {filtered.map(({ raw, recentTokens, totalTokens, outputTokens, burnRate }) => {
                const targetHref = raw.issueId
                  ? `/issues/${raw.issueIdentifier ?? raw.issueId}`
                  : `/agents/${raw.agentId}/runs/${raw.runId}`;
                const dotColor = providerDotColor(raw.adapterType, raw.model);
                const costCents = typeof raw.costCents === "number" && Number.isFinite(raw.costCents) ? raw.costCents : 0;

                return (
                  <tr
                    key={raw.runId}
                    data-session-row={raw.runId}
                    className="transition-colors hover:bg-accent/35 dark:hover:bg-[#151b28]/70"
                  >
                    {/* Status */}
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StatusPill status={raw.status} />
                    </td>

                    {/* Execution location / Project & Issue */}
                    <td className="max-w-[20rem] px-3 py-2.5">
                      <Link
                        to={targetHref}
                        className="group block min-w-0 no-underline text-inherit"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {raw.issueIdentifier && (
                            <span className="shrink-0 rounded border border-border/80 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground dark:border-[#242d3f] dark:bg-[#151b28]">
                              {raw.issueIdentifier}
                            </span>
                          )}
                          <span className="truncate font-medium text-foreground group-hover:text-[#5f8dff] transition-colors">
                            {raw.issueTitle ?? raw.agentName}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-muted-foreground">
                          <span className="truncate">{raw.agentName}</span>
                          {raw.projectName && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="truncate text-foreground/75">{raw.projectName}</span>
                            </>
                          )}
                        </div>
                      </Link>
                    </td>

                    {/* AI Tool / Model */}
                    <td className="max-w-[14rem] px-3 py-2.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: dotColor }}
                        />
                        <span className="truncate font-medium text-foreground">
                          {adapterLabel(raw.adapterType)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={raw.model ?? undefined}>
                        {shortModelName(raw.model)}
                      </p>
                    </td>

                    {/* Recent Window Tokens */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <p className="font-mono font-semibold text-foreground">
                        {formatCompactTokens(recentTokens)}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {outputTokens !== null ? `출력 ${formatCompactTokens(outputTokens)}` : "윈도우 합계"}
                      </p>
                    </td>

                    {/* Total Run Tokens */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <p className="font-mono font-semibold text-foreground">
                        {formatCompactTokens(totalTokens)}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {costCents > 0 ? formatCents(costCents) : "$0.00"}
                      </p>
                    </td>

                    {/* Burn Rate with compact SVG mini-arc */}
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <MiniBurnGauge rate={burnRate} maxRate={maxBurnRate} />
                        <div className="text-right">
                          <p className="font-mono font-semibold text-foreground">
                            {formatCompactTokens(burnRate)}
                          </p>
                          <p className="text-[9.5px] text-muted-foreground">tokens/시간</p>
                        </div>
                      </div>
                    </td>

                    {/* Elapsed Duration */}
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-[11px] text-muted-foreground">
                      {formatDuration(raw.elapsedSec, raw.startedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
