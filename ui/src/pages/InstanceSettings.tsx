import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, ExternalLink, RefreshCw, Settings } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const CELL = "cockpit-cell min-w-0 flex-1 justify-center";
const PILL = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide";
const INTERVAL_INPUT =
  "h-7 w-20 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-right text-xs text-[#e6edf7] tabular-nums outline-none focus:border-[#5f8dff] aria-invalid:border-[#f87171]";
const SAVE_CTA = "h-6 bg-[#2563eb] px-2 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]";
const TOGGLE_CTA = "h-6 border border-[#242d3f] bg-[#111622] px-2 text-xs text-[#8b97ad] hover:bg-[#1a2131] hover:text-[#e6edf7]";
const MONO_SNIPPET = "whitespace-pre-wrap font-mono";

type HeartbeatPatch = {
  readonly enabled?: boolean;
  readonly intervalSec?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function buildAgentHref(agent: InstanceSchedulerHeartbeatAgent) {
  return `/${agent.companyIssuePrefix}/agents/${encodeURIComponent(agent.agentUrlKey)}`;
}

export function intervalMinutesValue(intervalSec: number): string {
  const minutes = Math.max(0, intervalSec) / 60;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

export function parseIntervalMinutesToSec(value: string): number | null {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return Math.round(minutes * 60);
}

export function formatHeartbeatInterval(intervalSec: number): string {
  if (intervalSec < 60) return `${intervalSec}s`;
  return `${intervalMinutesValue(intervalSec)} min`;
}

export function InstanceSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Heartbeats" },
    ]);
  }, [setBreadcrumbs]);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instance.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
  });

  const heartbeatMutation = useMutation({
    mutationFn: async (input: {
      readonly agentRow: InstanceSchedulerHeartbeatAgent;
      readonly patch: HeartbeatPatch;
    }) => {
      const { agentRow, patch } = input;
      const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
      const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
      const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

      return agentsApi.update(
        agentRow.id,
        {
          runtimeConfig: {
            ...runtimeConfig,
            heartbeat: {
              ...heartbeat,
              ...patch,
            },
          },
        },
        agentRow.companyId,
      );
    },
    onSuccess: async (_, input) => {
      setActionError(null);
      if (typeof input.patch.intervalSec === "number") {
        const intervalSec = input.patch.intervalSec;
        setIntervalDrafts((current) => ({
          ...current,
          [input.agentRow.id]: intervalMinutesValue(intervalSec),
        }));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(input.agentRow.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(input.agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update heartbeat.");
    },
  });

  const agents = heartbeatsQuery.data ?? [];
  const activeCount = agents.filter((agent) => agent.schedulerActive).length;
  const disabledCount = agents.length - activeCount;

  const grouped = useMemo(() => {
    const map = new Map<string, { companyName: string; agents: InstanceSchedulerHeartbeatAgent[] }>();
    for (const agent of agents) {
      let group = map.get(agent.companyId);
      if (!group) {
        group = { companyName: agent.companyName, agents: [] };
        map.set(agent.companyId, group);
      }
      group.agents.push(agent);
    }
    return [...map.values()];
  }, [agents]);

  const intervals = agents.map((agent) => agent.intervalSec);
  const fastestIntervalSec = intervals.length ? Math.min(...intervals) : null;

  if (heartbeatsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading scheduler heartbeats...</div>;
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : "Failed to load scheduler heartbeats."}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-2">
      {/* 1-row cockpit strip: roster · active/off split · company groups · fastest cadence */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Scheduler heartbeat summary">
        <div className={CELL}><span className="truncate uppercase tracking-wide">Heartbeats</span><b className="ml-1">{agents.length}</b></div>
        <div className={CELL}><span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#34d399]" /><span className="truncate uppercase tracking-wide">Active</span><b className="ml-1 text-[#34d399]">{activeCount}</b></div>
        <div className={CELL}><span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#5c6a84]" /><span className="truncate uppercase tracking-wide">Off</span><b className="ml-1">{disabledCount}</b></div>
        <div className={CELL}><span className="truncate uppercase tracking-wide">{grouped.length === 1 ? "Company" : "Companies"}</span><b className="ml-1">{grouped.length}</b></div>
        <div className={cn(CELL, "shrink-0")}><span className="truncate uppercase tracking-wide">Fastest</span><b className="ml-1 font-mono">{fastestIntervalSec === null ? "—" : formatHeartbeatInterval(fastestIntervalSec)}</b></div>
      </div>

      {/* Tight 40px toolbar: section title · scope note · refresh */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-3">
        <Settings className="h-3.5 w-3.5 shrink-0 text-[#8b97ad]" aria-hidden />
        <h1 className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[#e6edf7]">Scheduler Heartbeats</h1>
        <p className="min-w-0 truncate text-xs text-[#8b97ad]">Agents with a timer heartbeat enabled across all of your companies.</p>
        <Button variant="ghost" size="xs" onClick={() => void heartbeatsQuery.refetch()} disabled={heartbeatsQuery.isFetching}
          className={cn("ml-auto h-6 shrink-0 border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#8b97ad] hover:text-[#e6edf7]")}>
          <RefreshCw className={cn("h-3 w-3", heartbeatsQuery.isFetching && "animate-spin")} /> Refresh
        </Button>
      </div>

      {actionError && (
        <div role="alert" className="rounded-md border border-[#f87171]/40 bg-[#f87171]/5 px-3 py-2 text-xs text-[#f87171]">
          {actionError}
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message="No scheduler heartbeats match the current criteria."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <section key={group.companyName} aria-label={group.companyName} className="overflow-hidden rounded-md border border-[#242d3f] bg-[#111622]">
                <div className="flex items-center gap-2 border-b border-[#242d3f] bg-[#151b28] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad]">
                  <span className="min-w-0 flex-1 truncate">{group.companyName}</span>
                  <b className="font-mono text-[#e6edf7]">{group.agents.length}</b>
                </div>
                <div className="divide-y divide-[#242d3f]">
                  {group.agents.map((agent) => {
                    const draftValue = intervalDrafts[agent.id] ?? intervalMinutesValue(agent.intervalSec);
                    const parsedIntervalSec = parseIntervalMinutesToSec(draftValue);
                    const intervalInvalid = parsedIntervalSec === null;
                    const intervalDirty = parsedIntervalSec !== null && parsedIntervalSec !== agent.intervalSec;
                    const saving = heartbeatMutation.isPending && heartbeatMutation.variables?.agentRow.id === agent.id;
                    return (
                      <div
                        key={agent.id}
                        className="flex flex-col gap-2 px-3 py-2 text-xs transition-colors hover:bg-[#151b28] md:flex-row md:items-center"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className={cn(PILL, agent.schedulerActive ? "bg-[#34d399]/15 text-[#34d399]" : "bg-[#0b0e14] text-[#8b97ad] shadow-[inset_0_0_0_1px_#242d3f]")}>
                            {agent.schedulerActive ? "On" : "Off"}
                          </span>
                          <Link to={buildAgentHref(agent)} className="min-w-0 truncate font-medium text-[#e6edf7] hover:underline">
                            {agent.agentName}
                          </Link>
                          <span className="hidden min-w-0 truncate text-[#8b97ad] sm:inline">
                            {humanize(agent.title ?? agent.role)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 md:ml-auto md:shrink-0">
                          <b className="shrink-0 font-mono font-semibold text-[#e6edf7]">{formatHeartbeatInterval(agent.intervalSec)}</b>
                          <span
                            className="hidden min-w-0 truncate text-[#8b97ad] lg:inline"
                            title={agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : undefined}
                          >
                            {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "never"}
                          </span>
                          <label className="flex items-center gap-1.5 text-[#8b97ad]">
                            <span className="hidden lg:inline">Interval</span>
                            <Input
                              aria-label={`${agent.agentName} heartbeat interval minutes`}
                              aria-invalid={intervalInvalid}
                              className={INTERVAL_INPUT}
                              min={1}
                              step={1}
                              type="number"
                              value={draftValue}
                              onChange={(event) =>
                                setIntervalDrafts((current) => ({ ...current, [agent.id]: event.currentTarget.value }))}
                            />
                            <span>min</span>
                          </label>
                          <Button
                            variant="outline"
                            size="xs"
                            className={SAVE_CTA}
                            disabled={saving || intervalInvalid || !intervalDirty}
                            onClick={() => {
                              if (parsedIntervalSec === null) {
                                setActionError("Heartbeat interval must be at least 1 minute.");
                                return;
                              }
                              heartbeatMutation.mutate({
                                agentRow: agent,
                                patch: { intervalSec: parsedIntervalSec },
                              });
                            }}
                          >
                            Save
                          </Button>
                          <Link to={buildAgentHref(agent)} className="text-[#8b97ad] hover:text-[#e6edf7]" title="Full agent config">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          <Button
                            variant="ghost"
                            size="xs"
                            className={TOGGLE_CTA}
                            disabled={saving}
                            onClick={() =>
                              heartbeatMutation.mutate({
                                agentRow: agent,
                                patch: { enabled: !agent.heartbeatEnabled },
                              })}
                          >
                            {saving ? "..." : agent.heartbeatEnabled ? "Disable Timer Heartbeat" : "Enable Timer Heartbeat"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
