import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import type { InstanceGeneralSettings, PatchInstanceGeneralSettings } from "@paperclipai/shared";
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
    },
  });

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
    </div>
  );
}
