import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Copy, Lock, RotateCcw, Settings } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { CompanyWorkProductStorageSettings } from "../components/CompanyWorkProductStorageSettings";
import { CompanyDataStorageSettings } from "../components/CompanyDataStorageSettings";
import {
  Field,
  ToggleField
} from "../components/agent-config-primitives";
import { AccessSettingsSection } from "../components/access-settings/AccessSettingsSection";

// Cockpit primitives (approved Linear + Datadog palette; mirrors .cockpit-strip/.cockpit-toolbar).
const CARD = "rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]";
const FIELD = "rounded-md border border-slate-200/90 bg-slate-50/80 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#edf2fb] dark:focus:border-[var(--pw-cobalt)] dark:focus:ring-[var(--pw-cobalt)]/25";
const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]";
const CTA = "bg-blue-600 text-[#f8fafc] hover:bg-blue-500 dark:bg-blue-600 dark:hover:bg-[#3b82f6]";
const LANGUAGE_LABEL: Record<CompanyDefaultLanguage, string> = { en: "English", ko: "한국어" };

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId,
    canAdmin,
    currentRole,
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [timezone, setTimezone] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [workProductRoot, setWorkProductRoot] = useState("");
  const [defaultLanguage, setDefaultLanguage] = useState<CompanyDefaultLanguage>("en");

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setTimezone(selectedCompany.timezone ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
    setWorkProductRoot((selectedCompany as { workProductRoot?: string | null }).workProductRoot ?? "");
    setDefaultLanguage(selectedCompany.defaultLanguage);
  }, [selectedCompany]);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      timezone !== (selectedCompany.timezone ?? "") ||
      workProductRoot !== (selectedCompany.workProductRoot ?? "") ||
      defaultLanguage !== selectedCompany.defaultLanguage);

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      timezone: string | null;
      workProductRoot: string | null;
      defaultLanguage: CompanyDefaultLanguage;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({ title: "Company settings saved", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to save company settings",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({ title: "Hiring approval policy updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update hiring policy",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    if (!canAdmin) return;
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      timezone: timezone.trim() || null,
      workProductRoot: workProductRoot.trim() || null,
      defaultLanguage
    });
  }

  function handleDiscardGeneral() {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setTimezone(selectedCompany.timezone ?? "");
    setWorkProductRoot((selectedCompany as { workProductRoot?: string | null }).workProductRoot ?? "");
    setDefaultLanguage(selectedCompany.defaultLanguage);
    generalMutation.reset();
  }

  async function copyChipValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ title: `${label} copied`, body: value, tone: "success" });
    } catch {
      pushToast({ title: `Failed to copy ${label}`, tone: "error" });
    }
  }

  const archived = selectedCompany.status === "archived";
  const strip = [
    { label: "Company", value: selectedCompany.name, dot: brandColor || "var(--pw-cobalt)" },
    { label: "Timezone", value: selectedCompany.timezone ?? "System default", dot: "var(--pw-cobalt)" },
    { label: "Language", value: LANGUAGE_LABEL[selectedCompany.defaultLanguage], dot: "var(--pw-cobalt)" },
    { label: "Hire approvals", value: selectedCompany.requireBoardApprovalForNewAgents ? "Required" : "Optional", dot: selectedCompany.requireBoardApprovalForNewAgents ? "var(--pw-amber)" : "var(--pw-muted)" },
    { label: "Status", value: archived ? "Archived" : "Active", dot: archived ? "var(--pw-muted)" : "var(--pw-lime)" },
  ];

  return (
    <div className="grid max-w-none gap-3 tabular-nums xl:grid-cols-2">
      {/* 1-row 5-column cockpit strip: live company summary (reflects saved state) */}
      <div className="grid w-full grid-cols-2 divide-x divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:divide-white/[0.06] dark:border-white/[0.08] dark:bg-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)] sm:grid-cols-3 xl:col-span-2 xl:grid-cols-5" role="group" aria-label="Company summary">
        {strip.map((cell) => (
          <div key={cell.label} className="flex h-10 min-w-0 items-center justify-center gap-2 px-3 text-[11px] text-slate-600 dark:text-[#8b97ad]">
            <span aria-hidden style={{ backgroundColor: cell.dot }} className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.label === "Status" && !archived ? "animate-pulse" : ""}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1 min-w-0 truncate font-semibold text-slate-950 dark:text-[#edf2fb]">{cell.value}</b>
          </div>
        ))}
      </div>

      {/* 40px unified toolbar; the deep-cobalt save CTA appears only while dirty */}
      <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-xl border border-slate-200/90 bg-slate-50/95 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.08] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] xl:col-span-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">
            <Settings className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" aria-hidden />
            Company Settings
          </h1>
          <button
            type="button"
            onClick={() => void copyChipValue("Company prefix", selectedCompany.issuePrefix)}
            title={`Click to copy prefix (${selectedCompany.issuePrefix})`}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[11px] font-medium text-slate-700 transition-colors hover:border-blue-500/40 hover:text-blue-700 dark:border-white/[0.09] dark:bg-card dark:text-[#cbd5e1] dark:hover:border-[var(--pw-cobalt)]/40 dark:hover:text-[var(--pw-cobalt)]"
          >
            <span>{selectedCompany.issuePrefix}</span>
            <Copy className="h-3 w-3 opacity-70" />
          </button>
          <button
            type="button"
            onClick={() => void copyChipValue("Company ID", selectedCompany.id)}
            title={`Click to copy Company ID (${selectedCompany.id})`}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[11px] text-slate-600 transition-colors hover:border-blue-500/40 hover:text-blue-700 dark:border-white/[0.09] dark:bg-card dark:text-[#9aa7bd] dark:hover:border-[var(--pw-cobalt)]/40 dark:hover:text-[var(--pw-cobalt)]"
          >
            <span>ID: {selectedCompany.id.slice(0, 8)}…</span>
            <Copy className="h-3 w-3 opacity-70" />
          </button>
          <span className={`truncate text-xs ${generalDirty ? "text-amber-600 dark:text-[#f59e0b]" : "text-slate-500 dark:text-[#8b97ad]"}`}>
            {generalDirty ? "Unsaved changes in General / Appearance" : "All changes saved"}
          </span>
        </div>
        {!canAdmin && (
          <div className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#fde68a]">
            <Lock className="h-3 w-3 shrink-0" />
            <span>Read-only ({currentRole}) · Admin or owner role required to modify settings</span>
          </div>
        )}
        {canAdmin && generalDirty && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {generalMutation.isError && (
              <span className="text-xs text-destructive">
                {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={handleDiscardGeneral}
              disabled={generalMutation.isPending}
            >
              <RotateCcw className="h-3 w-3" />
              Discard
            </Button>
            <Button
              size="sm"
              className={`h-7 text-xs ${CTA}`}
              onClick={handleSaveGeneral}
              disabled={generalMutation.isPending || !companyName.trim()}
            >
              {generalMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        )}
      </div>

      {/* General */}
      <div className="space-y-2">
        <div className={LABEL}>General</div>
        <div className={`space-y-3 px-4 py-4 ${CARD}`}>
          <Field label="Company name" hint="The display name for your company.">
            <input
              className={`w-full px-2.5 py-1.5 text-sm ${FIELD}`}
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the company profile."
          >
            <input
              className={`w-full px-2.5 py-1.5 text-sm ${FIELD}`}
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field
            label="Timezone"
            hint="IANA timezone for this company (e.g. Asia/Seoul, America/New_York). Used by workflows unless overridden. Leave empty for system default."
          >
            <input
              className={`w-full px-2.5 py-1.5 text-sm ${FIELD}`}
              type="text"
              value={timezone}
              placeholder="e.g. Asia/Seoul"
              onChange={(e) => setTimezone(e.target.value)}
            />
          </Field>
          <Field
            label="Default user-facing language"
            hint="Agent-written descriptions, comments, and operator summaries use this language. Tools, code, IDs, JSON, and other internal execution data stay in English."
          >
            <select
              className={`w-full px-2.5 py-1.5 text-sm ${FIELD}`}
              value={defaultLanguage}
              onChange={(event) => setDefaultLanguage(event.target.value as CompanyDefaultLanguage)}
            >
              <option value="en">English</option>
              <option value="ko">한국어</option>
            </select>
          </Field>
          <Field
            label="Paperwork local work folder"
            hint="Private folder on the Paperwork server where agents and workflows create and validate files first. It is not shared with n8n. Leave empty to use the project default."
          >
            <input
              className={`w-full px-2.5 py-1.5 text-sm ${FIELD}`}
              type="text"
              value={workProductRoot}
              placeholder="e.g. /srv/papercompany/projects/research-company/produced_work"
              onChange={(e) => setWorkProductRoot(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-2">
        <div className={LABEL}>Appearance</div>
        <div className={`space-y-3 px-4 py-4 ${CARD}`}>
          <div className="flex min-w-0 items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <Field
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    disabled={!canAdmin}
                    onChange={handleLogoFileChange}
                    className={`w-full px-2.5 py-1.5 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-blue-600 dark:file:bg-blue-600 file:px-2.5 file:py-1 file:text-xs file:text-white dark:file:text-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60 ${FIELD}`}
                  />
                  {logoUrl && canAdmin && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-card text-xs text-slate-900 dark:text-[#edf2fb] hover:bg-slate-100 dark:hover:bg-[#141b29] hover:text-slate-950 dark:hover:text-[#edf2fb]"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {logoUploadMutation.isError && (
                    <span className="text-xs text-destructive">
                      {logoUploadMutation.error instanceof Error
                        ? logoUploadMutation.error.message
                        : "Logo upload failed"}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-slate-500 dark:text-[#8b97ad]">Uploading logo...</span>
                  )}
                </div>
              </Field>
              <Field
                label="Brand color"
                hint="Sets the hue for the company icon. Leave empty for auto-generated color."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-card p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className={`w-28 px-2.5 py-1.5 font-mono text-sm ${FIELD}`}
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      <CompanyWorkProductStorageSettings companyId={selectedCompany.id} />
      <CompanyDataStorageSettings companyId={selectedCompany.id} />

      {/* Hiring */}
      <div className="space-y-2">
        <div className={LABEL}>Hiring</div>
        <div className={`px-4 py-3 ${CARD} ${!canAdmin ? "pointer-events-none opacity-60" : ""}`}>
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => {
              if (!canAdmin) return;
              settingsMutation.mutate(v);
            }}
          />
        </div>
      </div>

      <AccessSettingsSection selectedCompanyId={selectedCompanyId} />

      {/* Danger Zone */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
          Danger Zone
        </div>
        <div className={`space-y-3 px-4 py-4 ${CARD}`}>
          <p className="text-sm text-slate-500 dark:text-[#8b97ad]">
            Archive this company to hide it from the sidebar. This persists in
            the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                !canAdmin ||
                archiveMutation.isPending ||
                archived
              }
              title={!canAdmin ? "Admin or owner role required" : undefined}
              onClick={() => {
                if (!canAdmin || !selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? "Archiving..."
                : archived
                ? "Already archived"
                : "Archive company"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
