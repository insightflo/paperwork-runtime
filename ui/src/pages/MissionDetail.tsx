import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { missionsApi, type MissionPlanRuntimeSummary, type MissionStatus } from "../api/missions";
import { activityApi } from "../api/activity";
import type { ActivityEvent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { MissionRevisionActions } from "../components/MissionRevisionActions";
import { MissionRevisionStart } from "../components/MissionRevisionStart";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { InlineEditor } from "../components/InlineEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GitBranch, ListTree, RefreshCw, Rocket, Settings } from "lucide-react";
import { MissionIssueTree } from "../components/MissionIssueTree";
import { MissionIssueInspector } from "../components/MissionIssueInspector";
import { MissionExecutionOverview } from "../components/MissionExecutionOverview";
import { WorkflowDagPanel } from "../components/WorkflowDagPanel";
import { formatMissionDate as formatDate } from "../lib/missionDate";

const STATUS_OPTIONS: { value: MissionStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// Header primary: the single next-status transition promoted to the deep-cobalt slot (same updateMission mutation).
const PRIMARY_TRANSITION: Partial<Record<MissionStatus, { to: MissionStatus; label: string }>> = {
  planning: { to: "active", label: "Activate" },
  paused: { to: "active", label: "Resume" },
  active: { to: "completed", label: "Complete" },
};

// Cockpit status pill tones (approved mockup `.st` semantics: active=cobalt, planning=amber, blocked=crimson, completed=muted).
const PILL_TONE: Record<string, string> = {
  active: "text-[#5f8dff]", running: "text-[#5f8dff]", in_progress: "text-[#5f8dff]",
  planning: "text-[#fbbf24]", paused: "text-[#fbbf24]", pending_approval: "text-[#fbbf24]",
  failed: "text-[#f87171]", blocked: "text-[#f87171]", cancelled: "text-[#f87171]", canceled: "text-[#f87171]", terminated: "text-[#f87171]",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-[#242d3f] bg-[#0b0e14] px-2 text-[10.5px] font-semibold capitalize ${PILL_TONE[status.toLowerCase()] ?? "text-[#8b97ad]"}`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

function formatDuration(start: string | Date | null, end: string | Date | null): string | null {
  if (!start) return null;
  const minutes = Math.floor(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}


type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function labelForRecord(record: JsonRecord, fallback: string): string {
  return textValue(record.name) ?? textValue(record.title) ?? textValue(record.key) ?? textValue(record.id) ?? fallback;
}

function sourceRefLabel(record: JsonRecord): string | null {
  const sourceRef = isRecord(record.sourceRef) ? record.sourceRef : null;
  const sourceType = textValue(sourceRef?.type);
  const sourceId = textValue(sourceRef?.id);
  if (sourceType && sourceId) return `${sourceType}:${sourceId}`;
  return sourceType ?? sourceId;
}

function proposedEditLabel(record: JsonRecord): string | null {
  const proposedEdit = isRecord(record.proposedEdit) ? record.proposedEdit : null;
  const operation = textValue(proposedEdit?.operation);
  const section = textValue(proposedEdit?.section);
  if (operation && section) return `${operation} · ${section}`;
  return operation ?? section;
}

function statusTone(status: string | null): string {
  switch (status?.toLowerCase()) {
    case "completed":
    case "done":
      return "text-emerald-600";
    case "failed":
    case "blocked":
    case "aborted":
    case "cancelled":
    case "canceled":
    case "timed_out":
    case "timed-out":
      return "text-destructive";
    case "running":
    case "in_progress":
      return "text-blue-600";
    default:
      return "text-muted-foreground";
  }
}

function getPlanRefArray(plan: MissionPlanRuntimeSummary | undefined, key: string): JsonRecord[] {
  return recordArray(isRecord(plan?.refs) ? plan.refs[key] : undefined);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatAuditEventSummary(event: ActivityEvent): string | null {
  const details = isRecord(event.details) ? event.details : {};
  const findingCount = numberValue(details.findingCount);
  const recommendationCount = numberValue(details.recommendationCount);
  const appliedActionCount = numberValue(details.appliedActionCount);
  if (findingCount || recommendationCount || appliedActionCount) {
    return `${findingCount} findings · ${recommendationCount} recommendations · ${appliedActionCount} applied`;
  }
  return null;
}

function MissionExecutionRulesPanel({ plan, auditEvents = [] }: { plan?: MissionPlanRuntimeSummary; auditEvents?: ActivityEvent[] }) {
  const ruleRefs = getPlanRefArray(plan, "ruleRefs");
  const kbRefs = getPlanRefArray(plan, "kbRefs");
  const executionUnits = getPlanRefArray(plan, "executionUnits");
  const selfImprovementCandidates = getPlanRefArray(plan, "selfImprovementCandidates");
  const openRequiredInputs = plan?.openRequiredInputs ?? [];
  const ruleNames = plan?.ruleNames ?? [];
  const ruleModes = plan?.ruleModes ?? [];
  const stepSummary = plan?.stepSummary ?? [];
  const blockedOrFailed = plan?.blockedOrFailedUnitCount ?? 0;
  const selectedUnitCount = plan?.selectedExecutionUnitCount ?? 0;
  const selectedStateCounts = plan?.selectedExecutionUnitSelectionStateCounts;
  const selectedExceptionCounts = plan?.selectedExecutionUnitExecutionStateCounts;
  const selectedUnitLabels = (plan?.selectedExecutionUnitLabels ?? []).filter((label) => label.trim().length > 0).slice(0, 3);
  const selectedExceptionSummary = selectedExceptionCounts
    ? [
        ["blocked", selectedExceptionCounts.blocked],
        ["failed", selectedExceptionCounts.failed],
        ["cancelled", selectedExceptionCounts.cancelled],
      ]
        .map(([label, count]) => `${label} ${count}`)
        .join(", ")
    : null;

  if (!plan?.available) {
    return (
      <div className="rounded-lg border border-[#242d3f] bg-[#111622] p-8 text-center">
        <Settings className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground mb-1">No active mission execution plan yet</p>
        <p className="text-xs text-muted-foreground">
          Worktree Rules, KB excerpts, required inputs, and maintenance decisions appear here once the mission owner substrate creates an active plan.
        </p>
        <div className="mt-4">
          <Button asChild size="sm" variant="outline"><Link to="/worktree/rules">Open global execution rules</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Latest Maintenance Decision</p>
            <p className="mt-1 text-sm font-medium">Mission plan revision {plan.revision ?? "—"} · {plan.status ?? "active"}</p>
          </div>
          <div className="text-xs text-muted-foreground">
            {plan.executionUnitCount ?? executionUnits.length} execution units · {blockedOrFailed} blocked/failed
          </div>
        </div>
        {plan.missionGoal && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-[#c9d3e4]">{plan.missionGoal}</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {[
            ["Required inputs", `${plan.requiredInputsCount ?? openRequiredInputs.length} total · ${openRequiredInputs.length} open`],
            ["Suggested status/action", "Owner decision required for retry/replan/escalation"],
            ["Handoff target", "Main executor / operator as required"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-[#242d3f] bg-[#151b28] p-3">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="mt-1 text-sm">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Plan steps</p>
          {stepSummary.length > 0 ? (
            <ol className="mt-3 space-y-2 text-sm">
              {stepSummary.map((step, index) => (
                <li key={`${step}-${index}`} className="rounded-md border border-[#242d3f] bg-[#151b28] p-2">
                  <span className="mr-2 text-xs text-muted-foreground">{index + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No plan steps summarized yet.</p>
          )}
        </section>

        <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Execution units</p>
          {executionUnits.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {executionUnits.slice(0, 8).map((unit, index) => {
                const status = textValue(unit.status);
                const source = sourceRefLabel(unit);
                return (
                  <li key={`${source ?? labelForRecord(unit, "Execution unit")}-${index}`} className="rounded-md border border-[#242d3f] bg-[#151b28] p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{labelForRecord(unit, `Execution unit ${index + 1}`)}</span>
                      {status && <span className={`shrink-0 text-xs ${statusTone(status)}`}>{status}</span>}
                    </div>
                    {source && <p className="mt-1 truncate font-mono text-[11px] text-[#8b97ad]">{source}</p>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No execution units attached to this active plan.</p>
          )}
        </section>
      </div>

      {selectedUnitCount > 0 && (
        <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Selected execution units</p>
            <span className="text-xs text-muted-foreground">{selectedUnitCount} total</span>
          </div>
          {selectedStateCounts && (
            <p className="mt-3 text-sm text-muted-foreground">
              selected {selectedStateCounts.selected} · candidate {selectedStateCounts.candidate} · excluded {selectedStateCounts.excluded} · satisfied {selectedStateCounts.satisfied}
            </p>
          )}
          {selectedExceptionSummary && <p className="mt-2 text-sm text-muted-foreground">exceptions: {selectedExceptionSummary}</p>}
          {selectedUnitLabels.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2 text-sm">
              {selectedUnitLabels.map((label) => (
                <li key={label} className="rounded-full border border-[#242d3f] bg-[#151b28] px-2 py-1">{label}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Applied Worktree Rules</p>
          {ruleRefs.length > 0 || ruleNames.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {(ruleRefs.length > 0 ? ruleRefs : ruleNames.map<JsonRecord>((name) => ({ name }))).slice(0, 10).map((rule, index) => {
                const mode = textValue(rule.mode) ?? ruleModes[index] ?? null;
                return (
                  <li key={`${labelForRecord(rule, "Rule")}-${index}`} className="rounded-md border border-[#242d3f] bg-[#151b28] p-2">
                    <span className="min-w-0 truncate font-medium">{labelForRecord(rule, `Rule ${index + 1}`)}</span>
                    {mode && <span className="ml-2 text-xs text-muted-foreground">{mode}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No rule refs attached to the active mission plan.</p>
          )}
        </section>

        <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Injected KB references/excerpts</p>
          {kbRefs.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {kbRefs.slice(0, 5).map((kb, index) => (
                <li key={`${labelForRecord(kb, "KB")}-${index}`} className="rounded-md border border-[#242d3f] bg-[#151b28] p-2">
                  <span className="min-w-0 truncate font-medium">{labelForRecord(kb, `KB ${index + 1}`)}</span>
                  {textValue(kb.excerpt) && <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#b6c2d6]">{textValue(kb.excerpt)}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No KB excerpts are attached to this active plan.</p>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Self-improvement candidates</p>
          <span className="text-xs text-muted-foreground">{selfImprovementCandidates.length} candidates</span>
        </div>
        {selfImprovementCandidates.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {selfImprovementCandidates.slice(0, 8).map((candidate, index) => {
              const assetType = textValue(candidate.assetType);
              const assetRef = textValue(candidate.assetRef) ?? labelForRecord(candidate, `Candidate ${index + 1}`);
              const result = textValue(candidate.autoAdoptionResult);
              const edit = proposedEditLabel(candidate);
              const gateOwner = textValue(candidate.gateOwner);
              const pattern = textValue(candidate.pattern);
              return (
                <li key={`${assetRef}-${index}`} className="rounded-md border border-[#242d3f] bg-[#151b28] p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[13px]">{assetRef}</span>
                    {result && <span className={`shrink-0 text-xs ${statusTone(result)}`}>{result}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {assetType && <span>{assetType}</span>}
                    {edit && <span>{edit}</span>}
                    {gateOwner && <span>gate: {gateOwner}</span>}
                  </div>
                  {pattern && <p className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[#b6c2d6]">{pattern}</p>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No self-improvement candidates attached to this active plan.</p>
        )}
      </section>

      <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Required inputs</p>
        {openRequiredInputs.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {openRequiredInputs.map((input) => <li key={input} className="rounded-full border border-[#242d3f] bg-[#151b28] px-2 py-1">{input}</li>)}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No open required inputs reported.</p>
        )}
      </section>

      <section className="rounded-lg border border-[#242d3f] bg-[#111622] p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Audit timeline</p>
        {auditEvents.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm">
            {auditEvents.slice(0, 8).map((event) => (
              <li key={event.id} className="rounded-md border border-[#242d3f] bg-[#151b28] p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[12px]">{event.action}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(event.createdAt)}</span>
                </div>
                {formatAuditEventSummary(event) && <p className="mt-1 text-xs text-muted-foreground">{formatAuditEventSummary(event)}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No route-level audit events recorded for this mission yet.
          </p>
        )}
      </section>
    </div>
  );
}

export function MissionDetail() {
  const { missionId } = useParams<{ missionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { openNewMission } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [selectedIssueId, setSelectedIssueIdState] = useState<string | null>(() => searchParams.get("issue"));

  const {
    data: mission,
    isLoading,
    isFetching: isMissionFetching,
    error,
  } = useQuery({
    queryKey: queryKeys.missions.detail(missionId!),
    queryFn: () => missionsApi.get(missionId!),
    enabled: !!missionId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // [수정 요청 미션] 원본 최종 산출물 URL 수집용 — MissionExecutionOverview와 동일 소스.
  const { data: revisionRunData } = useQuery({
    queryKey: queryKeys.missions.workflowRuns(missionId!),
    queryFn: () => missionsApi.listWorkflowRuns(missionId!),
    enabled: !!missionId,
  });

  const { data: missionActivity, isFetching: isMissionActivityFetching } = useQuery({
    queryKey: queryKeys.missions.activity(missionId!),
    queryFn: () => activityApi.list(selectedCompanyId!, { entityType: "mission", entityId: missionId! }),
    enabled: !!selectedCompanyId && !!missionId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  const updateMission = useMutation({
    mutationFn: (data: { title?: string; description?: string; status?: MissionStatus }) =>
      missionsApi.update(missionId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId) });
      }
    },
    // [계약] 서버(409 등)가 돌려준 사유를 그대로 노출한다 — 종단 상태가 정합/재오픈으로
    //   무효화된 경우 운영자가 200 인 줄 알고 넘어가지 않도록 한다.
    onError: (error) => {
      pushToast({
        title: "Mission update failed",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Missions", href: "/missions" },
      { label: mission?.title ?? missionId ?? "Mission" },
    ]);
  }, [setBreadcrumbs, mission, missionId]);

  useEffect(() => {
    setSelectedIssueIdState(searchParams.get("issue"));
  }, [missionId, searchParams]);

  function setSelectedIssueId(issueId: string | null) {
    setSelectedIssueIdState(issueId);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (issueId) next.set("issue", issueId);
      else next.delete("issue");
      return next;
    }, { replace: true });
  }

  function refreshMissionDetail() {
    if (!missionId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.issues(missionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.workflowRuns(missionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.governanceThread(missionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.delegations(missionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.activity(missionId) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId) });
    }
  }

  const isRefreshingMissionDetail = isMissionFetching || isMissionActivityFetching;

  if (!missionId) {
    return <div className="p-4 text-sm text-muted-foreground">No mission selected.</div>;
  }

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (error || !mission) {
    return (
      <div className="p-4">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load mission"}
        </p>
      </div>
    );
  }

  const plan = mission.activeMissionPlan;
  const primaryTransition = PRIMARY_TRANSITION[mission.status] ?? null;
  const metricLabel = "text-[10px] uppercase tracking-[0.08em]";

  return (
    <div className="space-y-3 tabular-nums">
      {/* 48px detail header — full-bleed inside <main> padding, sticky within the desktop scroll container. */}
      <header className="-mx-4 -mt-4 flex h-12 items-center gap-2 border-b border-[#242d3f] bg-[#0b0e14]/95 px-4 md:sticky md:top-0 md:z-10 md:-mx-6 md:-mt-6 md:px-6">
        <nav aria-label="Mission breadcrumb" className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-[#8b97ad]">
          <Link to="/missions" className="shrink-0 hover:text-[#e6edf7]">Missions</Link>
          <span aria-hidden className="shrink-0 text-[#4a5670]">/</span><span className="shrink-0 font-mono tabular-nums">{missionId.slice(0, 8)}</span>
        </nav>
        <div className="min-w-0 flex-1 truncate">
          <InlineEditor value={mission.title} onSave={(title) => updateMission.mutate({ title })}
            className="text-sm font-semibold leading-tight text-[#e6edf7]" placeholder="Mission title" />
        </div>
        <StatusPill status={mission.status} />
        {primaryTransition && (
          <Button size="sm" className="h-7 shrink-0 bg-[#2563eb] px-2.5 text-xs font-semibold text-[#f8fafc] hover:bg-[#1d4ed8]"
            onClick={() => updateMission.mutate({ status: primaryTransition.to })} disabled={updateMission.isPending}>
            {primaryTransition.label}
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-[#8b97ad] hover:text-[#e6edf7]"
          onClick={refreshMissionDetail} disabled={isRefreshingMissionDetail} title="Refresh mission detail" aria-label="Refresh mission detail">
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshingMissionDetail ? "animate-spin" : ""}`} />
          <span className="sr-only">Refresh mission detail</span>
        </Button>
      </header>

      {/* 1-row key-metric summary strip (secondary cells fold below sm; the row never wraps or widens the page). */}
      <div className="cockpit-strip w-full gap-0 overflow-hidden" role="group" aria-label="Mission summary">
        <span className="cockpit-cell min-w-0">
          <span className={metricLabel}>Main executor</span>
          <b className="truncate" title={agentMap[mission.ownerAgentId] ?? mission.ownerAgentId ?? undefined}>{agentMap[mission.ownerAgentId] ?? mission.ownerAgentId ?? "—"}</b>
        </span>
        <span className="cockpit-cell"><span className={metricLabel}>Duration</span><b>{formatDuration(mission.startedAt, mission.completedAt) ?? "—"}</b></span>
        <span className="cockpit-cell"><span className={metricLabel}>Plan</span><b>{plan?.available ? `rev ${plan.revision ?? "—"}` : "none"}</b></span>
        <span className="cockpit-cell"><span className={metricLabel}>Exec units</span><b>{plan?.executionUnitCount ?? 0}</b>{plan?.blockedOrFailedUnitCount ? <span className="text-[#f87171]">{plan.blockedOrFailedUnitCount} blocked/failed</span> : null}</span>
        {mission.project && (
          <span className="cockpit-cell min-w-0">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: mission.project.color ?? "#6366f1" }} />
            <span className={metricLabel}>Project</span>
            <b className="truncate" title={mission.project.name}>{mission.project.name}</b>
          </span>
        )}
        <span className="cockpit-cell hidden sm:inline-flex"><span className={metricLabel}>Started</span><b>{mission.startedAt ? formatDate(mission.startedAt) : "—"}</b></span>
        <span className="cockpit-cell hidden sm:inline-flex"><span className={metricLabel}>Created</span><b>{formatDate(mission.createdAt)}</b></span>
        {mission.completedAt && <span className="cockpit-cell hidden sm:inline-flex"><span className={metricLabel}>Completed</span><b>{formatDate(mission.completedAt)}</b></span>}
      </div>

      <section className="rounded-lg border border-[#242d3f] bg-[#111622] px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Description</p>
        <div className="mt-1.5 max-h-[32dvh] min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
          <InlineEditor
            value={mission.description ?? ""}
            onSave={(description) => updateMission.mutate({ description })}
            className="text-sm leading-relaxed max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            placeholder="Add a description..."
            multiline
          />
        </div>
      </section>

      <Tabs defaultValue="overview" className="w-full">
        {/* 32px cockpit toolbar: tabs left, secondary actions (revision + remaining status setters) right. */}
        <div className="cockpit-toolbar h-auto min-h-8 flex-wrap py-1">
          <TabsList variant="line" className="h-7 shrink-0">
            <TabsTrigger value="overview" className="gap-1.5 text-xs">
              <Rocket className="h-3.5 w-3.5" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="issues" className="gap-1.5 text-xs">
              <ListTree className="h-3.5 w-3.5" />
              Work
            </TabsTrigger>
            <TabsTrigger value="workflow" className="gap-1.5 text-xs">
              <GitBranch className="h-3.5 w-3.5" />
              Execution Flow
            </TabsTrigger>
            <TabsTrigger value="worktree" className="gap-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" />
              Execution Rules
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">
            <MissionRevisionActions
              companyId={selectedCompanyId}
              mission={mission}
              workflowRuns={revisionRunData ?? []}
              // origin은 클릭 시점에 window.location.origin으로 계약(컴포넌트 기본값) — node SSR 렌더 안전.
              issuePrefix={selectedCompany?.issuePrefix}
              onNewMission={openNewMission}
            />
            {STATUS_OPTIONS.filter((s) => s.value !== mission.status && s.value !== primaryTransition?.to).map((s) => (
              <Button key={s.value} variant="ghost" size="xs" className="h-6 shrink-0 text-[11px] text-[#8b97ad] hover:text-[#e6edf7]"
                onClick={() => updateMission.mutate({ status: s.value })} disabled={updateMission.isPending}>
                Set {s.label}
              </Button>
            ))}
          </div>
        </div>

        <TabsContent value="overview" className="mt-4 [&>div>div:first-child>div]:rounded-lg [&>div>div:first-child>div]:border [&>div>div:first-child>div]:border-[#242d3f] [&>div>div:first-child>div]:bg-[#111622] [&>div>div:first-child>div]:tabular-nums">
          <MissionExecutionOverview missionId={missionId} mission={mission} />
        </TabsContent>

        <TabsContent value="issues" className="mt-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(320px,1fr)_minmax(420px,1.3fr)]">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Mission work items
              </p>
              <MissionIssueTree
                missionId={missionId}
                selectedIssueId={selectedIssueId}
                onSelectIssue={setSelectedIssueId}
              />
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Selected work item
              </p>
              <MissionIssueInspector issueId={selectedIssueId} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="workflow" className="mt-4">
          {mission.sourceMissionId && <MissionRevisionStart missionId={mission.id} onStarted={() => { void queryClient.invalidateQueries(); }} />}
          <WorkflowDagPanel missionId={missionId} />
        </TabsContent>

        <TabsContent value="worktree" className="mt-4">
          <MissionExecutionRulesPanel plan={mission.activeMissionPlan} auditEvents={missionActivity ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
