import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import type { InstanceGeneralSettings, PatchInstanceGeneralSettings } from "@paperclipai/shared";
import type { PiCliActionResult } from "@paperclipai/shared/types/instance";
import { Input } from "@/components/ui/input";
import { instanceSettingsApi, type LlmStructuredConnectionTestResult } from "@/api/instanceSettings";
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

const chip = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60";
const providerFields = [["name", "공급자 이름 (Name)"], ["baseUrl", "Base URL"], ["model", "Model"], ["apiKey", "API Key"]] as const;
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
  return <fieldset disabled={pending} className="grid min-w-0 gap-3 rounded-lg border border-border p-4">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={cn(chip, isDefault && "bg-primary text-primary-foreground hover:bg-primary/90")}
        aria-pressed={isDefault} onClick={selectDefault}>기본 공급자</button>
      <span className="rounded-full bg-muted px-2 py-1 text-xs">{row.apiKeyConfigured ? "키 등록됨" : "키 미등록"}</span>
      <button type="button" className={cn(chip, "ml-auto text-destructive")} onClick={remove}>삭제</button>
    </div>
    {providerFields.map(([field, label]) => <label key={field} className="grid gap-1 text-sm font-medium">
      {label}
      <Input type={field === "apiKey" ? "password" : "text"} value={row[field]}
        autoComplete={field === "apiKey" ? "new-password" : "off"} disabled={field === "apiKey" && row.clearApiKey}
        placeholder={field === "apiKey" ? row.apiKeyConfigured ? "비워두면 기존 키 유지" : "sk-..." : undefined}
        onChange={(event) => {
          update({ [field]: event.target.value });
          if (field === "baseUrl" || field === "apiKey") setResult(null);
        }} />
    </label>)}
    {row.apiKeyConfigured && <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={row.clearApiKey} onChange={(event) => {
        update({ clearApiKey: event.target.checked, apiKey: "" });
        setResult(null);
      }} /> Clear key
    </label>}
    <button type="button" className={cn(chip, "w-fit")} onClick={testConnection}
      disabled={!row.baseUrl.trim() || pending || row.clearApiKey}>연결 테스트 · 모델 조회</button>
    {pending && <p role="status" className="text-sm">연결 확인 중…</p>}
    {result && (result.ok ? <div className="grid gap-2">
      <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{`연결 성공 · ${result.latencyMs}ms · 모델 ${result.models.length}개`}</p>
      {result.models.length > 12 && <Input aria-label="모델 검색" placeholder="모델 검색" value={filter}
        onChange={(event) => setFilter(event.target.value)} />}
      {models.length > 0 && <select aria-label="조회된 모델" className="min-w-0 rounded-md border bg-background p-2 text-sm" value=""
        onChange={(event) => update({ model: event.target.value })}>
        <option value="" disabled>모델 선택</option>
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}
      </select>}
      {result.models.length > 0 && models.length === 0 && <p className="text-sm text-muted-foreground">검색 결과가 없습니다.</p>}
    </div> : <p role="alert" className="text-sm text-destructive">
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
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Multi-CLI &amp; Model Runtime (OpenBot Manager)</h2>
        {runtimes.length > 0 && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
            {`${installedCount} / ${runtimes.length} CLI 설치됨`}
          </span>
        )}
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", status?.installed
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
          : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300")}>
          {status?.installed ? `Pi CLI ${piCliVersionLabel(status.version)}` : "Pi CLI not detected"}
        </span>
        <span className="text-xs text-muted-foreground">{`총 ${catalogModels.length}개 모델`}</span>
      </div>
      <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
        {`${status?.executablePath ?? "pi"} · ${status?.agentDir ?? "~/.pi/agent"}`}
      </p>
      {status?.error && <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{status.error}</p>}
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
        <p role="status" className={cn("mt-3 text-sm",
          actionMutation.data.ok ? "text-emerald-700 dark:text-emerald-300" : "text-destructive")}>
          {actionMutation.data.message}
        </p>
      )}
      {actionMutation.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {actionMutation.error instanceof Error ? actionMutation.error.message : "CLI 런타임 작업에 실패했습니다."}
        </p>
      )}

      {runtimes.length > 0 && (
        <>
          <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Installed Coding Agent CLIs
          </h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {runtimes.map((rt) => {
              const modelsPending = actionPending("models", rt.id);
              const selfPending = actionPending("self", rt.id);
              const checkPending = actionPending("check", rt.id);
              const canSelfUpdate = rt.installed && rt.supportsSelfUpdate;
              return (
              <li key={rt.id} className="grid gap-1.5 rounded-md border border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{rt.name}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", rt.installed
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground")}>
                    {rt.installed ? piCliVersionLabel(rt.version) : "미설치"}
                  </span>
                  {rt.updateAvailable && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      업데이트 가능
                    </span>
                  )}
                  {canSelfUpdate && !rt.updateAvailable && rt.latestVersion && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                      최신 버전
                    </span>
                  )}
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", rt.authConfigured
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300")}>
                    {rt.authConfigured ? "인증됨" : "미인증"}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{`모델 ${rt.modelCount}개`}</span>
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {rt.executablePath ?? rt.adapterType}
                  {rt.authSource ? ` · ${rt.authSource}` : ""}
                </p>
                {rt.updateAvailable && rt.latestVersion && (
                  <p className="font-mono text-xs text-amber-700 dark:text-amber-300">
                    {`${piCliVersionLabel(rt.version)} → v${rt.latestVersion}`}
                  </p>
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
                    <button type="button" className={cn(chip, "px-2 py-0.5 text-xs text-muted-foreground")} disabled={checkPending || statusQuery.isFetching}
                      onClick={() => runUpdateCheck(rt.id)}>
                      {checkPending ? "확인 중…" : "업데이트 확인"}</button>
                  )}
                </div>
                {modelsPending && (
                  <p role="status" className="text-xs text-muted-foreground">모델 목록 새로고침 중…</p>
                )}
              </li>
              );
            })}
          </ul>
        </>
      )}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pi CLI Providers</h3>
      {providers.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">~/.pi/agent/models.json 에 등록된 공급자가 없습니다.</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {providers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <span className="font-mono text-sm font-medium">{p.id}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-xs", p.authConfigured
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300")}>
                {p.authConfigured ? "로그인됨 (auth.json)" : "미인증"}
              </span>
              <span className="text-xs text-muted-foreground">{`${p.api ?? "api 미지정"} · 모델 ${p.modelCount}개`}</span>
              {p.baseUrl && <span className="break-all font-mono text-xs text-muted-foreground">{p.baseUrl}</span>}
              {p.authConfigured && (
                <button type="button" className={cn(chip, "ml-auto px-2 py-1 text-xs text-destructive")} disabled={busy}
                  onClick={() => runAction({ kind: "logout", runtimeId: p.id }, () => instanceSettingsApi.logoutPiCliProvider({ providerId: p.id }))}>
                  로그아웃</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live Pi Model Catalog</h3>
      <Input aria-label="pi 모델 카탈로그 검색" placeholder="모델 검색..." value={modelFilter}
        onChange={(event) => setModelFilter(event.target.value)} className="mt-2 max-w-sm" />
      <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border">
        {filteredModels.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            {catalogModels.length === 0 ? "카탈로그가 비어 있습니다." : "검색 결과가 없습니다."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filteredModels.map((ref) => (
              <li key={ref} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 break-all font-mono text-xs">{ref}</span>
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
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide defaults that affect how operator-visible logs are displayed.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
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
              censorUsernameInLogs ? "bg-green-600" : "bg-muted",
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

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Judgment connection</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
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
            />
          </div>
          <button
            type="button"
            disabled={judgmentMutation.isPending}
            className="inline-flex h-9 w-fit items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => judgmentMutation.mutate(judgmentDraft)}
          >
            Save judgment connection
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Structured LLM connection (1-shot API)</h2>
        {!savedIds.length && (settings?.llmStructuredBaseUrl || settings?.llmStructuredApiKeyConfigured) &&
          <p className="mt-2 break-all text-sm text-muted-foreground">
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
            className={cn(chip, "w-fit bg-primary text-primary-foreground hover:bg-primary/90")}
            onClick={() => structuredMutation.mutate()}>Save structured LLM providers</button>
          {structuredMutation.error && <p role="alert" className="text-sm text-destructive">{structuredMutation.error.message}</p>}
          {structuredMutation.isSuccess && !providerEdits && <p role="status" className="text-sm">공급자 설정을 저장했습니다.</p>}
        </fieldset>
      </section>

      <PiCliManagerSection canApplyModel={rows.length > 0} onApplyModel={applyPiCatalogModel} />
    </div>
  );
}
