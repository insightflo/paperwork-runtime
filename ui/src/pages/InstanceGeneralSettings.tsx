import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import type { InstanceGeneralSettings } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { CliRuntimesTab } from "./instance-general/CliRuntimesTab";
import { ProvidersTab } from "./instance-general/ProvidersTab";
import {
  chip, chipPrimary, cockpitPanel, cockpitSectionHeader, INPUT, PILL_OK, PILL_WARN,
  toGeneralPatch, toJudgmentDraft, useLlmStructuredProviders,
  type JudgmentConnectionDraft,
} from "./instance-general/shared";

// 헬퍼 시그니처는 기존 소비자(test 등)를 위해 페이지 모듈에서 그대로 재노출한다.
export {
  createNewProviderRow,
  piCatalogModelName,
  piCliVersionLabel,
  toGeneralPatch,
  toJudgmentDraft,
  toLlmStructuredDraft,
  toLlmStructuredPatch,
  toLlmStructuredProvidersDraft,
  toLlmStructuredProvidersPatch,
} from "./instance-general/shared";
export type {
  JudgmentConnectionDraft,
  LlmStructuredDraft,
  Preset,
  ProviderRow,
} from "./instance-general/shared";

const TABS = [
  { id: "general", label: "General", hint: "기본 설정" },
  { id: "providers", label: "Providers", hint: "공급자 · 인증" },
  { id: "judgment", label: "Judgment", hint: "판단 연결" },
  { id: "runtimes", label: "CLI Runtimes", hint: "CLI 런타임 · 모델 카탈로그" },
] as const;
export type GeneralSettingsTabId = (typeof TABS)[number]["id"];
const TAB_IDS: readonly string[] = TABS.map(({ id }) => id);

/** `?tab=` 쿼리 값을 알려진 탭 id로 해석한다. 없거나 모르는 값은 기본 탭(general). */
export function resolveGeneralSettingsTab(raw: string | null | undefined): GeneralSettingsTabId {
  return TAB_IDS.includes(raw ?? "") ? (raw as GeneralSettingsTabId) : "general";
}

/** s25-judgment-key 브랜치가 shared 스키마에 병렬로 추가하는 응답 필드(선언 정합용 로컬 교집합). */
type JudgmentKeyAwareSettings = InstanceGeneralSettings & { judgmentApiKeyConfigured?: boolean };

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveGeneralSettingsTab(searchParams.get("tab"));
  const [actionError, setActionError] = useState<string | null>(null);
  const [judgmentDraft, setJudgmentDraft] = useState<JudgmentConnectionDraft>(toJudgmentDraft());

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "General" }]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  useEffect(() => {
    if (generalQuery.data) setJudgmentDraft(toJudgmentDraft(generalQuery.data));
  }, [generalQuery.data]);

  const settings = generalQuery.data;
  const providers = useLlmStructuredProviders(settings);
  const judgmentKeyConfigured = (settings as JudgmentKeyAwareSettings | undefined)?.judgmentApiKeyConfigured === true;

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      instanceSettingsApi.updateGeneral({ censorUsernameInLogs: enabled }),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  const judgmentMutation = useMutation({
    mutationFn: async (draft: JudgmentConnectionDraft) =>
      instanceSettingsApi.updateGeneral(toGeneralPatch(draft)),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : "Failed to update judgment connection settings.",
      );
    },
  });

  const selectTab = (tab: GeneralSettingsTabId) =>
    setSearchParams(tab === "general" ? {} : { tab }, { replace: true });

  if (generalQuery.isLoading) {
    return <div aria-live="polite" className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div role="alert" className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = settings?.censorUsernameInLogs === true;
  return (
    <div className="mx-auto max-w-4xl space-y-3 tabular-nums">
      <div className={cn(cockpitPanel, "px-3 py-2.5")}>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className={cockpitSectionHeader}>General</h1>
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            Configure instance-wide defaults that affect how operator-visible logs are displayed.
          </p>
        </div>
        <div role="tablist" aria-label="General settings sections" className="mt-2 flex flex-wrap gap-1.5">
          {TABS.map(({ id, label, hint }) => (
            <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={activeTab === id}
              aria-controls={`panel-${id}`} className={cn(activeTab === id ? chipPrimary : chip, "font-semibold")}
              onClick={() => selectTab(id)}>
              {label}<span className="ml-1.5 font-normal opacity-70">{hint}</span>
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div role="alert" className="rounded-[10px] border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{actionError}</div>
      )}

      {activeTab === "general" && (
        <div role="tabpanel" id="panel-general" aria-labelledby="tab-general" tabIndex={0} className="space-y-3">
          <div className={cn("cockpit-strip h-8 w-full gap-0 overflow-hidden", cockpitPanel)} role="group" aria-label="General settings summary">
            <div className="cockpit-cell min-w-0 flex-1 justify-center"><span className="truncate uppercase tracking-wide">Censor logs</span><b className={cn("ml-1", censorUsernameInLogs && "text-[var(--pw-lime)]")}>{censorUsernameInLogs ? "On" : "Off"}</b></div>
            <div className="cockpit-cell min-w-0 flex-[2] justify-center" title={judgmentDraft.judgmentBaseUrl || undefined}>
              <span className="truncate uppercase tracking-wide">Judgment</span><b className="ml-1 truncate font-mono">{judgmentDraft.judgmentModelId || "Definition default"}</b>
            </div>
            <div className="cockpit-cell min-w-0 flex-1 justify-center"><span className="truncate uppercase tracking-wide">Providers</span><b className="ml-1">{settings?.llmStructuredProviders?.length ?? 0}</b></div>
            <div className="cockpit-cell min-w-0 flex-1 shrink-0 justify-center" title={providers.defaultId ?? undefined}>
              <span className="truncate uppercase tracking-wide">Default</span><b className="ml-1 truncate font-mono">{providers.defaultId ?? "—"}</b>
            </div>
          </div>
          <section className={cn(cockpitPanel, "p-4")}>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <h2 className={cockpitSectionHeader}>Censor username in logs</h2>
                <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
                  Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
                  username mentions outside of paths are not yet masked in the live transcript view. This is off by
                  default.
                </p>
              </div>
              <button
                type="button"
                aria-label="Toggle username log censoring" aria-pressed={censorUsernameInLogs}
                disabled={toggleMutation.isPending}
                className={cn(
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  censorUsernameInLogs ? "bg-primary" : "bg-muted-foreground/40",
                )}
                onClick={() => toggleMutation.mutate(!censorUsernameInLogs)}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                    censorUsernameInLogs ? "translate-x-4.5" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
          </section>
        </div>
      )}

      {activeTab === "providers" && <ProvidersTab controller={providers} />}

      {activeTab === "judgment" && (
        <div role="tabpanel" id="panel-judgment" aria-labelledby="tab-judgment" tabIndex={0}>
          <section className={cn(cockpitPanel, "p-4")}>
            <h2 className={cockpitSectionHeader}>Judgment connection</h2>
            <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">
              TypeSafe 호환 판단 API 주소(비우면 기본값)를 지정합니다. 모델 미설정 시 정의별 모델 사용.
              API Key는 비워두면 기존 등록 키(없으면 서버 환경 키)를 유지하며, 서버 환경의 기존 판단 API 키가 이 주소로 전송됨.
            </p>
            <div className="mt-4 grid max-w-xl gap-4">
              <div className="space-y-1.5">
                <label htmlFor="judgment-base-url" className="text-sm font-medium">Base URL</label>
                <Input id="judgment-base-url" value={judgmentDraft.judgmentBaseUrl} placeholder="https://api.typesafe.ai"
                  autoComplete="off" className={cn(INPUT, "font-mono")}
                  onChange={(event) => setJudgmentDraft((draft) => ({ ...draft, judgmentBaseUrl: event.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="judgment-model-id" className="text-sm font-medium">Model id</label>
                <Input id="judgment-model-id" value={judgmentDraft.judgmentModelId} placeholder="jev-1.13.0"
                  autoComplete="off" className={cn(INPUT, "font-mono")}
                  onChange={(event) => setJudgmentDraft((draft) => ({ ...draft, judgmentModelId: event.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="judgment-api-key" className="text-sm font-medium">API Key</label>
                  <span aria-live="polite" className={judgmentKeyConfigured ? PILL_OK : PILL_WARN}>{judgmentKeyConfigured ? "키 등록됨" : "서버 환경 키"}</span>
                </div>
                <Input id="judgment-api-key" type="password" value={judgmentDraft.judgmentApiKey} autoComplete="new-password"
                  disabled={judgmentDraft.clearJudgmentApiKey} className={cn(INPUT, "font-mono")}
                  placeholder={judgmentKeyConfigured ? "비워두면 기존 키 유지" : "서버 환경 키 사용"}
                  onChange={(event) => setJudgmentDraft((draft) => ({ ...draft, judgmentApiKey: event.target.value }))} />
                {judgmentKeyConfigured && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input aria-label="Clear key" type="checkbox" checked={judgmentDraft.clearJudgmentApiKey}
                      onChange={(event) => setJudgmentDraft((draft) => ({
                        ...draft, clearJudgmentApiKey: event.target.checked, judgmentApiKey: "",
                      }))} /> Clear key
                  </label>
                )}
              </div>
              <button type="button" disabled={judgmentMutation.isPending}
                className={cn(chipPrimary, "inline-flex h-7 w-fit items-center justify-center px-2.5 font-semibold disabled:cursor-not-allowed")}
                onClick={() => judgmentMutation.mutate(judgmentDraft)}>
                Save judgment connection
              </button>
            </div>
          </section>
        </div>
      )}

      {activeTab === "runtimes" && (
        <CliRuntimesTab canApplyModel={providers.canApplyModel} onApplyModel={providers.applyCatalogModel} />
      )}
    </div>
  );
}
