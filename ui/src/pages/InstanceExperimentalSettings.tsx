import { useEffect, useState } from "react";
import type { PatchInstanceExperimentalSettings } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { BroadSearchAllowlistSettings } from "../components/BroadSearchAllowlistSettings";
import { InstanceExperimentalToggles } from "../components/InstanceExperimentalToggles";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";

const cockpitSectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
const cockpitPanel = "rounded-md border border-border/80 bg-card/60";
const cockpitSectionOverrides =
  "[&>section]:rounded-md [&>section]:border [&>section]:border-border/80 [&>section]:bg-card/60 [&>section]:p-4 " +
  "[&>section_h2]:text-[11px] [&>section_h2]:font-semibold [&>section_h2]:uppercase [&>section_h2]:tracking-wider [&>section_h2]:text-muted-foreground";

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

  return (
    <div className={`max-w-4xl space-y-6 tabular-nums ${cockpitSectionOverrides}`}>
      <div className={`${cockpitPanel} px-4 py-3`}>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <h1 className={cockpitSectionHeader}>실험 기능</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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
