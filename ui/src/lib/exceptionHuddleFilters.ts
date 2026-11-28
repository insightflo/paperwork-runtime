import type { ExceptionHuddleMetadata } from "@paperclipai/shared/validators/exception-huddle";

export interface FilterableExceptionHuddleItem {
  threadId: string;
  channelId: string;
  title: string;
  updatedAt: string;
  huddle: ExceptionHuddleMetadata;
}

export interface ExceptionHuddleFilterCriteria {
  status?: "all" | ExceptionHuddleMetadata["status"];
  decisionKind?:
    | "all"
    | "retry_with_guidance"
    | "accept_with_waiver"
    | "replan_remaining"
    | "escalate";
  query?: string;
  sortBy?: "urgent_first" | "newest" | "oldest";
}

const URGENT_STATUS_ORDER: Record<ExceptionHuddleMetadata["status"], number> = {
  timed_out: 0,
  open: 1,
  decided: 2,
  cancelled: 3,
};

function toTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareUpdatedAtDesc(
  a: FilterableExceptionHuddleItem,
  b: FilterableExceptionHuddleItem,
): number {
  return toTime(b.updatedAt) - toTime(a.updatedAt);
}

function compareUpdatedAtAsc(
  a: FilterableExceptionHuddleItem,
  b: FilterableExceptionHuddleItem,
): number {
  return toTime(a.updatedAt) - toTime(b.updatedAt);
}

function matchesQuery(item: FilterableExceptionHuddleItem, query: string): boolean {
  if (query.length === 0) return true;
  return [item.title, item.huddle.sourceStepId, item.threadId]
    .some((value) => value.toLowerCase().includes(query));
}

export function filterAndSortExceptionHuddles<T extends FilterableExceptionHuddleItem>(
  items: readonly T[],
  criteria: ExceptionHuddleFilterCriteria = {},
): T[] {
  const status = criteria.status ?? "all";
  const decisionKind = criteria.decisionKind ?? "all";
  const query = criteria.query?.toLowerCase() ?? "";
  const sortBy = criteria.sortBy ?? "urgent_first";

  return items
    .filter((item) => {
      if (status !== "all" && item.huddle.status !== status) return false;
      if (decisionKind !== "all" && item.huddle.decision?.kind !== decisionKind) return false;
      return matchesQuery(item, query);
    })
    .sort((a, b) => {
      if (sortBy === "newest") return compareUpdatedAtDesc(a, b);
      if (sortBy === "oldest") return compareUpdatedAtAsc(a, b);
      const statusOrder = URGENT_STATUS_ORDER[a.huddle.status] - URGENT_STATUS_ORDER[b.huddle.status];
      if (statusOrder !== 0) return statusOrder;
      return compareUpdatedAtDesc(a, b);
    });
}
