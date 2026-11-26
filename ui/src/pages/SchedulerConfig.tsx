import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { schedulerApi, type Schedule, type CreateScheduleInput } from "../api/scheduler";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, Plus, Trash2, CalendarClock, ToggleLeft, ToggleRight } from "lucide-react";
import { cn } from "../lib/utils";

// Cockpit primitives (approved Linear + Datadog palette; mirrors .cockpit-strip/.cockpit-toolbar).
const CARD = "rounded-md border border-[#242d3f] bg-[#151b28]";
const FIELD = "rounded-md border border-[#242d3f] bg-[#111622] text-[#e6edf7] outline-none focus:border-[#5f8dff] focus:ring-[#5f8dff]/40";
const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad]";
const CTA = "bg-[#2563eb] text-[#f8fafc] hover:bg-[#5f8dff]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function formatShort(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

const CRON_PRESETS = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
];

// ---------------------------------------------------------------------------
// CreateScheduleForm
// ---------------------------------------------------------------------------

interface CreateScheduleFormProps {
  companyId: string;
  onCreated: () => void;
  onCancel: () => void;
}

function CreateScheduleForm({ companyId, onCreated, onCancel }: CreateScheduleFormProps) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState("");
  const [cronExpression, setCronExpression] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [formError, setFormError] = useState<string | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateScheduleInput) => schedulerApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list(companyId) });
      onCreated();
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to create schedule");
    },
  });

  function handlePreset(value: string) {
    if (value !== "__custom__") setCronExpression(value);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!agentId) { setFormError("Agent is required"); return; }
    if (!cronExpression.trim()) { setFormError("Cron expression is required"); return; }
    createMutation.mutate({ agentId, cronExpression: cronExpression.trim(), timezone });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`space-y-4 ${CARD} p-4`}
    >
      <p className={LABEL}>New Schedule</p>

      {/* Agent */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[#8b97ad]">Agent</label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select agent..." />
          </SelectTrigger>
          <SelectContent>
            {(agents ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Cron preset */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[#8b97ad]">Preset</label>
        <Select onValueChange={handlePreset} defaultValue="__custom__">
          <SelectTrigger className="h-8 text-sm tabular-nums">
            <SelectValue placeholder="Choose preset..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__custom__">Custom</SelectItem>
            {CRON_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value} className="tabular-nums">{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Cron expression */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[#8b97ad]">Cron expression</label>
        <Input
          className={`h-8 text-sm font-mono tabular-nums ${FIELD}`}
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          placeholder="* * * * *"
        />
        <p className="text-xs text-muted-foreground">
          Format: minute hour day-of-month month day-of-week
        </p>
      </div>

      {/* Timezone */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[#8b97ad]">Timezone</label>
        <Input
          className={`h-8 text-sm ${FIELD}`}
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="UTC"
        />
      </div>

      {formError && (
        <p className="text-xs text-destructive">{formError}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" className={`h-7 text-xs ${CTA}`} disabled={createMutation.isPending}>
          {createMutation.isPending ? "Creating..." : "Create schedule"}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ScheduleRow
// ---------------------------------------------------------------------------

interface ScheduleRowProps {
  schedule: Schedule;
  agentName: string;
  companyId: string;
}

function ScheduleRow({ schedule, agentName, companyId }: ScheduleRowProps) {
  const queryClient = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      schedulerApi.update(schedule.id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list(companyId) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => schedulerApi.remove(schedule.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list(companyId) });
    },
  });

  return (
    <div className={cn(
      "grid grid-cols-[1rem_minmax(0,1fr)_2rem_2rem] items-center gap-3 px-4 py-2.5 text-sm sm:grid-cols-[1rem_minmax(0,1fr)_10.5rem_10.5rem_2rem_2rem]",
      CARD,
      !schedule.enabled && "opacity-60",
    )}>
      {/* Icon */}
      <Clock className="h-4 w-4 shrink-0 text-[#8b97ad]" />

      {/* Cron + agent */}
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-mono text-xs font-medium tabular-nums text-[#e6edf7]">{schedule.cronExpression}</p>
        <div className="flex min-w-0 items-center gap-2 text-xs text-[#8b97ad]">
          <span className="min-w-0 truncate">{agentName}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0 tabular-nums">{schedule.timezone}</span>
        </div>
      </div>

      {/* Next run */}
      <div className="hidden min-w-0 text-right sm:block">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8b97ad]">Next</p>
        <p className="truncate text-xs font-medium tabular-nums text-[#e6edf7]">{formatDate(schedule.nextRunAt)}</p>
      </div>

      {/* Last run */}
      <div className="hidden min-w-0 text-right sm:block">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8b97ad]">Last</p>
        <p className="truncate text-xs tabular-nums">{formatDate(schedule.lastRunAt)}</p>
      </div>

      {/* Toggle */}
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("h-7 w-7 justify-self-center", schedule.enabled ? "text-[#34d399] hover:text-[#34d399]" : "text-[#8b97ad] hover:text-[#e6edf7]")}
        onClick={() => toggleMutation.mutate(!schedule.enabled)}
        disabled={toggleMutation.isPending}
        title={schedule.enabled ? "Disable schedule" : "Enable schedule"}
      >
        {schedule.enabled
          ? <ToggleRight className="h-4 w-4" />
          : <ToggleLeft className="h-4 w-4" />}
      </Button>

      {/* Delete */}
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-7 w-7 justify-self-center text-[#8b97ad] hover:text-destructive"
        onClick={() => deleteMutation.mutate()}
        disabled={deleteMutation.isPending}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchedulerConfig page
// ---------------------------------------------------------------------------

export function SchedulerConfig() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Scheduler" }]);
  }, [setBreadcrumbs]);

  const { data: schedules, isLoading, error } = useQuery({
    queryKey: queryKeys.scheduler.list(selectedCompanyId!),
    queryFn: () => schedulerApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarClock} message="Select a company to view schedules." />;
  }

  const list = schedules ?? [];
  const enabledCount = list.filter((s) => s.enabled).length;
  const nextRunAt = list
    .filter((s) => s.enabled && s.nextRunAt)
    .map((s) => s.nextRunAt as string)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const strip = [
    { label: "Schedules", value: schedules ? list.length : "—", dot: "bg-[#5f8dff]" },
    { label: "Enabled", value: schedules ? enabledCount : "—", dot: "bg-[#34d399]" },
    { label: "Disabled", value: schedules ? list.length - enabledCount : "—", dot: "bg-[#8b97ad]" },
    { label: "Next run", value: nextRunAt ? formatShort(nextRunAt) : "—", dot: "bg-[#fbbf24]" },
  ];

  return (
    <div className="space-y-2 tabular-nums">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* 1-row 4-column cockpit strip */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Scheduler summary">
        {strip.map((cell) => (
          <div key={cell.label} className="cockpit-cell min-w-0 flex-1 justify-center">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1">{cell.value}</b>
          </div>
        ))}
      </div>

      {/* 40px unified toolbar */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-sm font-semibold text-[#e6edf7]">Scheduler</h1>
          <span className="truncate text-xs text-[#8b97ad]">Cron-based agent wakeup schedules</span>
        </div>
        <button
          type="button"
          aria-pressed={showForm}
          onClick={() => setShowForm((v) => !v)}
          className="ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-[#2563eb] px-2.5 text-xs font-medium text-[#f8fafc] transition-colors hover:bg-[#5f8dff]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />New Schedule
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <CreateScheduleForm
          companyId={selectedCompanyId}
          onCreated={() => setShowForm(false)}
          onCancel={() => setShowForm(false)}
        />
      )}

      {isLoading && <PageSkeleton variant="list" />}

      {/* Empty state */}
      {!isLoading && schedules && schedules.length === 0 && !showForm && (
        <EmptyState
          icon={CalendarClock}
          message="No schedules yet."
          action="New Schedule"
          onAction={() => setShowForm(true)}
        />
      )}

      {/* Schedule list: explicit column tracks keep columns from overlapping */}
      {!isLoading && schedules && schedules.length > 0 && (
        <div className={`grid grid-cols-[1rem_minmax(0,1fr)_2rem_2rem] items-center gap-3 border-b border-[#242d3f] px-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad] sm:grid-cols-[1rem_minmax(0,1fr)_10.5rem_10.5rem_2rem_2rem]`}>
          <span />
          <span>Cron</span>
          <span className="hidden text-right sm:block">Next run</span>
          <span className="hidden text-right sm:block">Last run</span>
          <span className="sr-only">Enabled</span>
          <span className="sr-only">Delete</span>
        </div>
      )}
      {!isLoading && schedules && schedules.length > 0 && (
        <div className="space-y-1.5">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agentName={agentMap[schedule.agentId] ?? schedule.agentId}
              companyId={selectedCompanyId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
