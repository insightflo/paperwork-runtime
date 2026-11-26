import { useEffect, useState } from "react";
import type { PatchInstanceExperimentalSettings } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { BroadSearchAllowlistSettings } from "../components/BroadSearchAllowlistSettings";
import { InstanceExperimentalToggles } from "../components/InstanceExperimentalToggles";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";

const PANEL =
  "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const cockpitSectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-[#8b97ad]";
const cockpitSectionOverrides =
  "[&>section]:rounded-[12px] [&>section]:border-slate-200/90 [&>section]:bg-white/95 [&>section]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] " +
  "dark:[&>section]:border-white/[0.08] dark:[&>section]:bg-[#0e131d] dark:[&>section]:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] " +
  "[&>section_h2]:text-[11px] [&>section_h2]:font-semibold [&>section_h2]:uppercase [&>section_h2]:tracking-wider [&>section_h2]:text-slate-600 dark:[&>section_h2]:text-[#8b97ad] " +
  "[&>section_p]:text-slate-500 dark:[&>section_p]:text-[#8b97ad] " +
  "[&_select]:border-slate-200/90 [&_select]:bg-white [&_select]:text-slate-900 dark:[&_select]:border-white/[0.1] dark:[&_select]:bg-[#090c12] dark:[&_select]:text-[#eef2f8] " +
  "[&_button[aria-pressed=true]]:bg-lime-600 dark:[&_button[aria-pressed=true]]:bg-[#a3e635] " +
  "[&_button[aria-pressed=false]]:bg-slate-300 dark:[&_button[aria-pressed=false]]:bg-[#151d2b] " +
  "[&_ul[aria-label]>li]:border-slate-200/90 [&_ul[aria-label]>li]:bg-slate-50 dark:[&_ul[aria-label]>li]:border-white/[0.08] dark:[&_ul[aria-label]>li]:bg-[#090c12]";

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "실험 기능" },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update experimental settings.");
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : "Failed to load experimental settings."}
      </div>
    );
  }

  const settings = experimentalQuery.data;
  const enabledCount = Object.values(settings ?? {}).filter((value) => value === true).length;
  const companyCount = settings?.broadSearchAllowedCompanyIdsV1?.length ?? 0;
  const missionCount = settings?.broadSearchAllowedMissionIdsV1?.length ?? 0;
  const agentCount = settings?.broadSearchAllowedAgentIdsV1?.length ?? 0;

  return (
    <div className={`max-w-4xl space-y-3 tabular-nums ${cockpitSectionOverrides}`}>
      <div className={`cockpit-strip h-8 w-full gap-0 overflow-hidden ${PANEL}`} role="group" aria-label="Experimental settings summary">
        <div className="cockpit-cell min-w-0 flex-1 justify-center">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime-500 shadow-[0_0_6px_rgba(163,230,53,0.45)] dark:bg-[#a3e635]" />
          <span className="truncate uppercase tracking-wide">Experiments</span>
          <b className="ml-1 font-mono">{enabledCount}</b>
        </div>
        <div className="cockpit-cell min-w-0 flex-1 justify-center">
          <span className="truncate uppercase tracking-wide">Companies</span>
          <b className="ml-1 font-mono">{companyCount}</b>
        </div>
        <div className="cockpit-cell min-w-0 flex-1 justify-center">
          <span className="truncate uppercase tracking-wide">Missions</span>
          <b className="ml-1 font-mono">{missionCount}</b>
        </div>
        <div className="cockpit-cell min-w-0 flex-1 justify-center">
          <span className="truncate uppercase tracking-wide">Agents</span>
          <b className="ml-1 font-mono">{agentCount}</b>
        </div>
      </div>

      <div className={`cockpit-toolbar h-10 rounded-[12px] px-3 ${PANEL}`}>
        <FlaskConical className="h-4 w-4 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
        <h1 className={cockpitSectionHeader}>실험 기능</h1>
        <p className="min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad]">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      {actionError && (
        <div className="rounded-[10px] border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
          {actionError}
        </div>
      )}

      <BroadSearchAllowlistSettings
        settings={experimentalQuery.data}
        pending={toggleMutation.isPending}
        onSave={(patch) => toggleMutation.mutateAsync(patch)}
      />
      <InstanceExperimentalToggles
        settings={experimentalQuery.data}
        pending={toggleMutation.isPending}
        onToggle={(patch) => toggleMutation.mutate(patch)}
      />
    </div>
  );
}
