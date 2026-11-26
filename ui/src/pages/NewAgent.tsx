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

const SUPPORTED_ADVANCED_ADAPTER_TYPES = new Set<CreateConfigValues["adapterType"]>(["claude_local", "codex_local", "hermes_local", "commandcode_local", "pi_local"]);

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
/** Hairline card: #151b28 body inside a 1px #242d3f border. */
const HAIRLINE_CARD = "min-w-0 rounded-md border border-[#242d3f] bg-[#151b28]";
const CTA_PRIMARY = "h-7 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]";
const CTA_GHOST = "h-7 border-[#242d3f] bg-[#0b0e14] px-2.5 text-xs text-[#e6edf7] hover:bg-[#151b28]";
/** Descendant override so AgentConfigForm's "cards" sections inherit the hairline card look. */
const HAIRLINE_DESCENDANTS = "[&_.border.rounded-lg]:rounded-md [&_.border.rounded-lg.border-border]:border-[#242d3f] [&_.border.rounded-lg.border-border]:bg-[#151b28]";

/** One cell of the 1-row cockpit strip: micro status dot (optional) · uppercase label · bold tabular fact. */
function StripFact({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <span className="cockpit-cell min-w-0 flex-1">
      {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate uppercase tracking-wide">{label}</span>
      <b className="truncate normal-case tracking-normal" title={value}>{value}</b>
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
  const { selectedCompanyId } = useCompany();
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
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "New Agent" },
    ]);
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
    <div className="mx-auto max-w-2xl space-y-2 tabular-nums">
      {/* 1-row 6-cell cockpit strip: the configuration in progress at a glance */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="New agent summary">
        <StripFact label="Role" value={roleLabels[effectiveRole] ?? effectiveRole} dot={isFirstAgent ? "bg-[#fbbf24]" : "bg-[#5f8dff]"} />
        <StripFact label="Reports to" value={reportsToName} />
        <StripFact label="Adapter" value={configValues.adapterType} />
        <StripFact label="Model" value={configValues.model || "—"} />
        <StripFact label="Skills" value={`${selectedSkillKeys.length}/${availableSkills.length}`} />
        <StripFact label="Heartbeat" value={`${configValues.heartbeatEnabled ? "On" : "Off"} · ${configValues.intervalSec}s`} dot={configValues.heartbeatEnabled ? "bg-[#34d399]" : "bg-[#8b97ad]"} />
      </div>

      {/* Tight single-row 40px toolbar: title · scope · CEO notice (actions live in the footer of this long form). */}
      <div className="cockpit-toolbar h-10 w-full rounded-md border border-[#242d3f] bg-[#111622] pl-2 pr-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h1 className="shrink-0 text-sm font-semibold text-[#e6edf7]">New Agent</h1>
          <p className="min-w-0 truncate text-xs text-[#8b97ad]">Advanced agent configuration</p>
        </div>
        {isFirstAgent && (
          <span className="shrink-0 rounded-full border border-[#fbbf24]/40 bg-[#fbbf24]/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#fbbf24]">CEO</span>
        )}
      </div>

      <div className={cn(HAIRLINE_CARD, "divide-y divide-[#242d3f]")}>
        {/* Name */}
        <div className="px-4 pb-2 pt-4">
          <input
            className="w-full bg-transparent text-lg font-semibold text-[#e6edf7] outline-none placeholder:text-[#8b97ad]/50"
            placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Title */}
        <div className="px-4 pb-3">
          <input
            className="w-full bg-transparent text-sm text-[#8b97ad] outline-none placeholder:text-[#8b97ad]/40"
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
                className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#e6edf7] transition-colors hover:bg-[#151b28]", isFirstAgent && "cursor-not-allowed opacity-60")}
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

      {/* Shared config form */}
      <div className={HAIRLINE_DESCENDANTS}>
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
            <h2 className="text-xs font-semibold text-[#e6edf7]">Company skills</h2>
            <p className="mt-1 text-xs text-[#8b97ad]">
              Optional skills from the company library. Built-in Paperwork runtime skills are added automatically.
            </p>
          </div>
          {availableSkills.length === 0 ? (
            <p className="text-xs text-[#8b97ad]">No optional company skills installed yet.</p>
          ) : (
            <div className="divide-y divide-[#242d3f]/70">
              {availableSkills.map((skill) => (
                <div key={skill.id} className="flex items-start gap-3">
                  <Checkbox id={`skill-${skill.id}`} checked={selectedSkillKeys.includes(skill.key)} onCheckedChange={(next) => toggleSkill(skill.key, next === true)} />
                  <label htmlFor={`skill-${skill.id}`} className="grid min-w-0 flex-1 gap-1 py-2 leading-none">
                    <span className="min-w-0 truncate text-sm font-medium text-[#e6edf7]">{skill.name}</span>
                    <span className="min-w-0 break-words font-mono text-xs text-[#8b97ad]">{skill.description ?? skill.key}</span>
                  </label>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Footer: status notes + actions; the cobalt Create agent is the page's single primary CTA. */}
      <div className={cn(HAIRLINE_CARD, "flex flex-wrap items-center gap-3 px-4 py-2")}>
        <div className="min-w-0 flex-1 space-y-1">
          {isFirstAgent && <p className="text-xs text-[#fbbf24]">This will be the CEO</p>}
          {formError && <p role="alert" className="whitespace-pre-wrap font-mono text-xs text-[#f87171]">{formError}</p>}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/agents")} className={CTA_GHOST}>Cancel</Button>
          <Button size="sm" disabled={!name.trim() || createAgent.isPending} onClick={handleSubmit} className={CTA_PRIMARY}>
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </div>
    </div>
  );
}
