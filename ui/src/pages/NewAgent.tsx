import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Shield } from "lucide-react";
import { cn, agentUrl } from "../lib/utils";
import { roleLabels } from "../components/agent-config-primitives";
import { AgentConfigForm, type CreateConfigValues } from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { ReportsToPicker } from "../components/ReportsToPicker";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";

const SUPPORTED_ADVANCED_ADAPTER_TYPES = new Set<CreateConfigValues["adapterType"]>(["claude_local", "codex_local", "commandcode_local", "pi_local", "devin_local"]);

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
/** Hairline card: #151b28 body inside a 1px #242d3f border. */
const HAIRLINE_CARD = "min-w-0 rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const CTA_PRIMARY = "h-7 border-0 bg-blue-600 px-2.5 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] hover:bg-blue-500 dark:bg-[#60a5fa] dark:text-[#07111f] dark:hover:bg-[#7bb7ff]";
const CTA_GHOST = "h-7 border-slate-200/80 bg-white px-2.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#edf2fb] dark:hover:bg-[#141b29]";
/** Descendant override so AgentConfigForm's "cards" sections inherit the hairline card look. */
const HAIRLINE_DESCENDANTS = "[&_.border.rounded-lg]:rounded-xl [&_.border.rounded-lg.border-border]:border-slate-200/90 [&_.border.rounded-lg.border-border]:bg-white [&_.border.rounded-lg.border-border]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:[&_.border.rounded-lg.border-border]:border-white/[0.08] dark:[&_.border.rounded-lg.border-border]:bg-[#0e131d] dark:[&_.border.rounded-lg.border-border]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]";

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="flex h-10 min-w-0 items-center justify-center gap-1.5 px-2 text-xs text-slate-600 dark:text-[#8b97ad]">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="truncate font-semibold normal-case tracking-normal text-slate-950 dark:text-[#edf2fb]" title={value}>{value}</b>
    </span>
  );
}

function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  const nextValues: CreateConfigValues = { ...defaults, adapterType };
  if (adapterType === "codex_local") {
    nextValues.model = DEFAULT_CODEX_LOCAL_MODEL;
    nextValues.dangerouslyBypassSandbox =
      DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  } else if (adapterType === "commandcode_local") {
    nextValues.model = "";
    nextValues.dangerouslySkipPermissions = false;
  }
  return nextValues;
}

export function NewAgent() {
  const { selectedCompanyId, canWrite = true } = useCompany();
  // [RBAC] 에이전트 생성은 쓰기 권한(canWrite) 필요.
  const writeRequiredTitle = "Member, admin, or owner role required to create agents";
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetAdapterType = searchParams.get("adapterType");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("general");
  const [reportsTo, setReportsTo] = useState<string | null>(null);
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [roleOpen, setRoleOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: adapterModels } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModels(selectedCompanyId, configValues.adapterType)
      : ["agents", "none", "adapter-models", configValues.adapterType],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, configValues.adapterType),
    enabled: Boolean(selectedCompanyId),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const isFirstAgent = !agents || agents.length === 0;
  const effectiveRole = isFirstAgent ? "ceo" : role;

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents", href: "/agents" }, { label: "New Agent" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (isFirstAgent) {
      if (!name) setName("CEO");
      if (!title) setTitle("CEO");
    }
  }, [isFirstAgent, name, title]);

  useEffect(() => {
    const requested = presetAdapterType;
    if (!requested) return;
    if (!SUPPORTED_ADVANCED_ADAPTER_TYPES.has(requested as CreateConfigValues["adapterType"])) {
      return;
    }
    setConfigValues((prev) => {
      if (prev.adapterType === requested) return prev;
      return createValuesForAdapterType(requested as CreateConfigValues["adapterType"]);
    });
  }, [presetAdapterType]);

  const createAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      agentsApi.hire(selectedCompanyId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(agentUrl(result.agent));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function handleSubmit() {
    if (!canWrite) return;
    if (!selectedCompanyId || !name.trim()) return;
    setFormError(null);
    createAgent.mutate({
      name: name.trim(),
      role: effectiveRole,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(reportsTo ? { reportsTo } : {}),
      ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
      adapterType: configValues.adapterType,
      adapterConfig: getUIAdapter(configValues.adapterType).buildAdapterConfig(configValues),
      runtimeConfig: {
        heartbeat: {
          enabled: configValues.heartbeatEnabled,
          intervalSec: configValues.intervalSec,
          wakeOnDemand: true,
          cooldownSec: 10,
          maxConcurrentRuns: 1,
        },
      },
      budgetMonthlyCents: 0,
    });
  }

  const availableSkills = (companySkills ?? []).filter((skill) => !skill.key.startsWith("paperclipai/paperclip/"));

  function toggleSkill(key: string, checked: boolean) {
    setSelectedSkillKeys((prev) =>
      checked ? (prev.includes(key) ? prev : [...prev, key]) : prev.filter((value) => value !== key));
  }

  const reportsToName = reportsTo ? agents?.find((agent) => agent.id === reportsTo)?.name ?? reportsTo : "—";

  return (
    <div className="w-full space-y-3 tabular-nums">
      {/* 1-row 6-cell cockpit strip: the configuration in progress at a glance */}
      <div className="grid w-full grid-cols-2 divide-x divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:divide-white/[0.06] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)] sm:grid-cols-3 xl:grid-cols-6" role="group" aria-label="New agent summary">
        <StripFact label="Role" value={roleLabels[effectiveRole] ?? effectiveRole} dot={isFirstAgent ? "bg-amber-500 dark:bg-[#f59e0b]" : "bg-blue-500 dark:bg-[#60a5fa]"} />
        <StripFact label="Reports to" value={reportsToName} />
        <StripFact label="Adapter" value={configValues.adapterType} />
        <StripFact label="Model" value={configValues.model || "—"} />
        <StripFact label="Skills" value={`${selectedSkillKeys.length}/${availableSkills.length}`} />
        <StripFact label="Heartbeat" value={`${configValues.heartbeatEnabled ? "On" : "Off"} · ${configValues.intervalSec}s`} dot={configValues.heartbeatEnabled ? "bg-lime-500 dark:bg-[#a3e635]" : "bg-slate-400 dark:bg-[#8b97ad]"} />
      </div>

      {/* Tight single-row 40px toolbar: title · scope · CEO notice (actions live in the footer of this long form). */}
      <div className="cockpit-toolbar h-10 w-full rounded-xl border border-slate-200/90 bg-white pl-2 pr-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h1 className="shrink-0 text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">New Agent</h1>
          <p className="min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad]">Advanced agent configuration</p>
        </div>
        {isFirstAgent && (
          <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 dark:border-[#f59e0b]/40 dark:bg-[#f59e0b]/10 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:text-[#f59e0b]">CEO</span>
        )}
      </div>

      <div className={cn(HAIRLINE_CARD, "divide-y divide-slate-200/80 dark:divide-white/[0.06]")}>
        {/* Name */}
        <div className="px-4 pb-2 pt-4">
          <input
            className="w-full bg-transparent text-lg font-semibold text-slate-950 dark:text-[#edf2fb] outline-none placeholder:text-slate-400 dark:placeholder:text-[#8b97ad]/50"
            placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Title */}
        <div className="px-4 pb-3">
          <input
            className="w-full bg-transparent text-sm text-slate-500 dark:text-[#8b97ad] outline-none placeholder:text-slate-400 dark:placeholder:text-[#8b97ad]/40"
            placeholder="Title (e.g. VP of Engineering)"
            aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Property chips: Role + Reports To */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
          <Popover open={roleOpen} onOpenChange={setRoleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200/80 dark:border-white/[0.08] bg-slate-100/80 dark:bg-[#090c12] px-2 text-xs text-slate-950 dark:text-[#edf2fb] transition-colors hover:bg-slate-50 dark:hover:bg-[#141b29]", isFirstAgent && "cursor-not-allowed opacity-60")}
                disabled={isFirstAgent}
              >
                <Shield className="h-3 w-3 text-muted-foreground" />
                {roleLabels[effectiveRole] ?? effectiveRole}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {AGENT_ROLES.map((r) => (
                <button
                  type="button"
                  key={r}
                  className={cn("flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50", r === role && "bg-accent")}
                  onClick={() => { setRole(r); setRoleOpen(false); }}
                >
                  {roleLabels[r] ?? r}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <ReportsToPicker agents={agents ?? []} value={reportsTo} onChange={setReportsTo} disabled={isFirstAgent} />
        </div>
      </div>

      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        {/* Shared config form */}
        <div className={cn(HAIRLINE_DESCENDANTS, "min-w-0")}>
          <AgentConfigForm
            mode="create"
            values={configValues}
            onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
            adapterModels={adapterModels}
            sectionLayout="cards"
          />
        </div>

        <section aria-label="Company skills" className={cn(HAIRLINE_CARD, "px-4 py-4")}>
          <div className="space-y-3">
            <div>
              <h2 className="text-xs font-semibold text-slate-950 dark:text-[#edf2fb]">Company skills</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">
                Optional skills from the company library. Built-in Paperwork runtime skills are added automatically.
              </p>
            </div>
            {availableSkills.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8b97ad]">No optional company skills installed yet.</p>
            ) : (
              <div className="divide-y divide-slate-200/70 dark:divide-white/[0.06]">
                {availableSkills.map((skill) => (
                  <div key={skill.id} className="flex items-start gap-3">
                    <Checkbox id={`skill-${skill.id}`} checked={selectedSkillKeys.includes(skill.key)} onCheckedChange={(next) => toggleSkill(skill.key, next === true)} />
                    <label htmlFor={`skill-${skill.id}`} className="grid min-w-0 flex-1 gap-1 py-2 leading-none">
                      <span className="min-w-0 truncate text-sm font-medium text-slate-950 dark:text-[#edf2fb]">{skill.name}</span>
                      <span className="min-w-0 break-words font-mono text-xs text-slate-500 dark:text-[#8b97ad]">{skill.description ?? skill.key}</span>
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Footer: status notes + actions; the cobalt Create agent is the page's single primary CTA. */}
      <div className={cn(HAIRLINE_CARD, "flex flex-wrap items-center gap-3 px-4 py-2")}>
        <div className="min-w-0 flex-1 space-y-1">
          {isFirstAgent && <p className="text-xs text-amber-700 dark:text-[#f59e0b]">This will be the CEO</p>}
          {formError && <p role="alert" className="whitespace-pre-wrap font-mono text-xs text-rose-700 dark:text-[#f87171]">{formError}</p>}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/agents")} className={CTA_GHOST}>Cancel</Button>
          <Button size="sm" disabled={!canWrite || !name.trim() || createAgent.isPending} onClick={handleSubmit} title={!canWrite ? writeRequiredTitle : undefined} className={cn(CTA_PRIMARY, "disabled:cursor-not-allowed disabled:opacity-50")}>
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </div>
    </div>
  );
}
