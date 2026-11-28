import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { paperworkIssueStatusLabel } from "./issuesListView";
import { cn } from "@/lib/utils";
import type { Issue } from "@paperclipai/shared";

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

function isLegacyHeartbeatStatus(status: string): boolean {
  return status === "backlog" || status === "in_review";
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  liveIssueIds,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div className="flex w-[260px] min-w-[260px] shrink-0 flex-col">
      <div className="mb-1 flex items-center gap-2 px-1.5 py-2 tabular-nums">
        <StatusIcon status={status} />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">
          {paperworkIssueStatusLabel(status)}
        </span>
        <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-md border border-slate-200/90 bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#aab6c9] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-[120px] flex-1 space-y-1.5 rounded-xl border p-1.5 transition-[background-color,border-color,box-shadow] duration-150",
          isOver
            ? "border-blue-400/60 bg-blue-500/10 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.18),0_0_18px_rgba(59,130,246,0.12)] dark:border-[#60a5fa]/55 dark:bg-[#60a5fa]/10 dark:shadow-[inset_0_0_0_1px_rgba(96,165,250,0.2),0_0_22px_rgba(96,165,250,0.16)]"
            : "border-slate-200/80 bg-slate-100/65 shadow-[inset_0_1px_1px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#090d14]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]",
        )}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  isOverlay,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  isOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "cursor-grab rounded-md border border-slate-200/90 bg-white p-2.5 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] transition-[border-color,background-color,box-shadow,opacity] duration-150 active:cursor-grabbing dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_20px_-10px_rgba(0,0,0,0.68)]",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay
          ? "border-blue-400/60 shadow-[0_14px_36px_-14px_rgba(37,99,235,0.45)] ring-1 ring-blue-500/25 dark:border-[#60a5fa]/55 dark:bg-[#111827] dark:shadow-[0_18px_42px_-14px_rgba(0,0,0,0.85)] dark:ring-[#60a5fa]/30"
          : "hover:border-blue-400/45 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_4px_12px_-4px_rgba(15,23,42,0.12)] dark:hover:border-[#60a5fa]/35 dark:hover:bg-[#111827] dark:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_26px_-12px_rgba(0,0,0,0.78)]",
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block text-inherit no-underline"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="mb-1.5 flex items-start gap-1.5">
          <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500 dark:text-[#8b97ad]">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative mt-0.5 flex h-2 w-2 shrink-0" title="Live run active">
              <span className="absolute inline-flex h-full w-full rounded-full bg-lime-400 opacity-70 motion-safe:animate-pulse dark:bg-[#a3e635]" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-lime-500 shadow-[0_0_7px_rgba(132,204,22,0.55)] dark:bg-[#a3e635] dark:shadow-[0_0_8px_rgba(163,230,53,0.75)]" />
            </span>
          )}
        </div>
        <p className="mb-2 line-clamp-2 text-sm leading-snug text-slate-950 dark:text-[#edf2fb]">
          {issue.title}
        </p>
        <div className="flex items-center gap-2 border-t border-slate-100 pt-2 dark:border-white/[0.055]">
          <PriorityIcon priority={issue.priority} />
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-[#8b97ad]">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const visibleBoardStatuses = boardStatuses.filter(
    (status) => !isLegacyHeartbeatStatus(status) || (columnIssues[status]?.length ?? 0) > 0,
  );

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="-mx-2 flex gap-3 overflow-x-auto px-2 pb-4 tabular-nums">
        {visibleBoardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            liveIssueIds={liveIssueIds}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
