import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FilePlus2, RefreshCw, Save, Trash } from "lucide-react";
import type { MissionPlanTemplate } from "@paperclipai/shared";
import { missionPlanTemplatesApi } from "../api/companyInstructions";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

type Draft = Pick<MissionPlanTemplate, "name" | "selectionDescription" | "instructions" | "enabled">;

const EMPTY_DRAFT: Draft = { name: "", selectionDescription: "", instructions: "", enabled: true };
const PANEL =
  "tactile-card rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const CONTROL =
  "rounded-lg border-slate-200/90 bg-white text-xs text-slate-900 placeholder:text-slate-400 focus-visible:border-blue-500 focus-visible:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:placeholder:text-[#627089] dark:focus-visible:border-[#60a5fa] dark:focus-visible:ring-[#60a5fa]/25";
const OUTLINE_BUTTON =
  "border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";
const PRIMARY_BUTTON =
  "border border-blue-700/20 bg-blue-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-blue-500 dark:border-[#60a5fa]/35 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]";
const MUTED = "text-slate-500 dark:text-[#8b97ad]";
const LABEL = "text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]";

export function PlanTemplatesPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const listQuery = useQuery({
    queryKey: queryKeys.missionPlanTemplates.list(companyId),
    queryFn: () => missionPlanTemplatesApi.list(companyId),
  });
  const templates = listQuery.data?.templates ?? [];
  const selected = templates.find((template) => template.id === selectedId) ?? null;

  useEffect(() => {
    if (!creating && !selectedId && templates[0]) setSelectedId(templates[0].id);
  }, [creating, selectedId, templates]);

  useEffect(() => {
    if (selected && !creating) {
      setDraft({
        name: selected.name,
        selectionDescription: selected.selectionDescription,
        instructions: selected.instructions,
        enabled: selected.enabled,
      });
    }
  }, [creating, selected]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.missionPlanTemplates.list(companyId) });
  };

  const saveMutation = useMutation({
    mutationFn: () => creating
      ? missionPlanTemplatesApi.create(companyId, {
          name: draft.name,
          selectionDescription: draft.selectionDescription,
          instructions: draft.instructions,
        })
      : missionPlanTemplatesApi.update(companyId, selected!.id, selected?.origin === "system_default"
          ? { enabled: draft.enabled }
          : draft),
    onSuccess: async (template) => {
      setCreating(false);
      setSelectedId(template.id);
      await refresh();
      pushToast({ tone: "success", title: creating ? "Plan template created" : "Plan template saved", body: template.name });
    },
    onError: (error) => pushToast({ tone: "error", title: "Save failed", body: error instanceof Error ? error.message : "Unable to save plan template." }),
  });

  const duplicateMutation = useMutation({
    mutationFn: () => missionPlanTemplatesApi.duplicate(companyId, selected!.id),
    onSuccess: async (template) => {
      setSelectedId(template.id);
      await refresh();
      pushToast({ tone: "success", title: "Plan template duplicated", body: template.name });
    },
    onError: (error) => pushToast({ tone: "error", title: "Duplicate failed", body: error instanceof Error ? error.message : "Unable to duplicate plan template." }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => missionPlanTemplatesApi.remove(companyId, selected!.id),
    onSuccess: async () => {
      setSelectedId(null);
      await refresh();
      pushToast({ tone: "success", title: "Plan template deleted" });
    },
    onError: (error) => pushToast({ tone: "error", title: "Delete failed", body: error instanceof Error ? error.message : "Unable to delete plan template." }),
  });

  const readOnly = selected?.origin === "system_default" && !creating;
  const canSave = Boolean(draft.name.trim() && draft.selectionDescription.trim() && draft.instructions.trim() && (creating || selected));

  return (
    <div className="grid min-h-[calc(100vh-15rem)] gap-3 tabular-nums text-slate-900 dark:text-[#edf2fb] xl:grid-cols-[19rem_minmax(0,1fr)]">
      <aside className={cn(PANEL, "flex min-w-0 flex-col overflow-hidden")}>
        <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-2.5 dark:border-white/[0.07]">
          <div className="min-w-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Plan templates</h2>
            <p className={cn("mt-0.5 text-xs tabular-nums", MUTED)}><b className="font-mono font-semibold text-slate-950 dark:text-[#eef2f8]">{templates.length}</b> templates</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => listQuery.refetch()} title="Refresh plan templates" className="size-7 text-slate-500 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:bg-white/[0.05] dark:hover:text-[#eef2f8]">
            <RefreshCw className={cn("h-3.5 w-3.5", listQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
        <div className="border-b border-slate-200/80 p-2.5 dark:border-white/[0.07]">
          <Button
            variant="outline"
            size="sm"
            className={cn(OUTLINE_BUTTON, "h-8 w-full")}
            onClick={() => { setCreating(true); setSelectedId(null); setDraft(EMPTY_DRAFT); }}
          >
            <FilePlus2 className="mr-2 h-4 w-4 text-blue-600 dark:text-[#60a5fa]" />New custom template
          </Button>
        </div>
        {listQuery.isLoading ? <div className={cn("p-4 text-sm", MUTED)}>Loading templates…</div>
          : listQuery.error ? <div className="p-4 text-sm text-rose-700 dark:text-[#fb7185]">{listQuery.error.message}</div> : (
          <div className="py-1.5">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => { setCreating(false); setSelectedId(template.id); }}
                className={cn(
                  "flex w-full items-start gap-2 border-l-2 border-transparent px-4 py-3 text-left transition-[background-color,border-color] duration-150 hover:bg-slate-50 dark:hover:bg-white/[0.035]",
                  template.id === selectedId && !creating
                    ? "border-blue-600 bg-blue-500/10 dark:border-[#60a5fa] dark:bg-[#60a5fa]/10"
                    : "",
                )}
              >
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", template.enabled ? "bg-lime-500 shadow-[0_0_7px_rgba(163,230,53,0.35)] dark:bg-[#a3e635]" : "bg-slate-400/60 dark:bg-[#627089]")} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-950 dark:text-[#eef2f8]">{template.name}</span>
                  <span className={cn("mt-0.5 block line-clamp-2 text-xs", MUTED)}>{template.selectionDescription}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className={cn(PANEL, "min-w-0 space-y-5 p-4")}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 pb-3 dark:border-white/[0.07]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">{creating ? "New plan template" : selected?.name ?? "Select a plan template"}</h2>
              {selected && (
                <Badge variant="outline" className="border-blue-600/25 bg-blue-500/10 text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa]">
                  {selected.origin === "system_default" ? "Default" : "Custom"}
                </Badge>
              )}
            </div>
            <p className={cn("mt-1 text-xs", MUTED)}>Agents see the name and selection guidance, then fetch the full template when it applies.</p>
          </div>
          <div className="flex items-center gap-2">
            {selected && !creating && (
              <Button variant="outline" size="sm" onClick={() => duplicateMutation.mutate()} disabled={duplicateMutation.isPending} className={cn(OUTLINE_BUTTON, "h-8")}>
                <Copy className="mr-2 h-4 w-4 text-blue-600 dark:text-[#60a5fa]" />Duplicate
              </Button>
            )}
            {selected?.origin === "custom" && !creating && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Delete custom plan template “${selected.name}”?`)) deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
                className="h-8 border-rose-600/25 bg-white text-rose-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] hover:border-rose-500/45 hover:bg-rose-50 dark:border-[#f43f5e]/30 dark:bg-[#090c12] dark:text-[#fb7185] dark:hover:border-[#f43f5e]/50 dark:hover:bg-[#f43f5e]/10"
              >
                <Trash className="mr-2 h-4 w-4" />Delete
              </Button>
            )}
            {(creating || selected) && (
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending} className={cn(PRIMARY_BUTTON, "h-8")}>
                <Save className="mr-2 h-4 w-4" />Save
              </Button>
            )}
          </div>
        </div>

        {(creating || selected) ? (
          <div className="max-w-4xl space-y-4">
            <div className={cn(INSET, "flex w-fit items-center gap-2 px-3 py-2")}>
              <Checkbox
                id="plan-template-enabled"
                checked={draft.enabled}
                disabled={creating}
                onCheckedChange={(checked) => setDraft((value) => ({ ...value, enabled: checked === true }))}
                className="border-slate-300 data-[state=checked]:border-lime-600 data-[state=checked]:bg-lime-600 dark:border-white/[0.14] dark:data-[state=checked]:border-[#a3e635] dark:data-[state=checked]:bg-[#a3e635] dark:data-[state=checked]:text-[#0b0f05]"
              />
              <label htmlFor="plan-template-enabled" className="text-sm text-slate-800 dark:text-[#dbe4f0]">Available to planning agents</label>
            </div>
            <label className="block space-y-2">
              <span className={LABEL}>Name</span>
              <Input value={draft.name} disabled={readOnly} maxLength={120} className={CONTROL} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
            </label>
            <label className="block space-y-2">
              <span className={LABEL}>When agents should select it</span>
              <Textarea value={draft.selectionDescription} disabled={readOnly} maxLength={500} className={cn(CONTROL, "min-h-24")} onChange={(event) => setDraft((value) => ({ ...value, selectionDescription: event.target.value }))} />
            </label>
            <label className="block space-y-2">
              <span className={LABEL}>Template instructions</span>
              <Textarea value={draft.instructions} disabled={readOnly} maxLength={16000} spellCheck={false} className={cn(CONTROL, "min-h-72 font-mono text-xs leading-5")} onChange={(event) => setDraft((value) => ({ ...value, instructions: event.target.value }))} />
            </label>
            {readOnly && <p className={cn(INSET, "px-3 py-2 text-xs", MUTED)}>Default template text is maintained by the runtime. You can disable it or duplicate it into an editable custom template.</p>}
          </div>
        ) : <div className={cn(INSET, "p-8 text-sm", MUTED)}>Select a template or create a custom one.</div>}
      </main>
    </div>
  );
}
