import type { Issue, IssueStatus } from "@paperclipai/shared";

/* ── IssuesList view state ──
 * Pure helpers for the list's client-side filters, sort and persisted view state.
 * Lifted verbatim from IssuesList.tsx so the legacy component file does not grow. */

export const statusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const priorityOrder = ["critical", "high", "medium", "low"];

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const PAPERWORK_ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "대기열",
  todo: "대기",
  in_progress: "진행 중",
  in_review: "검증 중",
  blocked: "차단됨",
  done: "완료",
  cancelled: "취소됨",
};

export function paperworkIssueStatusLabel(status: string): string {
  return PAPERWORK_ISSUE_STATUS_LABELS[status as IssueStatus] ?? statusLabel(status);
}

export type IssueViewState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  projects: string[];
  sortField: "status" | "priority" | "title" | "created" | "updated";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
};

export const defaultViewState: IssueViewState = {
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  projects: [],
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "list",
  collapsedGroups: [],
};

export const quickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: PAPERWORK_ISSUE_STATUS_LABELS.backlog, statuses: ["backlog"] },
  { label: PAPERWORK_ISSUE_STATUS_LABELS.done, statuses: ["done", "cancelled"] },
];

export function getViewState(key: string): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaultViewState, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...defaultViewState };
}

export function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export function applyFilters(issues: Issue[], state: IssueViewState, currentUserId?: string | null): Issue[] {
  let result = issues;
  if (state.statuses.length > 0) result = result.filter((i) => state.statuses.includes(i.status));
  if (state.priorities.length > 0) result = result.filter((i) => state.priorities.includes(i.priority));
  if (state.assignees.length > 0) {
    result = result.filter((issue) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !issue.assigneeAgentId && !issue.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && issue.assigneeUserId === currentUserId) return true;
        if (issue.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) result = result.filter((i) => (i.labelIds ?? []).some((id) => state.labels.includes(id)));
  if (state.projects.length > 0) result = result.filter((i) => i.projectId != null && state.projects.includes(i.projectId));
  return result;
}

export function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      case "priority":
        return dir * (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

export function countActiveFilters(state: IssueViewState): number {
  let count = 0;
  if (state.statuses.length > 0) count++;
  if (state.priorities.length > 0) count++;
  if (state.assignees.length > 0) count++;
  if (state.labels.length > 0) count++;
  if (state.projects.length > 0) count++;
  return count;
}
