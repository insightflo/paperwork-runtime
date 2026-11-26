import { useMemo, useState, type RefObject } from "react";
import type { MissionListItem } from "../../api/missions";
import { Search, X } from "lucide-react";

export type RadarStatusBucket = "all" | "need" | "run" | "wait" | "done";
export type MissionRadarBucket = Exclude<RadarStatusBucket, "all">;

export const RADAR_PRIORITY: Record<MissionRadarBucket, number> = {
  need: 0,
  run: 1,
  wait: 2,
  done: 3,
};

export interface RadarBucketMeta {
  key: RadarStatusBucket;
  label: string;
  dotClass: string;
  activeChipClass: string;
}

export const RADAR_CHIPS: readonly RadarBucketMeta[] = [
  {
    key: "all",
    label: "전체",
    dotClass: "bg-slate-400 dark:bg-slate-300",
    activeChipClass:
      "border-slate-400/70 bg-slate-900 text-white dark:border-white/30 dark:bg-white/12 dark:text-white",
  },
  {
    key: "need",
    label: "개입 필요",
    dotClass: "bg-[#f43f5e] shadow-[0_0_8px_rgba(244,63,94,0.8)]",
    activeChipClass:
      "border-[#f43f5e]/60 bg-[#f43f5e]/15 text-rose-700 dark:text-[#ffb3c1] dark:shadow-[0_0_14px_-4px_rgba(244,63,94,0.75)]",
  },
  {
    key: "run",
    label: "실행 중",
    dotClass: "bg-[#a3e635] shadow-[0_0_8px_rgba(163,230,53,0.75)]",
    activeChipClass:
      "border-[#a3e635]/60 bg-[#a3e635]/15 text-lime-800 dark:text-[#d9f99d] dark:shadow-[0_0_14px_-4px_rgba(163,230,53,0.7)]",
  },
  {
    key: "wait",
    label: "대기",
    dotClass: "bg-[#f59e0b] shadow-[0_0_7px_rgba(245,158,11,0.7)]",
    activeChipClass:
      "border-[#f59e0b]/60 bg-[#f59e0b]/15 text-amber-800 dark:text-[#fde68a] dark:shadow-[0_0_14px_-4px_rgba(245,158,11,0.65)]",
  },
  {
    key: "done",
    label: "완료",
    dotClass: "bg-[#60a5fa]",
    activeChipClass:
      "border-[#60a5fa]/60 bg-[#60a5fa]/15 text-blue-800 dark:text-[#c7dcff] dark:shadow-[0_0_14px_-4px_rgba(96,165,250,0.65)]",
  },
];

export const MOSAIC_TILE_CLASS: Record<MissionRadarBucket, string> = {
  need: "border-[#f43f5e]/75 bg-[#f43f5e]/20 text-rose-800 dark:text-[#ffc2cc] animate-pulse",
  run: "border-[#a3e635]/45 bg-[#a3e635]/15 text-lime-900 dark:text-[#d3f77a]",
  wait: "border-[#f59e0b]/50 bg-[#f59e0b]/15 text-amber-900 dark:text-[#fcd38a]",
  done: "border-[#60a5fa]/30 bg-[#60a5fa]/10 text-blue-800/80 dark:text-[#b6d0ff]/75",
};

export const BUCKET_LABELS: Record<MissionRadarBucket, string> = {
  need: "개입 필요",
  run: "실행 중",
  wait: "대기",
  done: "완료",
};

export function getMissionRadarBucket(
  mission: MissionListItem,
  attentionMissionIds: ReadonlySet<string>,
): MissionRadarBucket {
  if (attentionMissionIds.has(mission.id)) return "need";
  if (mission.status === "active") return "run";
  if (mission.status === "planning" || mission.status === "paused") return "wait";
  return "done";
}

export function getMissionWorkflowTag(mission: MissionListItem): string {
  return mission.project?.name?.trim() || "일반 미션";
}

export function formatMissionShortKey(index: number): string {
  return `M${String(index + 1).padStart(2, "0")}`;
}

export interface MissionRadarFilterState {
  radarStatus: RadarStatusBucket;
  searchQuery: string;
  workflowFilter: string;
}

export function matchesMissionRadarFilters(
  mission: MissionListItem,
  shortKey: string,
  filters: MissionRadarFilterState,
  attentionMissionIds: ReadonlySet<string>,
  agentMap: Record<string, string>,
): boolean {
  const bucket = getMissionRadarBucket(mission, attentionMissionIds);
  if (filters.radarStatus !== "all" && bucket !== filters.radarStatus) {
    return false;
  }
  const workflowTag = getMissionWorkflowTag(mission);
  if (filters.workflowFilter !== "all" && workflowTag !== filters.workflowFilter) {
    return false;
  }
  const q = filters.searchQuery.trim().toLowerCase();
  if (!q) return true;

  const ownerName = agentMap[mission.ownerAgentId] ?? "";
  return (
    mission.title.toLowerCase().includes(q) ||
    mission.id.toLowerCase().includes(q) ||
    shortKey.toLowerCase().includes(q) ||
    workflowTag.toLowerCase().includes(q) ||
    ownerName.toLowerCase().includes(q) ||
    (mission.description ?? "").toLowerCase().includes(q)
  );
}

export function sortMissionsByAttentionPriority(
  missions: readonly MissionListItem[],
  attentionMissionIds: ReadonlySet<string>,
): MissionListItem[] {
  return missions
    .map((mission, index) => ({
      mission,
      index,
      rank: RADAR_PRIORITY[getMissionRadarBucket(mission, attentionMissionIds)],
    }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
    .map((entry) => entry.mission);
}

export interface MissionFleetRadarProps {
  missions: MissionListItem[];
  attentionMissionIds: ReadonlySet<string>;
  attentionReasons: ReadonlyMap<string, string>;
  agentMap: Record<string, string>;
  radarStatus: RadarStatusBucket;
  onRadarStatusChange: (next: RadarStatusBucket) => void;
  searchQuery: string;
  onSearchQueryChange: (next: string) => void;
  workflowFilter: string;
  onWorkflowFilterChange: (next: string) => void;
  selectedMissionId: string | null;
  onJumpToMission: (mission: MissionListItem) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

export function MissionFleetRadar({
  missions,
  attentionMissionIds,
  attentionReasons,
  agentMap,
  radarStatus,
  onRadarStatusChange,
  searchQuery,
  onSearchQueryChange,
  workflowFilter,
  onWorkflowFilterChange,
  selectedMissionId,
  onJumpToMission,
  searchInputRef,
}: MissionFleetRadarProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const next: Record<RadarStatusBucket, number> = {
      all: missions.length,
      need: 0,
      run: 0,
      wait: 0,
      done: 0,
    };
    for (const mission of missions) {
      next[getMissionRadarBucket(mission, attentionMissionIds)] += 1;
    }
    return next;
  }, [missions, attentionMissionIds]);

  const workflows = useMemo(() => {
    const unique = new Set<string>();
    for (const mission of missions) {
      unique.add(getMissionWorkflowTag(mission));
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [missions]);

  const filterState = useMemo<MissionRadarFilterState>(
    () => ({ radarStatus, searchQuery, workflowFilter }),
    [radarStatus, searchQuery, workflowFilter],
  );

  const hoveredEntry = useMemo(() => {
    if (!hoveredId) return null;
    const idx = missions.findIndex((m) => m.id === hoveredId);
    if (idx < 0) return null;
    const mission = missions[idx];
    return {
      mission,
      shortKey: formatMissionShortKey(idx),
      bucket: getMissionRadarBucket(mission, attentionMissionIds),
      workflow: getMissionWorkflowTag(mission),
      owner: agentMap[mission.ownerAgentId] ?? "—",
      reason: attentionReasons.get(mission.id),
    };
  }, [hoveredId, missions, attentionMissionIds, agentMap, attentionReasons]);

  return (
    <section
      aria-label="Mission Fleet Radar"
      data-mission-radar
      className="flex flex-col gap-2 rounded-xl border border-border/80 bg-card/90 p-2.5 shadow-sm dark:border-white/[0.08] dark:bg-gradient-to-b dark:from-[#161b27]/90 dark:to-[#10141d]/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_14px_34px_-22px_rgba(0,0,0,0.85)]"
    >
      {/* Row 1: Status Chips + Search + Workflow Filter + Legend */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Radar status filters"
          className="flex flex-wrap items-center gap-1"
        >
          {RADAR_CHIPS.map((chip) => {
            const active = radarStatus === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                data-radar-status={chip.key}
                aria-pressed={active}
                onClick={() => onRadarStatusChange(chip.key)}
                className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-bold transition-all whitespace-nowrap ${
                  active
                    ? chip.activeChipClass
                    : "border-transparent bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground dark:bg-white/[0.05] dark:text-[#98a2b6] dark:hover:bg-white/[0.1] dark:hover:text-[#eef1f6]"
                }`}
              >
                {chip.key !== "all" && (
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${chip.dotClass}`} />
                )}
                <span>{chip.label}</span>
                <span className="font-mono text-[11px] font-extrabold tabular-nums">
                  {counts[chip.key]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative min-w-[180px] flex-1 max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={searchInputRef}
            type="text"
            aria-label="Search missions"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="미션 ID · 제목 · 워크플로 검색"
            className="h-7 w-full rounded-lg border border-border/90 bg-background/80 pl-8 pr-7 text-xs font-medium text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[#60a5fa] focus:ring-2 focus:ring-[#60a5fa]/20 dark:border-white/[0.12] dark:bg-white/[0.04] dark:text-[#eef1f6] dark:placeholder:text-[#5d677b]"
          />
          {searchQuery ? (
            <button
              type="button"
              aria-label="Clear mission search"
              onClick={() => onSearchQueryChange("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1 font-mono text-[9px] text-muted-foreground sm:inline dark:border-white/[0.14]">
              /
            </kbd>
          )}
        </div>

        <select
          aria-label="Filter by workflow"
          value={workflowFilter}
          onChange={(e) => onWorkflowFilterChange(e.target.value)}
          className="h-7 max-w-[190px] cursor-pointer rounded-lg border border-border/90 bg-background/80 px-2.5 text-xs font-semibold text-foreground outline-none focus:border-[#60a5fa] dark:border-white/[0.12] dark:bg-[#0b0e14] dark:text-[#eef1f6]"
        >
          <option value="all">워크플로: 전체</option>
          {workflows.map((wf) => (
            <option key={wf} value={wf}>
              {wf}
            </option>
          ))}
        </select>

        <div className="ml-auto hidden items-center gap-2.5 text-[10px] font-semibold text-muted-foreground xl:flex">
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#f43f5e]" />
            개입 경고
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#a3e635]" />
            실행 맥동
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#f59e0b]" />
            대기
          </span>
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#60a5fa]/70" />
            완료
          </span>
        </div>
      </div>

      {/* Row 2: Compact Horizontal Visual Status Mosaic (42+ mission-ready) */}
      {missions.length > 0 && (
        <div className="space-y-1">
          <div
            role="list"
            aria-label="Mission status mosaic"
            data-mission-mosaic
            className="grid grid-cols-7 gap-1 sm:grid-cols-14 lg:grid-cols-[repeat(21,minmax(0,1fr))]"
          >
            {missions.map((mission, idx) => {
              const shortKey = formatMissionShortKey(idx);
              const bucket = getMissionRadarBucket(mission, attentionMissionIds);
              const matched = matchesMissionRadarFilters(
                mission,
                shortKey,
                filterState,
                attentionMissionIds,
                agentMap,
              );
              const isSelected = selectedMissionId === mission.id;
              const workflowTag = getMissionWorkflowTag(mission);
              const reason = attentionReasons.get(mission.id);
              const tooltipText = [
                `${shortKey} · ${mission.title}`,
                `${BUCKET_LABELS[bucket]} · ${workflowTag}`,
                reason ? `사유: ${reason}` : null,
              ]
                .filter(Boolean)
                .join(" — ");

              return (
                <button
                  key={mission.id}
                  type="button"
                  role="listitem"
                  data-mosaic-tile={mission.id}
                  data-radar-bucket={bucket}
                  data-dimmed={!matched || undefined}
                  aria-label={tooltipText}
                  title={tooltipText}
                  onMouseEnter={() => setHoveredId(mission.id)}
                  onMouseLeave={() => setHoveredId((cur) => (cur === mission.id ? null : cur))}
                  onFocus={() => setHoveredId(mission.id)}
                  onBlur={() => setHoveredId((cur) => (cur === mission.id ? null : cur))}
                  onClick={() => onJumpToMission(mission)}
                  className={`h-[22px] cursor-pointer rounded-md border px-0 font-mono text-[9.5px] font-bold tabular-nums tracking-tight transition-all hover:-translate-y-px hover:brightness-115 ${
                    MOSAIC_TILE_CLASS[bucket]
                  } ${!matched ? "opacity-25 saturate-0" : ""} ${
                    isSelected
                      ? "ring-2 ring-foreground ring-offset-1 ring-offset-background dark:ring-white"
                      : ""
                  }`}
                >
                  {shortKey}
                </button>
              );
            })}
          </div>

          {hoveredEntry && (
            <div
              role="status"
              data-mosaic-tooltip
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-border/70 bg-muted/60 px-2 py-1 text-[11px] text-foreground dark:border-white/[0.08] dark:bg-[#0b0e14]/90 dark:text-[#eef1f6]"
            >
              <span className="font-mono font-bold text-[#60a5fa]">{hoveredEntry.shortKey}</span>
              <span className="truncate font-semibold">{hoveredEntry.mission.title}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{BUCKET_LABELS[hoveredEntry.bucket]}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{hoveredEntry.workflow}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{hoveredEntry.owner}</span>
              {hoveredEntry.reason && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-medium text-rose-600 dark:text-[#ffb3c1]">
                    {hoveredEntry.reason}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
