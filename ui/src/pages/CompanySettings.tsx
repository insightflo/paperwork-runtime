import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanyDefaultLanguage } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { buildAgentSnippet } from "../lib/openclaw-invite-snippet";
import { Button } from "@/components/ui/button";
import { Settings, Check } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { CompanyWorkProductStorageSettings } from "../components/CompanyWorkProductStorageSettings";
import { CompanyDataStorageSettings } from "../components/CompanyDataStorageSettings";
import {
  Field,
  ToggleField,
  HintIcon
} from "../components/agent-config-primitives";
import { AccessSettingsSection } from "../components/access-settings/AccessSettingsSection";

// Cockpit primitives (approved Linear + Datadog palette; mirrors .cockpit-strip/.cockpit-toolbar).
const CARD = "rounded-md border border-[#242d3f] bg-[#151b28]";
const FIELD = "rounded-md border border-[#242d3f] bg-[#111622] text-[#e6edf7] outline-none focus:border-[#5f8dff] focus:ring-[#5f8dff]/40";
const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad]";
const CTA = "bg-[#2563eb] text-[#f8fafc] hover:bg-[#5f8dff]";
const LANGUAGE_LABEL: Record<CompanyDefaultLanguage, string> = { en: "English", ko: "한국어" };

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
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

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

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
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!)
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : "Failed to create invite"
      );
    }
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

  useEffect(() => {
    void selectedCompanyId;
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);

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
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      timezone: timezone.trim() || null,
      workProductRoot: workProductRoot.trim() || null,
      defaultLanguage
    });
  }

  const archived = selectedCompany.status === "archived";
  const strip = [
    { label: "Company", value: selectedCompany.name, dot: brandColor || "bg-[#5f8dff]" },
    { label: "Timezone", value: selectedCompany.timezone ?? "System default", dot: "bg-[#5f8dff]" },
    { label: "Language", value: LANGUAGE_LABEL[selectedCompany.defaultLanguage], dot: "bg-[#5f8dff]" },
    { label: "Hire approvals", value: selectedCompany.requireBoardApprovalForNewAgents ? "Required" : "Optional", dot: selectedCompany.requireBoardApprovalForNewAgents ? "bg-[#fbbf24]" : "bg-[#8b97ad]" },
    { label: "Status", value: archived ? "Archived" : "Active", dot: archived ? "bg-[#8b97ad]" : "bg-[#34d399]" },
  ];

  return (
    <div className="max-w-3xl space-y-2 tabular-nums">
      {/* 1-row 5-column cockpit strip: live company summary (reflects saved state) */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Company summary">
        {strip.map((cell) => (
          <div key={cell.label} className="cockpit-cell min-w-0 flex-1 justify-center">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1 truncate">{cell.value}</b>
          </div>
        ))}
      </div>

      {/* 40px unified toolbar; the deep-cobalt save CTA appears only while dirty */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold text-[#e6edf7]">
            <Settings className="h-4 w-4 shrink-0 text-[#8b97ad]" aria-hidden />
            Company Settings
          </h1>
          <span className={`truncate text-xs ${generalDirty ? "text-[#fbbf24]" : "text-[#8b97ad]"}`}>
            {generalDirty ? "Unsaved changes in General / Appearance" : "All changes saved"}
          </span>
        </div>
        {generalDirty && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {generalMutation.isSuccess && (
              <span className="text-xs text-[#34d399]">Saved</span>
            )}
            {generalMutation.isError && (
              <span className="text-xs text-destructive">
                {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
              </span>
            )}
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
                    onChange={handleLogoFileChange}
                    className={`w-full px-2.5 py-1.5 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-[#111622] file:px-2.5 file:py-1 file:text-xs file:text-[#e6edf7] ${FIELD}`}
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-[#242d3f] bg-[#111622] text-xs text-[#e6edf7] hover:bg-[#1a2131] hover:text-[#e6edf7]"
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
                    <span className="text-xs text-[#8b97ad]">Uploading logo...</span>
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
                    className="h-8 w-8 cursor-pointer rounded border border-[#242d3f] bg-[#111622] p-0"
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
                      className="text-xs text-[#8b97ad] hover:text-[#e6edf7]"
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
        <div className={`px-4 py-3 ${CARD}`}>
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
          />
        </div>
      </div>

      <AccessSettingsSection selectedCompanyId={selectedCompanyId} />

      {/* Invites */}
      <div className="space-y-2">
        <div className={LABEL}>Invites</div>
        <div className={`space-y-3 px-4 py-4 ${CARD}`}>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[#8b97ad]">
              Generate an OpenClaw agent invite snippet.
            </span>
            <HintIcon text="Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className={`h-7 text-xs ${CTA}`}
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? "Generating..."
                : "Generate OpenClaw Invite Prompt"}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div className="rounded-md border border-[#242d3f] bg-[#111622] p-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 truncate text-xs text-[#8b97ad]">
                  OpenClaw Invite Prompt
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex shrink-0 items-center gap-1 text-xs text-[#34d399] animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    Copied
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  className={`h-[28rem] w-full px-2 py-1.5 font-mono text-xs ${FIELD}`}
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs text-[#8b97ad] hover:text-[#e6edf7]"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied ? "Copied snippet" : "Copy snippet"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
          Danger Zone
        </div>
        <div className={`space-y-3 px-4 py-4 ${CARD}`}>
          <p className="text-sm text-[#8b97ad]">
            Archive this company to hide it from the sidebar. This persists in
            the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                archived
              }
              onClick={() => {
                if (!selectedCompanyId) return;
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
