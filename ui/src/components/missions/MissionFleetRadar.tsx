import { useMemo, type RefObject } from "react";
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
  radarStatus: RadarStatusBucket;
  onRadarStatusChange: (next: RadarStatusBucket) => void;
  searchQuery: string;
  onSearchQueryChange: (next: string) => void;
  workflowFilter: string;
  onWorkflowFilterChange: (next: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

export function MissionFleetRadar({
  missions,
  attentionMissionIds,
  radarStatus,
  onRadarStatusChange,
  searchQuery,
  onSearchQueryChange,
  workflowFilter,
  onWorkflowFilterChange,
  searchInputRef,
}: MissionFleetRadarProps) {
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

  return (
    <section
      aria-label="Mission Fleet Radar"
      data-mission-radar
      className="tactile-card flex flex-wrap items-center gap-2 rounded-[12px] border border-slate-200/90 bg-white/95 p-2.5 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] tabular-nums dark:border-white/[0.08] dark:bg-[#0e131d] dark:bg-none dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_-18px_rgba(0,0,0,0.85)]"
    >
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
                  : "border-transparent bg-slate-100/90 text-slate-600 hover:bg-slate-200/80 hover:text-slate-950 dark:bg-white/[0.05] dark:text-[#98a2b6] dark:hover:bg-white/[0.1] dark:hover:text-[#eef1f6]"
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
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#627089]"
        />
        <input
          ref={searchInputRef}
          type="text"
          aria-label="Search missions"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="미션 ID · 제목 · 워크플로 검색"
          className="h-7 w-full rounded-lg border border-slate-200/90 bg-slate-50/80 pl-8 pr-7 text-xs font-medium text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-[#60a5fa] focus:bg-white focus:ring-2 focus:ring-[#60a5fa]/20 dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#eef1f6] dark:placeholder:text-[#5d677b] dark:focus:border-[#60a5fa]"
        />
        {searchQuery ? (
          <button
            type="button"
            aria-label="Clear mission search"
            onClick={() => onSearchQueryChange("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-900 dark:text-[#627089] dark:hover:text-[#eef1f6]"
          >
            <X className="h-3 w-3" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 bg-white px-1 font-mono text-[9px] text-slate-500 sm:inline dark:border-white/[0.14] dark:bg-[#0e131d] dark:text-[#9aa7bd]">
            /
          </kbd>
        )}
      </div>

      <select
        aria-label="Filter by workflow"
        value={workflowFilter}
        onChange={(e) => onWorkflowFilterChange(e.target.value)}
        className="h-7 max-w-[190px] cursor-pointer rounded-lg border border-slate-200/90 bg-slate-50/80 px-2.5 text-xs font-semibold text-slate-900 outline-none transition-colors focus:border-[#60a5fa] focus:bg-white dark:border-white/[0.1] dark:bg-[#07090d] dark:text-[#eef1f6]"
      >
        <option value="all">워크플로: 전체</option>
        {workflows.map((wf) => (
          <option key={wf} value={wf}>
            {wf}
          </option>
        ))}
      </select>

      <div className="ml-auto hidden items-center gap-2.5 text-[10px] font-semibold text-slate-500 xl:flex dark:text-[#9aa7bd]">
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
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#60a5fa]/80" />
          완료
        </span>
      </div>
    </section>
  );
}
