import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ProviderAuthSection } from "@/components/ProviderAuthSection";
import { instanceSettingsApi, type LlmStructuredConnectionTestResult, type PromptCacheTtl, type ProviderAccountPoolStrategy,
  type UsageLimitGateGeneralSettings, type UsageLimitGateGeneralSettingsPatch } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  chip, chipDanger, chipPrimary, cockpitInset, cockpitPanel, cockpitSectionHeader, INPUT, MONO_SNIPPET,
  PILL_NEUTRAL, PILL_OK, PILL_WARN, presets, providerFields, usePiCliAction, usePiCliStatus,
  type LlmStructuredProvidersController, type ProviderRow,
} from "./shared";

/** 개별 API-key 공급자 카드: 프리셋 이름·주소·모델·키 편집 + 연결 테스트/모델 조회. */
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
    {row.apiKeyConfigured && <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={row.clearApiKey} onChange={(event) => {
        update({ clearApiKey: event.target.checked, apiKey: "" });
        setResult(null);
      }} /> Clear key
    </label>}
    <button type="button" className={cn(chip, "w-fit")} onClick={testConnection}
      disabled={!row.baseUrl.trim() || pending || row.clearApiKey}>연결 테스트 · 모델 조회</button>
    {pending && <p role="status" className="text-xs text-muted-foreground">연결 확인 중…</p>}
    {result && (result.ok ? <div className={cn("grid gap-2 p-3", cockpitInset)}>
      <p role="status" className={cn("text-xs text-[var(--pw-lime)]", MONO_SNIPPET)}>{`연결 성공 · ${result.latencyMs}ms · 모델 ${result.models.length}개`}</p>
      {result.models.length > 12 && <Input aria-label="모델 검색" placeholder="모델 검색" value={filter} className={INPUT}
        onChange={(event) => setFilter(event.target.value)} />}
      {models.length > 0 && <select aria-label="조회된 모델" className={cn(INPUT, "min-w-0 p-2")} value=""
        onChange={(event) => update({ model: event.target.value })}>
        <option value="" disabled>모델 선택</option>
        {[...new Set(models)].map((model) => <option key={model} value={model}>{model}</option>)}
      </select>}
      {result.models.length > 0 && models.length === 0 && <p className="text-xs text-muted-foreground">검색 결과가 없습니다.</p>}
    </div> : <p role="alert" className="text-xs text-destructive">
      {result.statusCode ? `연결 실패 (HTTP ${result.statusCode}).` : "연결 실패. Base URL과 API Key를 확인해 주세요."}
    </p>)}
  </fieldset>;
}

/** Pi CLI auth.json 에 로그인된 구독(OAuth) 공급자 목록 — Providers 탭 하위 섹션 A 전용 로그아웃 액션. */
function PiSubscriptionAuthProviders() {
  const statusQuery = usePiCliStatus();
  const { busy, mutation, run, isPending } = usePiCliAction();
  const providers = Array.isArray(statusQuery.data?.providers) ? statusQuery.data.providers : [];
  const loggedInCount = providers.filter((p) => p.authConfigured).length;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={cockpitSectionHeader}>Pi CLI auth.json providers</h3>
        {providers.length > 0 && (
          <span className={PILL_NEUTRAL}>{`${loggedInCount} / ${providers.length} 로그인됨`}</span>
        )}
      </div>
      {providers.length === 0 ? (
        <p className={cn("mt-2 text-xs text-muted-foreground", MONO_SNIPPET)}>~/.pi/agent/models.json 에 등록된 공급자가 없습니다.</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {providers.map((p) => (
            <li key={p.id} className={cn("flex flex-wrap items-center gap-2 px-3 py-2", cockpitInset)}>
              <span className="min-w-0 truncate font-mono text-sm font-semibold text-foreground">{p.id}</span>
              <span className={p.authConfigured ? PILL_OK : PILL_WARN}>{p.authConfigured ? "로그인됨 (auth.json)" : "미인증"}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{`${p.api ?? "api 미지정"} · 모델 ${p.modelCount}개`}</span>
              {p.baseUrl && <span className={cn("text-xs text-muted-foreground", MONO_SNIPPET)}>{p.baseUrl}</span>}
              {p.authConfigured && (
                <button type="button" className={cn(chipDanger, "ml-auto py-1")} disabled={busy}
                  onClick={() => run({ kind: "logout", runtimeId: p.id }, () => instanceSettingsApi.logoutPiCliProvider({ providerId: p.id }))}>
                  {isPending("logout", p.id) ? "로그아웃 중…" : "로그아웃"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {mutation.data && (
        <p role="status" className={cn("mt-2 text-xs", MONO_SNIPPET, mutation.data.ok ? "text-[var(--pw-lime)]" : "text-destructive")}>
          {mutation.data.message}
        </p>
      )}
      {mutation.error && (
        <p role="alert" className={cn("mt-2 text-xs text-destructive", MONO_SNIPPET)}>
          {mutation.error instanceof Error ? mutation.error.message : "CLI 런타임 작업에 실패했습니다."}
        </p>
      )}
    </div>
  );
}

/** [stage28-w2] 줄바꿈 또는 쉼표로 구분된 숨길 모델 입력을 정규화한다(공백·빈 항목 제거). */
export function parseHiddenModelsInput(raw: string): string[] {
  return raw.split(/[\n,]/).map((part) => part.trim()).filter((part) => part !== "");
}

export interface ModelPolicyDraft {
  promptCacheTtl: PromptCacheTtl; providerAccountPoolStrategy: ProviderAccountPoolStrategy; hiddenModelsText: string;
}

/** 저장된 일반 설정에서 정책 초안을 만든다(W1 병합 전 필드는 undefined → 기본값). */
export function toModelPolicyDraft(settings?: UsageLimitGateGeneralSettings | null): ModelPolicyDraft {
  return {
    promptCacheTtl: settings?.promptCacheTtl ?? "default",
    providerAccountPoolStrategy: settings?.providerAccountPoolStrategy ?? "earliest_reset",
    hiddenModelsText: (settings?.hiddenModels ?? []).join(", "),
  };
}

export function toModelPolicyPatch(draft: ModelPolicyDraft): UsageLimitGateGeneralSettingsPatch {
  return {
    promptCacheTtl: draft.promptCacheTtl,
    providerAccountPoolStrategy: draft.providerAccountPoolStrategy,
    hiddenModels: parseHiddenModelsInput(draft.hiddenModelsText),
  };
}

const PROMPT_CACHE_TTL_OPTIONS = [
  { value: "default", label: "기본 (모델 기본값)" }, { value: "5m", label: "5분" }, { value: "1h", label: "1시간" },
] satisfies ReadonlyArray<{ value: PromptCacheTtl; label: string }>;
const POOL_STRATEGY_OPTIONS = [
  { value: "earliest_reset", label: "가장 빠른 리셋 우선 (기본)" }, { value: "round_robin", label: "라운드 로빈" }, { value: "manual", label: "수동" },
] satisfies ReadonlyArray<{ value: ProviderAccountPoolStrategy; label: string }>;

/** Tab 2 하위 섹션 — 모델 노출(hiddenModels)·Prompt Cache TTL·계정 풀 로테이션 전략 저장. */
function ModelExposurePolicySection() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: queryKeys.instance.generalSettings, queryFn: () => instanceSettingsApi.getGeneral() });
  const settings = settingsQuery.data;
  const [draft, setDraft] = useState<ModelPolicyDraft>(() => toModelPolicyDraft(settings));
  const [syncedWith, setSyncedWith] = useState(settings);
  // 서버 데이터가 바뀌면(초기 로딩·재조회) 초안을 덮어쓴다 — 렌더 중 동기화(SSR 안전, useEffect 불필요).
  if (settings !== syncedWith) {
    setSyncedWith(settings);
    setDraft(toModelPolicyDraft(settings));
  }
  const saveMutation = useMutation({
    mutationFn: () => instanceSettingsApi.updateGeneral(toModelPolicyPatch(draft)),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }); },
  });
  const { error } = saveMutation;
  return (
    <fieldset disabled={saveMutation.isPending} className={cn("mt-4 grid gap-3", cockpitInset)}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">Prompt Cache TTL
          <select aria-label="Prompt Cache TTL" className={cn(INPUT, "min-w-0 p-2")} value={draft.promptCacheTtl}
            onChange={(event) => setDraft({ ...draft, promptCacheTtl: event.target.value as PromptCacheTtl })}>
            {PROMPT_CACHE_TTL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">계정 풀 로테이션 전략
          <select aria-label="계정 풀 로테이션 전략" className={cn(INPUT, "min-w-0 p-2")} value={draft.providerAccountPoolStrategy}
            onChange={(event) => setDraft({ ...draft, providerAccountPoolStrategy: event.target.value as ProviderAccountPoolStrategy })}>
            {POOL_STRATEGY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm font-medium">숨길 모델 (Hidden models)
        <textarea aria-label="숨길 모델 (Hidden models)" className="min-h-16 w-full rounded-md border border-border bg-card p-2 font-mono text-xs"
          placeholder={"예: glm-4.7, gpt-4o-mini\n줄바꿈 또는 쉼표로 구분"} value={draft.hiddenModelsText}
          onChange={(event) => setDraft({ ...draft, hiddenModelsText: event.target.value })} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={cn(chipPrimary, "w-fit font-semibold")} disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}>정책 저장</button>
        {saveMutation.isPending && <p role="status" className="text-xs text-muted-foreground">저장 중…</p>}
        {saveMutation.isSuccess && <p role="status" className="text-xs text-[var(--pw-lime)]">모델 노출·캐시·계정 풀 정책을 저장했습니다.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error instanceof Error ? error.message : "정책 저장에 실패했습니다."}</p>}
      </div>
    </fieldset>
  );
}

/** Tab 2 — Providers: 구독 인증(Subscription/OAuth) + API 인증(API Key) 하위 섹션. */
export function ProvidersTab({ controller }: { controller: LlmStructuredProvidersController }) {
  const { rows, savedIds, defaultId, dirty, busy, saved, error, legacyNote } = controller;
  return (
    <div role="tabpanel" id="panel-providers" aria-labelledby="tab-providers" tabIndex={0} className="space-y-3">
      <section className={cn(cockpitPanel, "p-4")}>
        <h2 className={cockpitSectionHeader}>구독 인증 (Subscription / OAuth)</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          웹 보드 OAuth 로그인과 Pi CLI auth.json 구독 로그인(로그아웃)을 한 곳에서 관리합니다.
        </p>
        <PiSubscriptionAuthProviders />
        <div className="mt-4"><ProviderAuthSection /></div>
      </section>
      <section className={cn(cockpitPanel, "p-4")}>
        <h2 className={cockpitSectionHeader}>API 인증 (API Key)</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          Structured LLM connection (1-shot API) — 호출마다 API Key를 직접 사용하는 공급자를 등록하고 기본 공급자를 지정합니다.
        </p>
        {legacyNote && <p className={cn("mt-2 text-xs text-muted-foreground", MONO_SNIPPET)}>{legacyNote}</p>}
        <fieldset disabled={busy} className="mt-4 grid min-w-0 gap-4">
          <div className="flex flex-wrap gap-2">
            {(["custom", "deepseek", "zai", "openai"] as const).map((preset) =>
              <button key={preset} type="button" className={chip} onClick={() => controller.addRow(preset)}>
                {preset === "custom" ? "+ 공급자 추가" : presets[preset][0]}
              </button>)}
          </div>
          {rows.map((row) => <ProviderCard key={row.id} row={row} saved={savedIds.includes(row.id)}
            isDefault={row.id === defaultId} selectDefault={() => controller.selectDefault(row.id)}
            update={(patch) => controller.updateRow(row.id, patch)}
            remove={() => controller.removeRow(row.id)} />)}
          <button type="button" disabled={!dirty || rows.some(({ name, baseUrl }) => !name.trim() || !baseUrl.trim())}
            className={cn(chipPrimary, "w-fit font-semibold")}
            onClick={controller.save}>Save structured LLM providers</button>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {saved && <p role="status" className="text-xs text-[var(--pw-lime)]">공급자 설정을 저장했습니다.</p>}
        </fieldset>
      </section>
      <section className={cn(cockpitPanel, "p-4")}>
        <h2 className={cockpitSectionHeader}>모델 노출 · Prompt Cache · 계정 풀 정책</h2>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">숨길 모델은 보드 모델 목록·폴백 제안에서 제외되고, 나머지 정책은 하트비트 실행의 API 사용 방식을 결정합니다.</p>
        <ModelExposurePolicySection />
      </section>
    </div>
  );
}
