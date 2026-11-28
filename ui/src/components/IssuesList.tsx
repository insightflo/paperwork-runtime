import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { groupBy } from "../lib/groupBy";
import { formatDate, cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { IssueRow } from "./IssueRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, Filter, ArrowUpDown, Layers, Check, X, ChevronRight, List, Columns3, User, Search } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import {
  applyFilters,
  arraysEqual,
  countActiveFilters,
  defaultViewState,
  getViewState,
  paperworkIssueStatusLabel, priorityOrder,
  quickFilterPresets,
  saveViewState,
  sortIssues,
  statusLabel,
  statusOrder,
  toggleInArray,
  type IssueViewState,
} from "./issuesListView";
import type { Issue } from "@paperclipai/shared";

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialSearch?: string;
  onSearchChange?: (search: string) => void;
  /** Reports how many client-side filters narrow the rows (0 = none). */
  onFiltersChange?: (activeCount: number) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialSearch,
  onSearchChange,
  onFiltersChange,
  onUpdateIssue,
}: IssuesListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;

  const [viewState, setViewState] = useState<IssueViewState>(() => {
    if (initialAssignees) {
      return { ...defaultViewState, assignees: initialAssignees, statuses: [] };
    }
    return getViewState(scopedKey);
  });
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [debouncedIssueSearch, setDebouncedIssueSearch] = useState(issueSearch);
  const normalizedIssueSearch = debouncedIssueSearch.trim();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedIssueSearch(issueSearch);
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [issueSearch]);

  // Reload view state from localStorage when company changes (scopedKey changes).
  const prevScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevScopedKey.current !== scopedKey) {
      prevScopedKey.current = scopedKey;
      setViewState(initialAssignees
        ? { ...defaultViewState, assignees: initialAssignees, statuses: [] }
        : getViewState(scopedKey));
    }
  }, [scopedKey, initialAssignees]);

  const updateView = useCallback((patch: Partial<IssueViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveViewState(scopedKey, next);
      return next;
    });
  }, [scopedKey]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, normalizedIssueSearch, projectId),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: normalizedIssueSearch, projectId }),
    enabled: !!selectedCompanyId && normalizedIssueSearch.length > 0,
  });

  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  const filtered = useMemo(() => {
    const sourceIssues = normalizedIssueSearch.length > 0 ? searchedIssues : issues;
    const filteredByControls = applyFilters(sourceIssues, viewState, currentUserId);
    return sortIssues(filteredByControls, viewState);
  }, [issues, searchedIssues, viewState, normalizedIssueSearch, currentUserId]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveFilters(viewState);
  useEffect(() => {
    onFiltersChange?.(activeFilterCount);
  }, [activeFilterCount, onFiltersChange]);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return statusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: statusLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return priorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: statusLabel(p), items: groups[p]! }));
    }
    // assignee
    const groups = groupBy(
      filtered,
      (issue) => issue.assigneeAgentId ?? (issue.assigneeUserId ? `__user:${issue.assigneeUserId}` : "__unassigned"),
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "__unassigned"
          ? "Unassigned"
          : key.startsWith("__user:")
            ? (formatAssigneeUserLabel(key.slice("__user:".length), currentUserId) ?? "User")
            : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [filtered, viewState.groupBy, agents, agentName, currentUserId]);

  const newIssueDefaults = (groupKey?: string) => {
    const defaults: Record<string, string> = {};
    if (projectId) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
    }
    return defaults;
  };

  const assignIssue = (issueId: string, assigneeAgentId: string | null, assigneeUserId: string | null = null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  };

  return (
    <div className="space-y-4 tabular-nums">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 rounded-[10px] border border-slate-200/90 bg-white/95 px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] sm:h-10 sm:gap-3 sm:py-0">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button type="button" aria-label="New Work Item" size="sm" variant="outline" className="h-8 rounded-md border-blue-600/20 bg-blue-600 font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-blue-500 dark:border-[#60a5fa]/50 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]" onClick={() => openNewIssue(newIssueDefaults())}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">New Work Item</span>
          </Button>
          <div className="relative w-48 sm:w-64 md:w-80">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#627089]" />
            <Input
              value={issueSearch}
              onChange={(e) => {
                setIssueSearch(e.target.value);
                onSearchChange?.(e.target.value);
              }}
              placeholder="Search work..."
              className="h-8 rounded-md border-slate-200/90 bg-white pl-7 text-xs text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] placeholder:text-slate-400 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:placeholder:text-[#627089] dark:focus-visible:border-[#60a5fa] dark:focus-visible:ring-[#60a5fa]/25 sm:text-sm"
              aria-label="Search work"
            />
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          {/* View mode toggle */}
          <div className="mr-1 flex items-center overflow-hidden rounded-[10px] border border-slate-200/90 bg-slate-100/90 dark:border-white/[0.08] dark:bg-[#090c12]">
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "list" ? "bg-white text-slate-950 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.08),inset_0_-2px_0_#2563eb] dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-2px_0_#60a5fa]" : "text-slate-500 hover:text-slate-950 dark:text-[#8f9db3] dark:hover:text-[#eef2f8]"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view" aria-label="List view" type="button" aria-pressed={viewState.viewMode === "list"}
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "board" ? "bg-white text-slate-950 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.08),inset_0_-2px_0_#2563eb] dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-2px_0_#60a5fa]" : "text-slate-500 hover:text-slate-950 dark:text-[#8f9db3] dark:hover:text-[#eef2f8]"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view" aria-label="Board view" type="button" aria-pressed={viewState.viewMode === "board"}
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" aria-label={activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"} variant="ghost" size="sm" className={`h-8 rounded-md px-2 text-xs hover:bg-slate-100 hover:text-slate-950 dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8] ${activeFilterCount > 0 ? "text-blue-700 dark:text-[#60a5fa]" : "text-slate-600 dark:text-[#8f9db3]"}`}>
                <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>
                {activeFilterCount > 0 && (
                  <span className="sm:hidden text-[10px] font-medium ml-0.5">{activeFilterCount}</span>
                )}
                {activeFilterCount > 0 && (
                  <X
                    className="h-3 w-3 ml-1 hidden sm:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateView({ statuses: [], priorities: [], assignees: [], labels: [], projects: [] });
                    }}
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="tactile-card w-[min(480px,calc(100vw-2rem))] rounded-[12px] border-slate-200/90 bg-white/95 p-0 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
              <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => updateView({ statuses: [], priorities: [], assignees: [], labels: [] })}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Quick filters */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Quick filters</span>
                  <div className="flex flex-wrap gap-1.5">
                    {quickFilterPresets.map((preset) => {
                      const isActive = arraysEqual(viewState.statuses, preset.statuses);
                      return (
                        <button
                          key={preset.label}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            isActive
                              ? "border-blue-600/30 bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] dark:border-[#60a5fa]/45 dark:bg-[#2563eb] dark:text-[#f8fafc]"
                              : "border-slate-200/90 text-slate-600 hover:border-blue-500/40 hover:text-slate-950 dark:border-white/[0.1] dark:text-[#8f9db3] dark:hover:border-[#60a5fa]/40 dark:hover:text-[#eef2f8]"
                          }`}
                          onClick={() => updateView({ statuses: isActive ? [] : [...preset.statuses] })}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border" />

                {/* Multi-column filter sections */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  {/* Status */}
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <div className="space-y-0.5">
                      {statusOrder.map((s) => (
                        <label key={s} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                          <Checkbox aria-label={`Status: ${statusLabel(s)}`}
                            checked={viewState.statuses.includes(s)}
                            onCheckedChange={() => updateView({ statuses: toggleInArray(viewState.statuses, s) })}
                          />
                          <StatusIcon status={s} />
                          <span className="text-sm">{paperworkIssueStatusLabel(s)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Priority + Assignee stacked in right column */}
                  <div className="space-y-3">
                    {/* Priority */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Priority</span>
                      <div className="space-y-0.5">
                        {priorityOrder.map((p) => (
                          <label key={p} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                            <Checkbox aria-label={`Priority: ${statusLabel(p)}`}
                              checked={viewState.priorities.includes(p)}
                              onCheckedChange={() => updateView({ priorities: toggleInArray(viewState.priorities, p) })}
                            />
                            <PriorityIcon priority={p} />
                            <span className="text-sm">{statusLabel(p)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Assignee */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Assignee</span>
                      <div className="space-y-0.5 max-h-32 overflow-y-auto">
                        <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                          <Checkbox aria-label="Assignee: No assignee"
                            checked={viewState.assignees.includes("__unassigned")}
                            onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__unassigned") })}
                          />
                          <span className="text-sm">No assignee</span>
                        </label>
                        {currentUserId && (
                          <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                            <Checkbox aria-label="Assignee: Me"
                              checked={viewState.assignees.includes("__me")}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__me") })}
                            />
                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm">Me</span>
                          </label>
                        )}
                        {(agents ?? []).map((agent) => (
                          <label key={agent.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                            <Checkbox aria-label={`Assignee: ${agent.name}`}
                              checked={viewState.assignees.includes(agent.id)}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, agent.id) })}
                            />
                            <span className="text-sm">{agent.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {labels && labels.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Labels</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {labels.map((label) => (
                            <label key={label.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                              <Checkbox aria-label={`Label: ${label.name}`}
                                checked={viewState.labels.includes(label.id)}
                                onCheckedChange={() => updateView({ labels: toggleInArray(viewState.labels, label.id) })}
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                              <span className="text-sm">{label.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {projects && projects.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Work Context</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {projects.map((project) => (
                            <label key={project.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-slate-100 dark:hover:bg-[#151d2b] cursor-pointer">
                              <Checkbox aria-label={`Work Context: ${project.name}`}
                                checked={viewState.projects.includes(project.id)}
                                onCheckedChange={() => updateView({ projects: toggleInArray(viewState.projects, project.id) })}
                              />
                              <span className="text-sm">{project.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" aria-label="Sort" variant="ghost" size="sm" className="h-8 rounded-md px-2 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-[#8f9db3] dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8]">
                  <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Sort</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 tactile-card rounded-[12px] border-slate-200/90 bg-white/95 p-0 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const).map(([field, label]) => (
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field ? "bg-blue-50 text-slate-950 shadow-[inset_2px_0_0_#2563eb] dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_2px_0_0_#60a5fa]" : "text-slate-600 hover:bg-slate-100 dark:text-[#8f9db3] dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8]"
                      }`}
                      onClick={() => {
                        if (viewState.sortField === field) {
                          updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
                        } else {
                          updateView({ sortField: field, sortDir: "asc" });
                        }
                      }}
                    >
                      <span>{label}</span>
                      {viewState.sortField === field && (
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" aria-label="Group" variant="ghost" size="sm" className="h-8 rounded-md px-2 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-[#8f9db3] dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8]">
                  <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Group</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 tactile-card rounded-[12px] border-slate-200/90 bg-white/95 p-0 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
                    ["none", "None"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value ? "bg-blue-50 text-slate-950 shadow-[inset_2px_0_0_#2563eb] dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_2px_0_0_#60a5fa]" : "text-slate-600 hover:bg-slate-100 dark:text-[#8f9db3] dark:hover:bg-[#151d2b] dark:hover:text-[#eef2f8]"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {isLoading && <div role="status" aria-live="polite" aria-label="Loading work items"><PageSkeleton variant="issues-list" /></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <div aria-live="polite"><EmptyState
          icon={CircleDot}
          message="No work items match the current filters or search."
          action="Create Work Item"
          onAction={() => openNewIssue(newIssueDefaults())}
        /></div>
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          issues={filtered}
          agents={agents}
          liveIssueIds={liveIssueIds}
          onUpdateIssue={onUpdateIssue}
        />
      ) : (
        groupedContent.map((group) => (
          <Collapsible key={group.key}
            className={cn("tabular-nums", group.items.length > 0 && "overflow-hidden rounded-[12px] border border-slate-200/80 bg-white/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#0e131d]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]")}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) => {
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((k) => k !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              });
            }}
          >
            {group.label && (
              <div className="flex items-center border-b border-slate-200/70 py-1.5 pl-1 pr-3 text-slate-500 tabular-nums dark:border-white/[0.08] dark:text-[#8f9db3]">
                <CollapsibleTrigger className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className="text-sm font-semibold uppercase tracking-wide">
                    {viewState.groupBy === "status" ? paperworkIssueStatusLabel(group.key) : group.label}
                  </span>
                </CollapsibleTrigger>
                <Button type="button" aria-label={`New Work Item in ${group.label}`}
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => openNewIssue(newIssueDefaults(group.key))}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CollapsibleContent>
              {group.items.map((issue) => (
                <IssueRow
                  key={issue.id} issue={issue}
                  issueLinkState={issueLinkState}
                  desktopLeadingSpacer
                  className="border-slate-200/80 text-slate-800 tabular-nums hover:bg-slate-50 dark:border-white/[0.08] dark:text-[#eef2f8] dark:hover:bg-[#111826]"
                  mobileLeading={(
                    <span
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <StatusIcon
                        status={issue.status}
                        onChange={(s) => onUpdateIssue(issue.id, { status: s })}
                      />
                    </span>
                  )}
                  desktopMetaLeading={(
                    <>
                      <span className="hidden sm:inline-flex">
                        <PriorityIcon priority={issue.priority} />
                      </span>
                      <span
                        className="hidden shrink-0 sm:inline-flex"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        <StatusIcon
                          status={issue.status}
                          onChange={(s) => onUpdateIssue(issue.id, { status: s })}
                        />
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500 dark:text-[#8f9db3]">
                        {issue.identifier ?? issue.id.slice(0, 8)}
                      </span>
                      {liveIssueIds?.has(issue.id) && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-lime-600/25 bg-lime-500/10 px-1.5 py-0.5 tabular-nums dark:border-[#a3e635]/35 dark:bg-[#a3e635]/10 sm:gap-1.5 sm:px-2">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-lime-400 opacity-75 dark:bg-[#a3e635]" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-lime-500 dark:bg-[#a3e635]" />
                          </span>
                          <span className="hidden text-[11px] font-semibold text-lime-700 dark:text-[#a3e635] sm:inline">
                            Live
                          </span>
                        </span>
                      )}
                    </>
                  )}
                  mobileMeta={timeAgo(issue.updatedAt)}
                  desktopTrailing={(
                    <>
                      {(issue.labels ?? []).length > 0 && (
                        <span className="hidden items-center gap-1 overflow-hidden md:flex md:max-w-[240px]">
                          {(issue.labels ?? []).slice(0, 3).map((label) => (
                            <span
                              key={label.id}
                              className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                borderColor: label.color,
                                color: label.color,
                                backgroundColor: `${label.color}1f`,
                              }}
                            >
                              {label.name}
                            </span>
                          ))}
                          {(issue.labels ?? []).length > 3 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{(issue.labels ?? []).length - 3}
                            </span>
                          )}
                        </span>
                      )}
                      <Popover
                        open={assigneePickerIssueId === issue.id}
                        onOpenChange={(open) => {
                          setAssigneePickerIssueId(open ? issue.id : null);
                          if (!open) setAssigneeSearch("");
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button type="button"
                            className="flex w-[180px] shrink-0 items-center rounded-md px-2 py-1 text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-[#b6c2d6] dark:hover:bg-[#151d2b] dark:focus-visible:ring-[#60a5fa]/35"
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          >
                            {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                              <Identity name={agentName(issue.assigneeAgentId)!} size="sm" />
                            ) : issue.assigneeUserId ? (
                              <span className="inline-flex items-center gap-1.5 text-xs">
                                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                  <User className="h-3 w-3" />
                                </span>
                                {formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User"}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                  <User className="h-3 w-3" />
                                </span>
                                Assignee
                              </span>
                            )}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="tactile-card w-56 rounded-[12px] border-slate-200/90 bg-white/95 p-1 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_-18px_rgba(0,0,0,0.85)]"
                          align="end"
                          onClick={(e) => e.stopPropagation()}
                          onPointerDownOutside={() => setAssigneeSearch("")}
                        >
                          <input
                            className="mb-1 w-full border-b border-slate-200/90 bg-transparent px-2 py-1.5 text-xs text-slate-900 outline-none placeholder:text-slate-400 dark:border-white/[0.08] dark:text-[#eef2f8] dark:placeholder:text-[#627089]"
                            placeholder="Search assignees..." aria-label="Search assignees"
                            value={assigneeSearch}
                            onChange={(e) => setAssigneeSearch(e.target.value)}
                            autoFocus
                          />
                          <div className="max-h-48 overflow-y-auto overscroll-contain">
                            <button
                              className={cn(
                                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-slate-100 dark:hover:bg-[#151d2b]",
                                !issue.assigneeAgentId && !issue.assigneeUserId && "bg-blue-50 text-slate-950 dark:bg-[#151d2b] dark:text-[#eef2f8]",
                              )}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                assignIssue(issue.id, null, null);
                              }}
                            >
                              No assignee
                            </button>
                            {currentUserId && (
                              <button
                                className={cn(
                                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-[#151d2b]",
                                  issue.assigneeUserId === currentUserId && "bg-blue-50 text-slate-950 dark:bg-[#151d2b] dark:text-[#eef2f8]",
                                )}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  assignIssue(issue.id, null, currentUserId);
                                }}
                              >
                                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span>Me</span>
                              </button>
                            )}
                            {(agents ?? [])
                              .filter((agent) => {
                                if (!assigneeSearch.trim()) return true;
                                return agent.name
                                  .toLowerCase()
                                  .includes(assigneeSearch.toLowerCase());
                              })
                              .map((agent) => (
                                <button
                                  key={agent.id}
                                  className={cn(
                                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-[#151d2b]",
                                    issue.assigneeAgentId === agent.id && "bg-blue-50 text-slate-950 dark:bg-[#151d2b] dark:text-[#eef2f8]",
                                  )}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    assignIssue(issue.id, agent.id, null);
                                  }}
                                >
                                  <Identity name={agent.name} size="sm" className="min-w-0" />
                                </button>
                              ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </>
                  )}
                  trailingMeta={formatDate(issue.createdAt)}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </div>
  );
}
