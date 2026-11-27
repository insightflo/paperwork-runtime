import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import type { InstanceGeneralSettings, PatchInstanceGeneralSettings } from "@paperclipai/shared";
import type { PiCliActionResult } from "@paperclipai/shared/types/instance";
import { Input } from "@/components/ui/input";
import { instanceSettingsApi, type LlmStructuredConnectionTestResult } from "@/api/instanceSettings";
import { ProviderAuthSection } from "../components/ProviderAuthSection";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

export interface JudgmentConnectionDraft {
  judgmentBaseUrl: string;
  judgmentModelId: string;
}

export function toJudgmentDraft(
  settings?: { judgmentBaseUrl?: string; judgmentModelId?: string } | null,
): JudgmentConnectionDraft {
  return {
    judgmentBaseUrl: settings?.judgmentBaseUrl ?? "",
    judgmentModelId: settings?.judgmentModelId ?? "",
  };
}

export function toGeneralPatch(draft: JudgmentConnectionDraft): PatchInstanceGeneralSettings {
  const judgmentBaseUrl = draft.judgmentBaseUrl.trim();
  const judgmentModelId = draft.judgmentModelId.trim();
  return {
    judgmentBaseUrl: judgmentBaseUrl === "" ? null : judgmentBaseUrl,
    judgmentModelId: judgmentModelId === "" ? null : judgmentModelId,
  };
}

export interface LlmStructuredDraft {
  llmStructuredBaseUrl: string;
  llmStructuredModel: string;
  llmStructuredApiKey: string;
}

export function toLlmStructuredDraft(
  settings?: { llmStructuredBaseUrl?: string; llmStructuredModel?: string } | null,
): LlmStructuredDraft {
  return {
    llmStructuredBaseUrl: settings?.llmStructuredBaseUrl ?? "",
    llmStructuredModel: settings?.llmStructuredModel ?? "",
    llmStructuredApiKey: "",
  };
}

export function toLlmStructuredPatch(
  draft: LlmStructuredDraft,
  options?: { clearApiKey?: boolean },
): PatchInstanceGeneralSettings {
  const key = draft.llmStructuredApiKey.trim();
  return {
    llmStructuredBaseUrl: draft.llmStructuredBaseUrl.trim() || null,
    llmStructuredModel: draft.llmStructuredModel.trim() || null,
    ...(options?.clearApiKey ? { llmStructuredApiKey: null } : key ? { llmStructuredApiKey: key } : {}),
  };
}

const presets = {
  deepseek: ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
  zai: ["Z.AI", "https://api.z.ai/api/paas/v4", "glm-4.7"],
  openai: ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  custom: ["Custom", "", ""],
} as const;
type Preset = keyof typeof presets;
type ProviderRow = { id: string; name: string; baseUrl: string; model: string; apiKey: string; apiKeyConfigured: boolean; clearApiKey: boolean };

export function createNewProviderRow(preset: Preset = "custom", existingIds: string[] = []): ProviderRow {
  const [name, baseUrl, model] = presets[preset];
  let id: string = preset;
  for (let suffix = 2; existingIds.includes(id); suffix++) id = `${preset}-${suffix}`;
  return { id, name, baseUrl, model, apiKey: "", apiKeyConfigured: false, clearApiKey: false };
}

export function toLlmStructuredProvidersDraft(settings?: Partial<InstanceGeneralSettings> | null): ProviderRow[] {
  return (settings?.llmStructuredProviders ?? []).map(({ id, name, baseUrl, model, apiKeyConfigured }) => ({
    id, name, baseUrl, model: model ?? "", apiKeyConfigured, apiKey: "", clearApiKey: false,
  }));
}

export function toLlmStructuredProvidersPatch(rows: ProviderRow[], defaultProviderId?: string | null): PatchInstanceGeneralSettings {
  return {
    llmStructuredProviders: rows.map(({ id, name, baseUrl, model, apiKey, clearApiKey }) => ({
      id, name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim() || null,
      ...(clearApiKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    })),
    llmStructuredDefaultProviderId: defaultProviderId && rows.some(({ id }) => id === defaultProviderId) ? defaultProviderId : null,
  };
}

// Combo 1 tactile cockpit palette: light slate surfaces, obsidian #0e131d/#090c12 dark surfaces, cobalt/lime/amber signals.
const chip = "rounded-md border border-slate-200/90 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] transition-colors hover:border-blue-500/35 hover:bg-slate-50 disabled:opacity-60 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-[#60a5fa]/35 dark:hover:bg-[#141b29]";
const chipPrimary = "rounded-md border border-blue-600 bg-blue-600 px-2.5 py-1 text-xs font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] transition-colors hover:border-blue-500 hover:bg-blue-500 disabled:opacity-60 dark:border-[#60a5fa] dark:bg-[#60a5fa] dark:text-[#07111f] dark:hover:border-[#93c5fd] dark:hover:bg-[#93c5fd]";
const chipDanger = "rounded-md border border-slate-200/90 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] transition-colors hover:border-rose-500/35 hover:bg-rose-500/10 disabled:opacity-60 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#fb7185] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-rose-400/35 dark:hover:bg-rose-400/10";
const INPUT = "h-8 rounded-md border-slate-200/90 bg-white text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const PILL_OK = "rounded-full border border-lime-600/25 bg-lime-500/10 px-2 py-0.5 text-xs font-medium text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]";
const PILL_WARN = "rounded-full border border-amber-600/25 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]";
const PILL_NEUTRAL = "rounded-full border border-slate-200/90 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]";
const CELL = "cockpit-cell min-w-0 flex-1 justify-center";
const MONO_SNIPPET = "whitespace-pre-wrap break-all font-mono";
const providerFields = [["name", "공급자 이름 (Name)"], ["baseUrl", "Base URL"], ["model", "Model"], ["apiKey", "API Key"]] as const;
const cockpitSectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-[#8b97ad]";
const cockpitPanel = "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const cockpitInset = "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const cockpitSectionOverrides =
  "[&>section]:rounded-[12px] [&>section]:border [&>section]:border-slate-200/90 [&>section]:bg-white/95 [&>section]:p-4 dark:[&>section]:border-white/[0.08] dark:[&>section]:bg-[#0e131d] [&>section]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:[&>section]:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)] [&>section_h2]:text-[11px] [&>section_h2]:font-semibold [&>section_h2]:uppercase [&>section_h2]:tracking-wider [&>section_h2]:text-slate-600 dark:[&>section_h2]:text-[#8b97ad] [&>section>ul>li]:rounded-[10px] [&>section>ul>li]:border [&>section>ul>li]:border-slate-200/80 [&>section>ul>li]:bg-slate-50/85 dark:[&>section>ul>li]:border-white/[0.07] dark:[&>section>ul>li]:bg-[#090c12]";
const PI_CLI_STATUS_QUERY_KEY = ["instance", "pi-cli-status"] as const;

export function piCliVersionLabel(version: string | null | undefined): string {
  const cleaned = (version ?? "").trim().replace(/^pi[\s_-]*/i, "").replace(/^v/i, "").trim();
  return cleaned ? `v${cleaned}` : "v?";
}

export function piCatalogModelName(ref: string): string {
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

function ProviderCard({ row, saved, isDefault, update, selectDefault, remove }: {
  row: ProviderRow; saved: boolean; isDefault: boolean; update: (patch: Partial<ProviderRow>) => void;
  selectDefault: () => void; remove: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<LlmStructuredConnectionTestResult | null>(null);
  const [pending, setPending] = useState(false);
  async function testConnection() {
    setPending(true);
    setResult(null);
    setFilter("");
    try {
      const apiKey = row.apiKey.trim();
      setResult(await instanceSettingsApi.testLlmStructuredConnection({
        ...(saved ? { providerId: row.id } : {}), baseUrl: row.baseUrl.trim(), ...(apiKey ? { apiKey } : {}),
      }));
    } catch {
      setResult({ ok: false, latencyMs: 0, models: [] });
    } finally {
      setPending(false);
    }
  }
  const models = result?.models.filter((model) => model.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return <fieldset disabled={pending} className={cn("grid min-w-0 gap-3 p-4", cockpitInset)}>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={cn(isDefault ? chipPrimary : chip, "font-semibold")} aria-pressed={isDefault} onClick={selectDefault}>기본 공급자</button>
      <span className={row.apiKeyConfigured ? PILL_OK : PILL_NEUTRAL}>{row.apiKeyConfigured ? "키 등록됨" : "키 미등록"}</span>
      <button type="button" className={cn(chipDanger, "ml-auto")} onClick={remove}>삭제</button>
    </div>
    {providerFields.map(([field, label]) => <label key={field} className="grid gap-1 text-sm font-medium">
      {label}
      <Input type={field === "apiKey" ? "password" : "text"} value={row[field]} className={cn(INPUT, "font-mono")}
        autoComplete={field === "apiKey" ? "new-password" : "off"} disabled={field === "apiKey" && row.clearApiKey}
        placeholder={field === "apiKey" ? row.apiKeyConfigured ? "비워두면 기존 키 유지" : "sk-..." : undefined}
        onChange={(event) => {
          update({ [field]: event.target.value });
          if (field === "baseUrl" || field === "apiKey") setResult(null);
        }} />
    </label>)}
    {row.apiKeyConfigured && <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-[#8b97ad]">
      <input type="checkbox" checked={row.clearApiKey} onChange={(event) => {
        update({ clearApiKey: event.target.checked, apiKey: "" });
        setResult(null);
      }} /> Clear key
    </label>}
    <button type="button" className={cn(chip, "w-fit")} onClick={testConnection}
      disabled={!row.baseUrl.trim() || pending || row.clearApiKey}>연결 테스트 · 모델 조회</button>
    {pending && <p role="status" className="text-xs text-slate-500 dark:text-[#8b97ad]">연결 확인 중…</p>}
    {result && (result.ok ? <div className={cn("grid gap-2 p-3", cockpitInset)}>
      <p role="status" className={cn("text-xs text-lime-700 dark:text-[#a3e635]", MONO_SNIPPET)}>{`연결 성공 · ${result.latencyMs}ms · 모델 ${result.models.length}개`}</p>
      {result.models.length > 12 && <Input aria-label="모델 검색" placeholder="모델 검색" value={filter} className={INPUT}
        onChange={(event) => setFilter(event.target.value)} />}
      {models.length > 0 && <select aria-label="조회된 모델" className={cn(INPUT, "min-w-0 p-2")} value=""
        onChange={(event) => update({ model: event.target.value })}>
        <option value="" disabled>모델 선택</option>
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}
      </select>}
      {result.models.length > 0 && models.length === 0 && <p className="text-xs text-slate-500 dark:text-[#8b97ad]">검색 결과가 없습니다.</p>}
    </div> : <p role="alert" className="text-xs text-destructive">
      {result.statusCode ? `연결 실패 (HTTP ${result.statusCode}).` : "연결 실패. Base URL과 API Key를 확인해 주세요."}
    </p>)}
  </fieldset>;
}

const copyModelRef = (ref: string) => {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(ref).catch(() => undefined);
};

/** 진행 중인 CLI 관리 작업 추적용 — 버튼 라벨/상태 표시기를 런타임·작업별로 전환한다. */
type CliPendingKind = "sync" | "models" | "self" | "check" | "logout";
type CliPendingAction = { runtimeId?: string; kind: CliPendingKind } | null;

function PiCliManagerSection({ canApplyModel, onApplyModel }: {
  canApplyModel: boolean; onApplyModel: (modelRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const [modelFilter, setModelFilter] = useState("");
  const [pendingAction, setPendingAction] = useState<CliPendingAction>(null);
  const statusQuery = useQuery({
    queryKey: PI_CLI_STATUS_QUERY_KEY,
    queryFn: () => instanceSettingsApi.getPiCliStatus(),
  });
  const actionMutation = useMutation({
    mutationFn: (run: () => Promise<PiCliActionResult>) => run(),
    onSuccess: async (result) => {
      queryClient.setQueryData(PI_CLI_STATUS_QUERY_KEY, result.status);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }),
        queryClient.invalidateQueries({ queryKey: PI_CLI_STATUS_QUERY_KEY }),
      ]);
    },
    onSettled: () => setPendingAction(null),
  });
  const status = statusQuery.data;
  const runtimes = Array.isArray(status?.runtimes) ? status.runtimes : [];
  const installedCount = runtimes.filter((rt) => rt.installed).length;
  const providers = Array.isArray(status?.providers) ? status.providers : [];
  const catalogModels = Array.isArray(status?.catalogModels) ? status.catalogModels : [];
  const filteredModels = catalogModels.filter((ref) =>
    ref.toLowerCase().includes(modelFilter.trim().toLowerCase()));
  const busy = actionMutation.isPending;
  const runAction = (pending: Exclude<CliPendingAction, null>, run: () => Promise<PiCliActionResult>) => {
    setPendingAction(pending);
    actionMutation.mutate(run);
  };
  const actionPending = (kind: CliPendingKind, runtimeId?: string) =>
    pendingAction?.kind === kind && (runtimeId === undefined || pendingAction.runtimeId === runtimeId);
  const runUpdateCheck = (runtimeId: string) => {
    setPendingAction({ kind: "check", runtimeId });
    void statusQuery.refetch().finally(() => {
      setPendingAction((prev) => (prev?.kind === "check" && prev.runtimeId === runtimeId ? null : prev));
    });
  };

  return (
    <section className={cn(cockpitPanel, "p-4")}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={cockpitSectionHeader}>멀티 CLI · 모델 런타임 관리</h2>
        {runtimes.length > 0 && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium tabular-nums">
            {`${installedCount} / ${runtimes.length} CLI 설치됨`}
          </span>
        )}
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums", status?.installed ? PILL_OK : PILL_WARN)}>
          {status?.installed ? `Pi CLI ${piCliVersionLabel(status.version)}` : "Pi CLI not detected"}
        </span>
        <span className="text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums">{`총 ${catalogModels.length}개 모델`}</span>
      </div>
      <p className={cn("mt-1.5 text-xs text-slate-500 dark:text-[#8b97ad]", MONO_SNIPPET)}>{`${status?.executablePath ?? "pi"} · ${status?.agentDir ?? "~/.pi/agent"}`}</p>
      {status?.error && <p role="alert" className={cn("mt-2 text-xs text-amber-700 dark:text-[#f59e0b]", MONO_SNIPPET)}>{status.error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={chip} disabled={busy}
          onClick={() => runAction({ kind: "sync" }, () => instanceSettingsApi.syncPiCli({ direction: "both" }))}>
          {actionPending("sync") ? "동기화 중…" : "Pi CLI ↔ 웹 설정 동기화"}</button>
        <button type="button" className={chip} disabled={busy || !status?.installed}
          onClick={() => runAction({ kind: "models", runtimeId: "pi" }, () => instanceSettingsApi.updatePiCli({ runtimeId: "pi", target: "models" }))}>
          {actionPending("models", "pi") ? "모델 업데이트 중…" : "모델 카탈로그 새로고침 (pi update --models)"}</button>
        <button type="button" className={chip} disabled={busy || !status?.installed}
          onClick={() => runAction({ kind: "self", runtimeId: "pi" }, () => instanceSettingsApi.updatePiCli({ runtimeId: "pi", target: "self" }))}>
          {actionPending("self", "pi") ? "CLI 업데이트 중…" : "CLI 버전 업데이트 (pi update --self)"}</button>
        <button type="button" className={chip} disabled={statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}>상태 새로고침</button>
      </div>
      {actionMutation.data && (
        <p role="status" className={cn("mt-3 text-xs", MONO_SNIPPET, actionMutation.data.ok ? "text-lime-700 dark:text-[#a3e635]" : "text-destructive")}>
          {actionMutation.data.message}
        </p>
      )}
      {actionMutation.error && (
        <p role="alert" className={cn("mt-3 text-xs text-destructive", MONO_SNIPPET)}>
          {actionMutation.error instanceof Error ? actionMutation.error.message : "CLI 런타임 작업에 실패했습니다."}
        </p>
      )}

      {runtimes.length > 0 && (
        <>
          <h3 className={cn("mt-5", cockpitSectionHeader)}>Installed Coding Agent CLIs</h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {runtimes.map((rt) => {
              const modelsPending = actionPending("models", rt.id);
              const selfPending = actionPending("self", rt.id);
              const checkPending = actionPending("check", rt.id);
              const canSelfUpdate = rt.installed && rt.supportsSelfUpdate;
              return (
              <li key={rt.id} className={cn("grid gap-1.5 px-3 py-2.5", cockpitInset)}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-[#eef2f8]">{rt.name}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs tabular-nums", rt.installed ? PILL_OK : PILL_NEUTRAL)}>
                    {rt.installed ? piCliVersionLabel(rt.version) : "미설치"}
                  </span>
                  {rt.updateAvailable && <span className={PILL_WARN}>업데이트 가능</span>}
                  {canSelfUpdate && !rt.updateAvailable && rt.latestVersion && <span className={PILL_OK}>최신 버전</span>}
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", rt.authConfigured ? PILL_OK : PILL_WARN)}>{rt.authConfigured ? "인증됨" : "미인증"}</span>
                  <span className="ml-auto text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums">{`모델 ${rt.modelCount}개`}</span>
                </div>
                <p className={cn("text-xs text-slate-500 dark:text-[#8b97ad]", MONO_SNIPPET)}>
                  {rt.executablePath ?? rt.adapterType}{rt.authSource ? ` · ${rt.authSource}` : ""}
                </p>
                {rt.updateAvailable && rt.latestVersion && (
                  <p className={cn("text-xs text-amber-700 dark:text-[#f59e0b]", MONO_SNIPPET)}>{`${piCliVersionLabel(rt.version)} → v${rt.latestVersion}`}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")} disabled={busy}
                    onClick={() => runAction({ kind: "models", runtimeId: rt.id }, () => instanceSettingsApi.updatePiCli({ runtimeId: rt.id, target: "models" }))}>
                    {modelsPending ? "새로고침 중…" : "모델 새로고침"}</button>
                  {canSelfUpdate && rt.updateAvailable && (
                    <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")} disabled={busy}
                      onClick={() => runAction({ kind: "self", runtimeId: rt.id }, () => instanceSettingsApi.updatePiCli({ runtimeId: rt.id, target: "self" }))}>
                      {selfPending ? "업데이트 중…" : "CLI 업데이트"}</button>
                  )}
                  {canSelfUpdate && !rt.updateAvailable && (
                    <button type="button" className={cn(chip, "px-2 py-0.5 text-slate-500 dark:text-[#8b97ad]")} disabled={checkPending || statusQuery.isFetching}
                      onClick={() => runUpdateCheck(rt.id)}>
                      {checkPending ? "확인 중…" : "업데이트 확인"}</button>
                  )}
                </div>
                {modelsPending && <p role="status" className="text-xs text-slate-500 dark:text-[#8b97ad]">모델 목록 새로고침 중…</p>}
              </li>
              );
            })}
          </ul>
        </>
      )}

      <h3 className={cn("mt-5", cockpitSectionHeader)}>Pi CLI Providers</h3>
      {providers.length === 0 ? (
        <p className={cn("mt-2 text-xs text-slate-500 dark:text-[#8b97ad]", MONO_SNIPPET)}>~/.pi/agent/models.json 에 등록된 공급자가 없습니다.</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {providers.map((p) => (
            <li key={p.id} className={cn("flex flex-wrap items-center gap-2 px-3 py-2", cockpitInset)}>
              <span className="min-w-0 truncate font-mono text-sm font-semibold text-slate-900 dark:text-[#eef2f8]">{p.id}</span>
              <span className={p.authConfigured ? PILL_OK : PILL_WARN}>{p.authConfigured ? "로그인됨 (auth.json)" : "미인증"}</span>
              <span className="text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums">{`${p.api ?? "api 미지정"} · 모델 ${p.modelCount}개`}</span>
              {p.baseUrl && <span className={cn("text-xs text-slate-500 dark:text-[#8b97ad]", MONO_SNIPPET)}>{p.baseUrl}</span>}
              {p.authConfigured && (
                <button type="button" className={cn(chipDanger, "ml-auto py-1")} disabled={busy}
                  onClick={() => runAction({ kind: "logout", runtimeId: p.id }, () => instanceSettingsApi.logoutPiCliProvider({ providerId: p.id }))}>
                  로그아웃</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className={cn("mt-5", cockpitSectionHeader)}>Live Pi Model Catalog</h3>
      <Input aria-label="pi 모델 카탈로그 검색" placeholder="모델 검색..." value={modelFilter}
        onChange={(event) => setModelFilter(event.target.value)} className={cn(INPUT, "mt-2 max-w-sm")} />
      <div className={cn("mt-2 max-h-48 overflow-y-auto", cockpitInset)}>
        {filteredModels.length === 0 ? (
          <p className="px-3 py-2 text-xs text-slate-500 dark:text-[#8b97ad]">
            {catalogModels.length === 0 ? "카탈로그가 비어 있습니다." : "검색 결과가 없습니다."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-200/80 dark:divide-white/[0.07]">
            {filteredModels.map((ref) => (
              <li key={ref} className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-slate-100/80 dark:hover:bg-[#141b29]">
                <span className={cn("min-w-0 flex-1 text-xs text-slate-900 dark:text-[#eef2f8]", MONO_SNIPPET)}>{ref}</span>
                <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")}
                  onClick={() => copyModelRef(ref)}>복사</button>
                <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")} disabled={!canApplyModel}
                  onClick={() => onApplyModel(ref)}>적용</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
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

  const settings = generalQuery.data;
  const [providerEdits, setProviderEdits] = useState<{ rows: ProviderRow[]; defaultId?: string } | null>(null);
  const rows = providerEdits?.rows ?? toLlmStructuredProvidersDraft(settings);
  const defaultId = providerEdits ? providerEdits.defaultId : settings?.llmStructuredDefaultProviderId;
  const savedIds = settings?.llmStructuredProviders?.map(({ id }) => id) ?? [];
  const structuredMutation = useMutation({
    throwOnError: false,
    mutationFn: () => instanceSettingsApi.updateGeneral(toLlmStructuredProvidersPatch(rows, defaultId))
      .catch(() => { throw new Error("Could not save structured LLM providers. Check the provider settings and try again."); }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.instance.generalSettings, updated);
      setProviderEdits(null);
      void queryClient.invalidateQueries({ queryKey: PI_CLI_STATUS_QUERY_KEY });
    },
  });

  const applyPiCatalogModel = (modelRef: string) => {
    const targetId = defaultId ?? rows[0]?.id;
    if (!targetId) return;
    setProviderEdits({
      rows: rows.map((row) => (row.id === targetId ? { ...row, model: piCatalogModelName(modelRef) } : row)),
      defaultId: defaultId ?? targetId,
    });
  };

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }
  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  return (
    <div className={cn("max-w-4xl space-y-3 tabular-nums", cockpitSectionOverrides)}>
      {/* 1-row cockpit strip: censor state · judgment target · structured providers · default provider */}
      <div className={cn("cockpit-strip h-8 w-full gap-0 overflow-hidden", cockpitPanel)} role="group" aria-label="General settings summary">
        <div className={CELL}><span className="truncate uppercase tracking-wide">Censor logs</span><b className={cn("ml-1", censorUsernameInLogs && "text-lime-700 dark:text-[#a3e635]")}>{censorUsernameInLogs ? "On" : "Off"}</b></div>
        <div className={cn(CELL, "flex-[2]")} title={judgmentDraft.judgmentBaseUrl || undefined}>
          <span className="truncate uppercase tracking-wide">Judgment</span><b className="ml-1 truncate font-mono">{judgmentDraft.judgmentModelId || "Definition default"}</b>
        </div>
        <div className={CELL}><span className="truncate uppercase tracking-wide">Providers</span><b className="ml-1">{settings?.llmStructuredProviders?.length ?? 0}</b></div>
        <div className={cn(CELL, "shrink-0")} title={defaultId ?? undefined}><span className="truncate uppercase tracking-wide">Default</span><b className="ml-1 truncate font-mono">{defaultId ?? "—"}</b></div>
      </div>
      {/* Tight 40px toolbar: section title · scope note */}
      <div className={cn("cockpit-toolbar h-10 rounded-[12px] px-3", cockpitPanel)}>
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" aria-hidden />
        <h1 className={cockpitSectionHeader}>General</h1>
        <p className="min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad]">Configure instance-wide defaults that affect how operator-visible logs are displayed.</p>
      </div>

      {actionError && (
        <div role="alert" className="rounded-[10px] border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">{actionError}</div>
      )}

      <section className={cn(cockpitPanel, "p-4")}>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className={cockpitSectionHeader}>Censor username in logs</h2>
            <p className="max-w-2xl text-xs leading-5 text-slate-500 dark:text-[#8b97ad]">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <button
            type="button"
            aria-label="Toggle username log censoring"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              censorUsernameInLogs ? "bg-blue-600 dark:bg-[#60a5fa]" : "bg-slate-300 dark:bg-[#151d2b]",
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

      <section className={cn(cockpitPanel, "p-4")}>
        <h2 className={cockpitSectionHeader}>Judgment connection</h2>
        <p className="mt-1.5 max-w-2xl text-xs leading-5 text-slate-500 dark:text-[#8b97ad]">
          TypeSafe 호환 판단 API 주소(비우면 기본값)를 지정합니다. 모델 미설정 시 정의별 모델 사용.
          서버 환경의 기존 판단 API 키가 이 주소로 전송됨.
        </p>
        <div className="mt-4 grid max-w-xl gap-4">
          <div className="space-y-1.5">
            <label htmlFor="judgment-base-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="judgment-base-url"
              value={judgmentDraft.judgmentBaseUrl}
              onChange={(event) =>
                setJudgmentDraft((draft) => ({ ...draft, judgmentBaseUrl: event.target.value }))
              }
              placeholder="https://api.typesafe.ai"
              autoComplete="off"
              className={cn(INPUT, "font-mono")}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="judgment-model-id" className="text-sm font-medium">
              Model id
            </label>
            <Input
              id="judgment-model-id"
              value={judgmentDraft.judgmentModelId}
              onChange={(event) =>
                setJudgmentDraft((draft) => ({ ...draft, judgmentModelId: event.target.value }))
              }
              placeholder="jev-1.13.0"
              autoComplete="off"
              className={cn(INPUT, "font-mono")}
            />
          </div>
          <button
            type="button"
            disabled={judgmentMutation.isPending}
            className={cn(chipPrimary, "inline-flex h-7 w-fit items-center justify-center px-2.5 font-semibold disabled:cursor-not-allowed")}
            onClick={() => judgmentMutation.mutate(judgmentDraft)}
          >
            Save judgment connection
          </button>
        </div>
      </section>

      <section className={cn(cockpitPanel, "p-4")}>
        <h2 className={cockpitSectionHeader}>Structured LLM connection (1-shot API)</h2>
        {!savedIds.length && (settings?.llmStructuredBaseUrl || settings?.llmStructuredApiKeyConfigured) &&
          <p className={cn("mt-2 text-xs text-slate-500 dark:text-[#8b97ad]", MONO_SNIPPET)}>
            기존 연결: {settings.llmStructuredBaseUrl || "주소 미설정"} · {settings.llmStructuredModel || "모델 미설정"}
            {settings.llmStructuredApiKeyConfigured ? " · 키 등록됨" : " · 키 미등록"}. 새 공급자의 키는 별도로 입력해 주세요.
          </p>}
        <fieldset disabled={structuredMutation.isPending} className="mt-4 grid min-w-0 max-w-xl gap-4">
          <div className="flex flex-wrap gap-2">
            {(["custom", "deepseek", "zai", "openai"] as const).map((preset) =>
              <button key={preset} type="button" className={chip} onClick={() => setProviderEdits({
                rows: [...rows, createNewProviderRow(preset, [...savedIds, ...rows.map(({ id }) => id)])], defaultId,
              })}>{preset === "custom" ? "+ 공급자 추가" : presets[preset][0]}</button>)}
          </div>
          {rows.map((row) => <ProviderCard key={row.id} row={row} saved={savedIds.includes(row.id)}
            isDefault={row.id === defaultId} selectDefault={() => setProviderEdits({ rows, defaultId: row.id })}
            update={(patch) => setProviderEdits({ rows: rows.map((item) => item.id === row.id ? { ...item, ...patch } : item), defaultId })}
            remove={() => setProviderEdits({ rows: rows.filter(({ id }) => id !== row.id), defaultId: defaultId === row.id ? undefined : defaultId })} />)}
          <button type="button" disabled={!providerEdits || rows.some(({ name, baseUrl }) => !name.trim() || !baseUrl.trim())}
            className={cn(chipPrimary, "w-fit font-semibold")}
            onClick={() => structuredMutation.mutate()}>Save structured LLM providers</button>
          {structuredMutation.error && <p role="alert" className="text-xs text-destructive">{structuredMutation.error.message}</p>}
          {structuredMutation.isSuccess && !providerEdits && <p role="status" className="text-xs text-lime-700 dark:text-[#a3e635]">공급자 설정을 저장했습니다.</p>}
        </fieldset>
      </section>

      <PiCliManagerSection canApplyModel={rows.length > 0} onApplyModel={applyPiCatalogModel} />
      <ProviderAuthSection />
    </div>
  );
}
