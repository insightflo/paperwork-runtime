import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { ApprovalPayloadRenderer, approvalLabel } from "../components/ApprovalPayload";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  AlertTriangle,
  RotateCcw,
  X,
} from "lucide-react";
import { PageTabBar } from "../components/PageTabBar";
import type {
  Approval,
  HeartbeatRun,
  Issue,
  JoinRequest,
} from "@paperclipai/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  getApprovalsForTab,
  getInboxWorkItems,
  getRecentTouchedIssues,
  readIssueIdFromRun,
  InboxApprovalFilter,
  saveLastInboxTab,
  shouldShowHeartbeatLoadMoreSection,
  shouldShowInboxSection,
  type InboxTab,
  type InboxWorkItem,
} from "../lib/inbox";
import { useDismissedInboxItems } from "../hooks/useInboxBadge";
import { HumanReviewPacket } from "../components/HumanReviewPacket";
import {
  attentionItemToRun,
  isFailedRunAttentionItem,
  useInboxHeartbeatData,
} from "../hooks/useInboxHeartbeatData";

type InboxCategoryFilter =
  | "everything"
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
type SectionKey =
  | "work_items"
  | "join_requests"
  | "alerts";

type TriageItem = InboxWorkItem;
type TriageKind = TriageItem["kind"];

/** Stable list/detail identity per work item. */
function triageKey(item: TriageItem): string {
  if (item.kind === "issue") return `issue:${item.issue.id}`;
  if (item.kind === "approval") return `approval:${item.approval.id}`;
  return `run:${item.run.id}`;
}

/**
 * Archive (dismiss) key for an approval. Scoped to its current status so a
 * locally archived request that later changes state reappears in the triage
 * list instead of staying hidden.
 */
function archivedApprovalKey(approval: Approval): string {
  return `approval:${approval.id}:${approval.status}`;
}

/** Approvals that can be decided right from the inbox (same rule as the old row). */
function isDecidableApproval(approval: Approval): boolean {
  return approval.type !== "budget_override_required" && ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
}

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value.split("\n").map((chunk) => chunk.trim()).find(Boolean);
  return line ?? null;
}

function runFailureMessage(run: HeartbeatRun): string {
  return firstNonEmptyLine(run.error) ?? firstNonEmptyLine(run.stderrExcerpt) ?? "Run exited with an error.";
}

/** Full failure text for the detail pane (error first, stderr as fallback). */
function runFailureDetail(run: HeartbeatRun): string {
  return run.error?.trim() || run.stderrExcerpt?.trim() || "Run exited with an error.";
}

const DIFF_KEYS = ["diff", "patch", "unifiedDiff"];
const EVIDENCE_KEYS = ["evidence", "rationale", "justification", "reason"];
const MAX_SNIPPET_CHARS = 6000;
const MAX_SNIPPET_LINES = 240;
const MAX_DESCRIPTION_CHARS = 4000;

/** Pull a diff/evidence text out of an approval payload, diffs first. */
function approvalSnippet(payload: Record<string, unknown>): { text: string; isDiff: boolean } | null {
  const find = (keys: string[]): string | null => {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  };
  const diff = find(DIFF_KEYS);
  if (diff) return { text: diff, isDiff: true };
  const evidence = find(EVIDENCE_KEYS);
  return evidence ? { text: evidence, isDiff: false } : null;
}

function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

const PILL = "shrink-0 rounded px-1.5 py-px text-[9.5px] font-bold uppercase leading-4 tracking-wider";

const CATEGORY: Record<TriageKind, { label: string; className: string }> = {
  issue: { label: "Issue", className: "bg-primary/15 text-primary" },
  approval: { label: "Approval", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  failed_run: { label: "Failed run", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
};

const KBD = "rounded border border-border bg-background px-1.5 font-mono text-[10px] leading-4 text-muted-foreground";

function Kbd({ children }: { children: string }) {
  return <kbd className={KBD}>{children}</kbd>;
}

interface TriageSummary {
  title: string;
  agent: string;
  time: string;
  unread: boolean;
  detailTo: string;
}

function summarizeItem(item: TriageItem, lang: ReturnType<typeof useCompanyLanguage>, agentName: (id: string | null) => string | null, issueById: Map<string, Issue>): TriageSummary {
  if (item.kind === "issue") {
    const issue = item.issue;
    return {
      title: issue.title,
      agent: agentName(issue.assigneeAgentId) ?? "Unassigned",
      time: issue.lastExternalCommentAt ? `commented ${timeAgo(issue.lastExternalCommentAt)}` : `updated ${timeAgo(issue.updatedAt)}`,
      unread: !!issue.isUnreadForMe,
      detailTo: `/issues/${issue.identifier ?? issue.id}`,
    };
  }
  if (item.kind === "approval") {
    const approval = item.approval;
    return {
      title: approvalLabel(approval.type, approval.payload, lang),
      agent: agentName(approval.requestedByAgentId) ?? (approval.requestedByUserId ? "Board member" : approval.requestedByPluginId ? "Plugin" : "System"),
      time: `updated ${timeAgo(approval.updatedAt)}`,
      unread: ACTIONABLE_APPROVAL_STATUSES.has(approval.status),
      detailTo: `/approvals/${approval.id}`,
    };
  }
  const run = item.run;
  const issueId = readIssueIdFromRun(run);
  const issue = issueId ? issueById.get(issueId) ?? null : null;
  return {
    title: issue ? `${issue.identifier ?? issue.id.slice(0, 8)} · ${issue.title}` : "Failed run",
    agent: agentName(run.agentId) ?? "Unknown agent",
    time: `failed ${timeAgo(run.createdAt)}`,
    unread: true,
    detailTo: `/agents/${run.agentId}/runs/${run.id}`,
  };
}

/** Compact scannable master-list row. */
function TriageListRow({ item, summary, selected, live, onSelect }: {
  item: TriageItem;
  summary: TriageSummary;
  selected: boolean;
  live: boolean;
  onSelect: () => void;
}) {
  const category = CATEGORY[item.kind];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        data-triage-key={triageKey(item)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid w-full grid-cols-[0.625rem_minmax(0,1fr)] items-start gap-x-2.5 border-b border-border/60 px-3 py-2 text-left transition-colors last:border-b-0",
          selected ? "bg-primary/15 shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-accent/50",
        )}
      >
        <span className={cn("mt-[7px] h-1.5 w-1.5 rounded-full", summary.unread ? "bg-primary" : "bg-transparent")} aria-hidden="true" />
        <span className="block min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn(PILL, category.className)}>{category.label}</span>
            <span className={cn("min-w-0 truncate text-xs", summary.unread ? "font-semibold" : "font-medium text-foreground/85")}>
              {summary.title}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
            {live && (
              <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-px text-[10px] font-medium text-blue-600 dark:text-blue-400">Live</span>
            )}
            <span className="min-w-0 truncate font-medium text-foreground/75">{summary.agent}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{summary.time}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** Diff/evidence block: mono, wrapped, with semantic +/- colours. */
function EvidenceSnippet({ text, label }: { text: string; label: string }) {
  const lines = clampText(text, MAX_SNIPPET_CHARS).split("\n").slice(0, MAX_SNIPPET_LINES);
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</h4>
      <pre className="min-w-0 whitespace-pre-wrap rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
        {lines.map((line, index) => (
          <span
            key={index}
            className={cn(
              "block",
              line.startsWith("+") && !line.startsWith("+++") && "text-emerald-600 dark:text-emerald-400",
              line.startsWith("-") && !line.startsWith("---") && "text-red-600 dark:text-red-400",
              (line.startsWith("@@") || line.startsWith("#")) && "text-muted-foreground",
            )}
          >
            {line || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}

function DetailTop({ item }: { item: TriageItem }) {
  const category = CATEGORY[item.kind];
  const ref = item.kind === "issue"
    ? item.issue.identifier ?? item.issue.id.slice(0, 8)
    : item.kind === "approval"
      ? item.approval.id.slice(0, 8)
      : item.run.id.slice(0, 8);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={cn(PILL, category.className)}>{category.label}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{ref}</span>
    </div>
  );
}

function DetailFrom({ dotClass, children }: { dotClass: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)} aria-hidden="true" />
      {children}
    </div>
  );
}

function MetaGrid({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Right pane: vertical flex column, scrolling body, action bar pinned at the bottom. */
function DetailPane({ shown, onBack, actionBar, children }: {
  shown: boolean;
  onBack: () => void;
  actionBar: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Inbox detail"
      data-testid="inbox-detail"
      className={cn(
        "min-w-0 flex-col rounded-lg border border-border bg-card/60 lg:flex lg:h-[calc(100dvh-5.75rem)]",
        shown ? "flex" : "hidden",
      )}
    >
      <div className="rounded-t-lg border-b border-border bg-background/95 px-3 py-1.5 lg:hidden">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          ← Back to list
        </Button>
      </div>
      <div className="min-w-0 flex-1 p-4 lg:overflow-y-auto">{children}</div>
      <div className="sticky bottom-0 flex flex-none flex-wrap items-center gap-2 rounded-b-lg border-t border-border bg-background/95 px-3 py-2 backdrop-blur">
        {actionBar}
      </div>
    </section>
  );
}

export function Inbox() {
  const lang = useCompanyLanguage();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [allCategoryFilter, setAllCategoryFilter] = useState<InboxCategoryFilter>("everything");
  const [allApprovalFilter, setAllApprovalFilter] = useState<InboxApprovalFilter>("all");
  const { dismissed, dismiss } = useDismissedInboxItems();

  const pathSegment = location.pathname.split("/").pop() ?? "recent";
  const tab: InboxTab =
    pathSegment === "all" || pathSegment === "unread" ? pathSegment : "recent";
  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    saveLastInboxTab(tab);
  }, [tab]);

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: joinRequests = [],
    isLoading: isJoinRequestsLoading,
  } = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(selectedCompanyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues, isLoading: isIssuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const {
    data: touchedIssuesRaw = [],
    isLoading: isTouchedIssuesLoading,
  } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        touchedByUserId: "me",
        status: "backlog,todo,in_progress,in_review,blocked,done",
      }),
    enabled: !!selectedCompanyId,
  });

  const {
    isLoading: isRunsLoading,
    attentionItems,
    liveIssueIds,
    hasMore: attentionHasMore,
    loadingMore: attentionLoading,
    loadMore: loadMoreAttention,
  } = useInboxHeartbeatData(selectedCompanyId);

  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);
  const unreadTouchedIssues = useMemo(
    () => touchedIssues.filter((issue) => issue.isUnreadForMe),
    [touchedIssues],
  );
  const issuesToRender = useMemo(
    () => (tab === "unread" ? unreadTouchedIssues : touchedIssues),
    [tab, touchedIssues, unreadTouchedIssues],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const failedRuns = useMemo(
    () =>
      attentionItems
        // Only failed/timed_out become red retryable rows (historical
        // behavior); cancelled stays in the attention contract but is not
        // shown as a failure.
        .filter(isFailedRunAttentionItem)
        .filter((r) => !dismissed.has(`run:${r.runId}`))
        .map((item) => attentionItemToRun(item, selectedCompanyId ?? "")),
    [attentionItems, dismissed, selectedCompanyId],
  );

  const approvalsToRender = useMemo(
    () =>
      getApprovalsForTab(approvals ?? [], tab, allApprovalFilter)
        // Locally archived approvals stay hidden until their status changes.
        .filter((approval) => !dismissed.has(archivedApprovalKey(approval))),
    [approvals, tab, allApprovalFilter, dismissed],
  );
  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "issues_i_touched";
  const showApprovalsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";
  const failedRunsForTab = useMemo(() => {
    if (tab === "all" && !showFailedRunsCategory) return [];
    return failedRuns;
  }, [failedRuns, tab, showFailedRunsCategory]);

  const workItemsToRender = useMemo(
    () =>
      getInboxWorkItems({
        issues: tab === "all" && !showTouchedCategory ? [] : issuesToRender,
        approvals: tab === "all" && !showApprovalsCategory ? [] : approvalsToRender,
        failedRuns: failedRunsForTab,
      }),
    [approvalsToRender, issuesToRender, showApprovalsCategory, showTouchedCategory, tab, failedRunsForTab],
  );

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id) ?? null;
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(approvals!.find(a => a.id === id)!),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(approvals!.find(a => a.id === id)!),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.approveJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve join request");
    },
  });

  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.rejectJoinRequest(selectedCompanyId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject join request");
    },
  });

  const [retryingRunIds, setRetryingRunIds] = useState<Set<string>>(new Set());

  const retryRunMutation = useMutation({
    mutationFn: async (run: HeartbeatRun) => {
      const payload: Record<string, unknown> = {};
      const context = run.contextSnapshot as Record<string, unknown> | null;
      if (context) {
        if (typeof context.issueId === "string" && context.issueId) payload.issueId = context.issueId;
        if (typeof context.taskId === "string" && context.taskId) payload.taskId = context.taskId;
        if (typeof context.taskKey === "string" && context.taskKey) payload.taskKey = context.taskKey;
      }
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload,
      });
      if (!("id" in result)) {
        throw new Error("Retry was skipped because the agent is not currently invokable.");
      }
      return { newRun: result, originalRun: run };
    },
    onMutate: (run) => {
      setRetryingRunIds((prev) => new Set(prev).add(run.id));
    },
    onSuccess: ({ newRun, originalRun }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId, originalRun.agentId) });
      if (newRun.agentId !== originalRun.agentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.companyId, newRun.agentId) });
      }
      navigate(`/agents/${newRun.agentId}/runs/${newRun.id}`);
    },
    onSettled: (_data, _error, run) => {
      if (!run) return;
      setRetryingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    },
  });

  const [fadingOutIssues, setFadingOutIssues] = useState<Set<string>>(new Set());

  const invalidateInboxIssueQueries = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onMutate: (id) => {
      setFadingOutIssues((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (issueIds: string[]) => {
      await Promise.all(issueIds.map((issueId) => issuesApi.markRead(issueId)));
    },
    onMutate: (issueIds) => {
      setFadingOutIssues((prev) => {
        const next = new Set(prev);
        for (const issueId of issueIds) next.add(issueId);
        return next;
      });
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, issueIds) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          for (const issueId of issueIds) next.delete(issueId);
          return next;
        });
      }, 300);
    },
  });

  // ---- Master-detail selection ------------------------------------------------
  // `pickedKey` is the row the operator chose (click or j/k). Below lg the
  // list and detail stack, so the detail only replaces the list once a row is
  // picked. From lg up the first row is previewed by default.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const triageItems = workItemsToRender;
  const triageKeys = useMemo(() => triageItems.map(triageKey), [triageItems]);
  const pickedIndex = pickedKey ? triageKeys.indexOf(pickedKey) : -1;
  const selectedIndex = triageItems.length > 0 ? (pickedIndex >= 0 ? pickedIndex : 0) : -1;
  const selectedItem = selectedIndex >= 0 ? triageItems[selectedIndex] : null;
  const selectedKey = selectedItem ? triageKeys[selectedIndex] : null;
  const mobileDetail = pickedIndex >= 0;

  useEffect(() => {
    if (!selectedKey) return;
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  // After an action drains the current row, move to the next one so the queue
  // keeps flowing (falls back to the previous row at the end of the list).
  const advanceFrom = (index: number) => {
    const rest = triageKeys.filter((_, i) => i !== index);
    setPickedKey(rest.length ? rest[Math.min(index, rest.length - 1)] : null);
  };

  const approveItem = (item: TriageItem) => {
    if (item.kind !== "approval" || !isDecidableApproval(item.approval)) return;
    approveMutation.mutate(item.approval.id);
  };

  const archiveItem = (item: TriageItem, index: number) => {
    if (item.kind === "issue") {
      if (!item.issue.isUnreadForMe || fadingOutIssues.has(item.issue.id)) return;
      markReadMutation.mutate(item.issue.id);
    } else if (item.kind === "failed_run") {
      dismiss(`run:${item.run.id}`);
    } else {
      dismiss(archivedApprovalKey(item.approval));
    }
    advanceFrom(index);
  };

  // j/k navigate · a approve · x dismiss. Reads the latest list through a ref
  // so the listener is bound once; never fires while typing.
  const shortcutsRef = useRef({ keys: triageKeys, items: triageItems, selectedKey, approveItem, archiveItem, selectedIndex });
  shortcutsRef.current = { keys: triageKeys, items: triageItems, selectedKey, approveItem, archiveItem, selectedIndex };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const { keys, items, selectedKey, approveItem, archiveItem, selectedIndex } = shortcutsRef.current;
      if (keys.length === 0) return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        event.preventDefault();
        const current = keys.indexOf(selectedKey ?? "");
        setPickedKey(keys[(current + (key === "j" ? 1 : -1) + keys.length) % keys.length]);
        return;
      }
      const item = selectedIndex >= 0 ? items[selectedIndex] : null;
      if (!item) return;
      if (key === "a") {
        event.preventDefault();
        approveItem(item);
      } else if (key === "x") {
        event.preventDefault();
        archiveItem(item, selectedIndex);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!selectedCompanyId) {
    return <EmptyState icon={InboxIcon} message="Select a company to view inbox." />;
  }

  const hasRunFailures = failedRuns.length > 0;
  const showAggregateAgentError = !!dashboard && dashboard.agents.error > 0 && !hasRunFailures && !dismissed.has("alert:agent-errors");
  const showBudgetAlert =
    !!dashboard &&
    dashboard.costs.monthBudgetCents > 0 &&
    dashboard.costs.monthUtilizationPercent >= 80 &&
    !dismissed.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const hasJoinRequests = joinRequests.length > 0;
  const showWorkItemsSection = shouldShowHeartbeatLoadMoreSection(workItemsToRender.length, attentionHasMore, tab, showFailedRunsCategory);
  const showJoinRequestsSection =
    tab === "all" ? showJoinRequestsCategory && hasJoinRequests : tab === "unread" && hasJoinRequests;
  const showAlertsSection = shouldShowInboxSection({
    tab,
    hasItems: hasAlerts,
    showOnRecent: hasAlerts,
    showOnUnread: hasAlerts,
    showOnAll: showAlertsCategory && hasAlerts,
  });

  const visibleSections = [
    showAlertsSection ? "alerts" : null,
    showJoinRequestsSection ? "join_requests" : null,
    showWorkItemsSection ? "work_items" : null,
  ].filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isIssuesLoading &&
    !isTouchedIssuesLoading &&
    !isRunsLoading;

  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const unreadIssueIds = unreadTouchedIssues
    .filter((issue) => !fadingOutIssues.has(issue.id))
    .map((issue) => issue.id);
  const canMarkAllRead = unreadIssueIds.length > 0;

  const summaries = new Map<string, TriageSummary>();
  for (const item of triageItems) {
    summaries.set(triageKey(item), summarizeItem(item, lang, agentName, issueById));
  }

  const detailActionBar = (() => {
    const item = selectedItem;
    if (!item) return null;
    const approvalPending = approveMutation.isPending || rejectMutation.isPending;
    const nodes: ReactNode[] = [];
    if (item.kind === "approval" && isDecidableApproval(item.approval)) {
      nodes.push(
        <Button key="approve" type="button" size="xs" onClick={() => approveItem(item)} disabled={approvalPending} data-testid="inbox-approve">
          Approve<span className="ml-1.5 font-mono text-[10px] opacity-70">a</span>
        </Button>,
        <Button key="reject" type="button" size="xs" variant="outline" className="border-red-500/40 text-red-700 hover:text-red-700 dark:text-red-300 dark:hover:text-red-200" onClick={() => { rejectMutation.mutate(item.approval.id); advanceFrom(selectedIndex); }} disabled={approvalPending}>
          Reject
        </Button>,
      );
    }
    if (item.kind === "failed_run") {
      const retrying = retryingRunIds.has(item.run.id);
      nodes.push(
        <Button key="retry" type="button" size="xs" variant="outline" onClick={() => retryRunMutation.mutate(item.run)} disabled={retrying}>
          <RotateCcw className="size-3" />
          {retrying ? "Retrying…" : "Retry"}
        </Button>,
      );
    }
    const archiveDisabled = item.kind === "issue" && (!item.issue.isUnreadForMe || fadingOutIssues.has(item.issue.id) || markReadMutation.isPending);
    const archiveTitle = item.kind === "issue"
      ? item.issue.isUnreadForMe ? "Archive (marks this issue as read)" : "Already read"
      : "Archive (dismiss from inbox)";
    nodes.push(
      <Button key="archive" type="button" size="xs" variant="outline" onClick={() => archiveItem(item, selectedIndex)} disabled={archiveDisabled} title={archiveTitle} data-testid="inbox-archive">
        Archive<span className="ml-1.5 font-mono text-[10px] opacity-70">x</span>
      </Button>,
    );
    nodes.push(
      <span key="spacer" className="flex-1" />,
      <Button key="open" asChild size="xs" variant="outline">
        {item.kind === "issue" ? (
          <Link to={summaries.get(selectedKey!)!.detailTo} state={issueLinkState}>Open detail</Link>
        ) : (
          <Link to={summaries.get(selectedKey!)!.detailTo}>Open detail</Link>
        )}
      </Button>,
    );
    return nodes;
  })();

  const renderDetailBody = () => {
    const item = selectedItem;
    if (!item) {
      return (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium">Nothing to preview</p>
          <p className="text-xs text-muted-foreground">Pick an item from the list to see its full context here.</p>
        </div>
      );
    }
    const summary = summaries.get(selectedKey!)!;

    if (item.kind === "approval") {
      const approval = item.approval;
      const snippet = approvalSnippet(approval.payload);
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <DetailTop item={item} />
          <h2 className="text-[15px] font-bold leading-snug [overflow-wrap:anywhere]">{summary.title}</h2>
          <DetailFrom dotClass="bg-primary">
            <b className="font-semibold text-foreground">{summary.agent}</b>
            <span>·</span>
            <span>{summary.time}</span>
            <span>·</span>
            <StatusBadge status={approval.status} />
          </DetailFrom>
          <MetaGrid
            rows={[
              ["Request", approvalLabel(approval.type, null, lang)],
              ["Status", <StatusBadge key="s" status={approval.status} />],
              ["Decided", approval.decidedAt ? timeAgo(approval.decidedAt) : "Awaiting decision"],
            ]}
          />
          <div className="min-w-0 overflow-x-auto rounded-md border border-border bg-background/40 p-3">
            <ApprovalPayloadRenderer type={approval.type} payload={approval.payload} />
          </div>
          {snippet && (
            <EvidenceSnippet text={snippet.text} label={snippet.isDiff ? "Context · evidence diff" : "Context · evidence"} />
          )}
          {approval.decisionNote && (
            <div>
              <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Decision note</h4>
              <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{approval.decisionNote}</p>
            </div>
          )}
        </div>
      );
    }

    if (item.kind === "failed_run") {
      const run = item.run;
      const issueId = readIssueIdFromRun(run);
      const issue = issueId ? issueById.get(issueId) ?? null : null;
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <DetailTop item={item} />
          <h2 className="text-[15px] font-bold leading-snug [overflow-wrap:anywhere]">
            {issue ? (
              <>
                <span className="mr-1.5 font-mono text-xs font-normal text-muted-foreground">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                {issue.title}
              </>
            ) : (
              <>Failed run{summary.agent !== "Unknown agent" ? ` — ${summary.agent}` : ""}</>
            )}
          </h2>
          <DetailFrom dotClass="bg-red-500 dark:bg-red-400">
            <b className="font-semibold text-foreground">{summary.agent}</b>
            <span>·</span>
            <span>{summary.time}</span>
            <span>·</span>
            <StatusBadge status={run.status} />
          </DetailFrom>
          {issue && (
            <MetaGrid
              rows={[
                ["Work item", <Link key="i" className="underline underline-offset-2 hover:text-foreground" to={`/issues/${issue.identifier ?? issue.id}`}>{issue.title}</Link>],
                ["Status", <StatusBadge key="s" status={issue.status} />],
              ]}
            />
          )}
          <EvidenceSnippet text={runFailureDetail(run)} label="Failure detail" />
          {issue?.description && (
            <div>
              <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Work item description</h4>
              <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{clampText(issue.description, MAX_DESCRIPTION_CHARS)}</p>
            </div>
          )}
        </div>
      );
    }

    const issue = item.issue;
    const isUnread = !!issue.isUnreadForMe && !fadingOutIssues.has(issue.id);
    const live = liveIssueIds.has(issue.id);
    const description = issue.description?.trim();
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <DetailTop item={item} />
        <h2 className="text-[15px] font-bold leading-snug [overflow-wrap:anywhere]">{issue.title}</h2>
        <DetailFrom dotClass={isUnread ? "bg-primary" : "bg-transparent"}>
          <b className="font-semibold text-foreground">{summary.agent}</b>
          <span>·</span>
          <span>updated {timeAgo(issue.updatedAt)}</span>
          {issue.lastExternalCommentAt && (
            <>
              <span>·</span>
              <span>commented {timeAgo(issue.lastExternalCommentAt)}</span>
            </>
          )}
        </DetailFrom>
        <MetaGrid
          rows={[
            ["Status", <StatusBadge key="s" status={issue.status} />],
            ["Priority", <span key="p" className="inline-flex items-center gap-1.5"><PriorityIcon priority={issue.priority} />{issue.priority}</span>],
            ["Project", issue.project?.name ?? "—"],
            ["Run", live ? <span key="l" className="font-medium text-blue-600 dark:text-blue-400">Agent running</span> : "No active run"],
          ]}
        />
        <div>
          <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Description</h4>
          {description ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{clampText(description, MAX_DESCRIPTION_CHARS)}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No description.</p>
          )}
        </div>
      </div>
    );
  };

  const tabLabel = tab === "recent" ? "Recent" : tab === "unread" ? "Unread" : "All";

  return (
    <div className="space-y-4 tabular-nums">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onValueChange={(value) => navigate(`/inbox/${value}`)}>
            <PageTabBar
              items={[
                {
                  value: "recent",
                  label: "Recent",
                },
                { value: "unread", label: "Unread" },
                { value: "all", label: "All" },
              ]}
            />
          </Tabs>
          {unreadIssueIds.length > 0 && <span className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/60 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Unread issues <span className="font-mono text-foreground tabular-nums">{unreadIssueIds.length}</span></span>}
          {canMarkAllRead && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => markAllReadMutation.mutate(unreadIssueIds)}
              disabled={markAllReadMutation.isPending}
            >
              {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
            </Button>
          )}
        </div>

        {tab === "all" && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Select
              value={allCategoryFilter}
              onValueChange={(value) => setAllCategoryFilter(value as InboxCategoryFilter)}
            >
              <SelectTrigger className="h-8 w-[170px] text-xs">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everything">All categories</SelectItem>
                <SelectItem value="issues_i_touched">My recent work</SelectItem>
                <SelectItem value="join_requests">Join requests</SelectItem>
                <SelectItem value="approvals">Approvals</SelectItem>
                <SelectItem value="failed_runs">Failed runs</SelectItem>
                <SelectItem value="alerts">Alerts</SelectItem>
              </SelectContent>
            </Select>

            {showApprovalsCategory && (
              <Select
                value={allApprovalFilter}
                onValueChange={(value) => setAllApprovalFilter(value as InboxApprovalFilter)}
              >
                <SelectTrigger className="h-8 w-[170px] text-xs">
                  <SelectValue placeholder="Approval status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All approval statuses</SelectItem>
                  <SelectItem value="actionable">Needs action</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      {approvalsError && <p className="text-sm text-destructive">{approvalsError.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {!allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          message={
            tab === "unread"
              ? "No new inbox items."
              : tab === "recent"
                ? "No recent inbox items."
                : "No inbox items match these filters."
          }
        />
      )}

      {showWorkItemsSection && (
        <>
          {showSeparatorBefore("work_items") && <Separator />}
          <div>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Work Items</h3>
            {/* Master-detail triage: 42 / 58 split from lg, stacked below. */}
            <div
              data-testid="inbox-triage"
              className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,42%)_minmax(0,58%)] lg:items-start"
            >
              <div
                ref={listRef}
                className={cn(
                  "min-w-0 rounded-lg border border-border bg-card/60 lg:h-[calc(100dvh-5.75rem)] lg:overflow-y-auto",
                  mobileDetail ? "hidden lg:block" : "block",
                )}
              >
                <div className="sticky top-0 z-[1] flex items-center justify-between gap-3 border-b border-border bg-popover/95 px-3 py-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground backdrop-blur">
                  <span>{triageItems.length} item{triageItems.length === 1 ? "" : "s"} · {tabLabel}</span>
                  {selectedKey && <span className="hidden normal-case tracking-normal lg:inline">{selectedIndex + 1} / {triageItems.length}</span>}
                </div>
                {triageItems.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">No items in this view.</p>
                ) : (
                  <ul>
                    {triageItems.map((item) => {
                      const key = triageKey(item);
                      return (
                        <TriageListRow
                          key={key}
                          item={item}
                          summary={summaries.get(key)!}
                          selected={key === selectedKey}
                          live={item.kind === "issue" && liveIssueIds.has(item.issue.id)}
                          onSelect={() => setPickedKey(key)}
                        />
                      );
                    })}
                  </ul>
                )}
                {attentionHasMore && (
                  <div className="border-t border-border px-3 py-2 text-center">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void loadMoreAttention()}
                      disabled={attentionLoading}
                    >
                      {attentionLoading ? "Loading…" : "Load more"}
                    </Button>
                  </div>
                )}
                <div className="hidden items-center gap-1.5 border-t border-border bg-popover/95 px-3 py-1.5 text-[11px] text-muted-foreground lg:flex" data-testid="inbox-keyboard-hints">
                  <Kbd>j</Kbd>
                  <Kbd>k</Kbd>
                  <span>navigate</span>
                  <span aria-hidden="true">·</span>
                  <Kbd>a</Kbd>
                  <span>approve</span>
                  <span aria-hidden="true">·</span>
                  <Kbd>x</Kbd>
                  <span>dismiss</span>
                </div>
              </div>

              <DetailPane shown={mobileDetail} onBack={() => setPickedKey(null)} actionBar={detailActionBar}>
                {renderDetailBody()}
              </DetailPane>
            </div>
          </div>
        </>
      )}

      {showJoinRequestsSection && (
        <>
          {showSeparatorBefore("join_requests") && <Separator />}
          <div>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Join Requests
            </h3>
            <div className="grid gap-3">
              {joinRequests.map((joinRequest) => (
                <div key={joinRequest.id} id={`join-request-${joinRequest.id}`} className="rounded-md border border-border/80 bg-card/60 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {joinRequest.requestType === "human"
                          ? "Human join request"
                          : `Agent join request${joinRequest.agentName ? `: ${joinRequest.agentName}` : ""}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}
                      </p>
                      {joinRequest.requestEmailSnapshot && (
                        <p className="text-xs text-muted-foreground">
                          email: {joinRequest.requestEmailSnapshot}
                        </p>
                      )}
                      {joinRequest.adapterType && (
                        <p className="text-xs text-muted-foreground">adapter: {joinRequest.adapterType}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                        onClick={() => rejectJoinMutation.mutate(joinRequest)}
                      >
                        {L(lang, { en: "Reject", ko: "거절" })}
                      </Button>
                      <Button
                        size="sm"
                        disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                        onClick={() => approveJoinMutation.mutate(joinRequest)}
                      >
                        {L(lang, { en: "Approve", ko: "승인" })}
                      </Button>
                    </div>
                  </div>
                  <HumanReviewPacket packet={{
                    schemaVersion: "human-review-v1",
                    decisionSubject: `${joinRequest.requestType === "human" ? joinRequest.requestEmailSnapshot ?? "사용자" : joinRequest.agentName ?? "Agent"}의 회사 합류를 승인할까요?`,
                    evidence: [{ label: "합류 요청 원본", href: `/inbox#join-request-${joinRequest.id}`, location: `Join Requests > ${joinRequest.id}`, description: `요청 IP ${joinRequest.requestIp}, 요청 시각 ${new Date(joinRequest.createdAt).toLocaleString()}` }],
                    interpretation: joinRequest.requestType === "human" ? "표시된 사용자를 회사 구성원으로 추가하는 요청입니다." : `${joinRequest.adapterType ?? "지정되지 않은"} Adapter를 사용하는 Agent를 회사에 추가하는 요청입니다.`,
                    impact: { ifApproved: "초대 기본값에 따른 회사 구성원 또는 Agent 권한이 활성화됩니다.", ifRejected: "이 요청으로는 회사에 합류하거나 권한을 받을 수 없습니다.", ifWrong: "신뢰하지 않는 사용자나 Agent가 회사 데이터와 업무에 접근할 수 있습니다." },
                    unresolvedFacts: joinRequest.capabilities ? [] : ["요청한 세부 기능 권한이 명시되지 않았습니다."], questions: ["요청자 신원, 초대 경로, Adapter와 부여될 기본 권한을 확인했습니까?"],
                    recommendedNextStep: "요청 신원과 출처, 부여될 권한을 대조한 뒤 승인하거나 거절하세요.", requiredReviewer: "회사 접근 권한 관리자",
                  }} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {showAlertsSection && (
        <>
          {showSeparatorBefore("alerts") && <Separator />}
          <div>
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Alerts
            </h3>
            <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/80 bg-card/60">
              {showAggregateAgentError && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/agents"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="text-sm">
                      <span className="font-medium tabular-nums">{dashboard!.agents.error}</span>{" "}
                      {dashboard!.agents.error === 1 ? "agent has" : "agents have"} errors
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:agent-errors")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {showBudgetAlert && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/costs"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                    <span className="text-sm">
                      Budget at{" "}
                      <span className="font-medium tabular-nums">{dashboard!.costs.monthUtilizationPercent}%</span>{" "}
                      utilization this month
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:budget")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

    </div>
  );
}
