import { useState } from "react";
import { Input } from "@/components/ui/input";
import { ProviderAuthSection } from "@/components/ProviderAuthSection";
import { instanceSettingsApi, type LlmStructuredConnectionTestResult } from "@/api/instanceSettings";
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
    </div>
  );
}
