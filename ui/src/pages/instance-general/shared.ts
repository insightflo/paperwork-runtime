import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstanceGeneralSettings, PatchInstanceGeneralSettings } from "@paperclipai/shared";
import type { PiCliActionResult } from "@paperclipai/shared/types/instance";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Instance General 설정 4개 탭이 공유하는 스타일 토큰·데이터 헬퍼·CLI 액션 훅.
 * 스타일은 Paperwork 시맨틱 토큰(bg-card / border-border / text-muted-foreground / var(--pw-*))만 사용한다.
 */

// ——— Paperwork 시맨틱 스타일 토큰 ———
export const chip = "rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/35 hover:bg-accent disabled:opacity-60";
export const chipPrimary = "rounded-md border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60";
export const chipDanger = "rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:border-destructive/35 hover:bg-destructive/10 disabled:opacity-60";
export const INPUT = "h-8 rounded-md";
export const PILL_OK = "rounded-full border border-[var(--pw-lime)]/30 bg-[var(--pw-lime-soft)] px-2 py-0.5 text-xs font-medium text-[var(--pw-lime)]";
export const PILL_WARN = "rounded-full border border-[var(--pw-amber)]/30 bg-[var(--pw-amber-soft)] px-2 py-0.5 text-xs font-medium text-[var(--pw-amber)]";
export const PILL_NEUTRAL = "rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground";
export const MONO_SNIPPET = "whitespace-pre-wrap break-all font-mono";
export const cockpitSectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
export const cockpitPanel = "tactile-card rounded-[12px] bg-card";
export const cockpitInset = "rounded-[10px] border border-[var(--pw-hairline)] bg-accent/50";

// ——— Judgment (판단 연결) 초안·패치 ———
export interface JudgmentConnectionDraft {
  judgmentBaseUrl: string;
  judgmentModelId: string;
  judgmentApiKey: string;
  clearJudgmentApiKey: boolean;
}

export function toJudgmentDraft(
  settings?: { judgmentBaseUrl?: string; judgmentModelId?: string } | null,
): JudgmentConnectionDraft {
  return {
    judgmentBaseUrl: settings?.judgmentBaseUrl ?? "",
    judgmentModelId: settings?.judgmentModelId ?? "",
    judgmentApiKey: "",
    clearJudgmentApiKey: false,
  };
}

export function toGeneralPatch(
  draft: JudgmentConnectionDraft,
): PatchInstanceGeneralSettings & { judgmentApiKey?: string | null } {
  const judgmentBaseUrl = draft.judgmentBaseUrl.trim();
  const judgmentModelId = draft.judgmentModelId.trim();
  const judgmentApiKey = draft.judgmentApiKey.trim();
  // judgmentApiKey(응답의 judgmentApiKeyConfigured 포함)는 s25-judgment-key 브랜치가 shared 스키마에
  // 병렬로 추가한다. UI 는 먼저 필드를 전송하고, 교집합 타입으로 기존 패치 정합성을 유지한다.
  const patch: PatchInstanceGeneralSettings & { judgmentApiKey?: string | null } = {
    judgmentBaseUrl: judgmentBaseUrl === "" ? null : judgmentBaseUrl,
    judgmentModelId: judgmentModelId === "" ? null : judgmentModelId,
    ...(draft.clearJudgmentApiKey ? { judgmentApiKey: null } : judgmentApiKey ? { judgmentApiKey } : {}),
  };
  return patch;
}

// ——— Structured LLM (1-shot API) 초안·패치 ———
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

export const presets = {
  deepseek: ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
  zai: ["Z.AI", "https://api.z.ai/api/paas/v4", "glm-4.7"],
  openai: ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  custom: ["Custom", "", ""],
} as const;
export type Preset = keyof typeof presets;
export type ProviderRow = { id: string; name: string; baseUrl: string; model: string; apiKey: string; apiKeyConfigured: boolean; clearApiKey: boolean };
export const providerFields = [["name", "공급자 이름 (Name)"], ["baseUrl", "Base URL"], ["model", "Model"], ["apiKey", "API Key"]] as const;

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

// ——— Pi CLI 상태·액션 ———
export const PI_CLI_STATUS_QUERY_KEY = ["instance", "pi-cli-status"] as const;

export function piCliVersionLabel(version: string | null | undefined): string {
  const cleaned = (version ?? "").trim().replace(/^pi[\s_-]*/i, "").replace(/^v/i, "").trim();
  return cleaned ? `v${cleaned}` : "v?";
}

export function piCatalogModelName(ref: string): string {
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/** 진행 중인 CLI 관리 작업 추적용 — 버튼 라벨/상태 표시기를 런타임·작업별로 전환한다. */
export type CliPendingKind = "sync" | "models" | "self" | "check" | "logout";
export type CliPendingAction = { runtimeId?: string; kind: CliPendingKind } | null;

export function usePiCliStatus() {
  return useQuery({
    queryKey: PI_CLI_STATUS_QUERY_KEY,
    queryFn: () => instanceSettingsApi.getPiCliStatus(),
  });
}

export function usePiCliAction() {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<CliPendingAction>(null);
  const mutation = useMutation({
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
  const run = (pending: Exclude<CliPendingAction, null>, action: () => Promise<PiCliActionResult>) => {
    setPendingAction(pending);
    mutation.mutate(action);
  };
  const isPending = (kind: CliPendingKind, runtimeId?: string) =>
    pendingAction?.kind === kind && (runtimeId === undefined || pendingAction.runtimeId === runtimeId);
  return { mutation, run, isPending, busy: mutation.isPending };
}

// ——— Structured LLM 공급자 편집 컨트롤러 (탭 전환 사이에 편집 상태를 보존한다) ———
export interface LlmStructuredProvidersController {
  rows: ProviderRow[];
  savedIds: string[];
  defaultId?: string;
  /** 저장되지 않은 편집이 있는지 (Save 버튼 활성 조건). */
  dirty: boolean;
  busy: boolean;
  /** 방금 저장 성공(편집 반영 후) 표시용. */
  saved: boolean;
  error: string | null;
  /** 기존 단일 연결(settings.llmStructured*) 마이그레이션 안내 문구. 공급자가 없을 때만 노출. */
  legacyNote: string | null;
  addRow: (preset: Preset) => void;
  updateRow: (id: string, patch: Partial<ProviderRow>) => void;
  removeRow: (id: string) => void;
  selectDefault: (id: string) => void;
  save: () => void;
  canApplyModel: boolean;
  applyCatalogModel: (modelRef: string) => void;
}

export function useLlmStructuredProviders(settings?: InstanceGeneralSettings | null): LlmStructuredProvidersController {
  const queryClient = useQueryClient();
  const [providerEdits, setProviderEdits] = useState<{ rows: ProviderRow[]; defaultId?: string } | null>(null);
  const rows = providerEdits?.rows ?? toLlmStructuredProvidersDraft(settings);
  const defaultId = providerEdits ? providerEdits.defaultId : settings?.llmStructuredDefaultProviderId;
  const savedIds = settings?.llmStructuredProviders?.map(({ id }) => id) ?? [];
  const mutation = useMutation({
    throwOnError: false,
    mutationFn: () => instanceSettingsApi.updateGeneral(toLlmStructuredProvidersPatch(rows, defaultId))
      .catch(() => { throw new Error("Could not save structured LLM providers. Check the provider settings and try again."); }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.instance.generalSettings, updated);
      setProviderEdits(null);
      void queryClient.invalidateQueries({ queryKey: PI_CLI_STATUS_QUERY_KEY });
    },
  });
  const legacyNote = savedIds.length === 0 && (settings?.llmStructuredBaseUrl || settings?.llmStructuredApiKeyConfigured)
    ? `기존 연결: ${settings?.llmStructuredBaseUrl || "주소 미설정"} · ${settings?.llmStructuredModel || "모델 미설정"}${settings?.llmStructuredApiKeyConfigured ? " · 키 등록됨" : " · 키 미등록"}. 새 공급자의 키는 별도로 입력해 주세요.`
    : null;
  return {
    rows, savedIds, defaultId, legacyNote,
    dirty: providerEdits !== null,
    busy: mutation.isPending,
    saved: mutation.isSuccess === true && providerEdits === null,
    error: mutation.error instanceof Error ? mutation.error.message : null,
    addRow: (preset) => setProviderEdits({
      rows: [...rows, createNewProviderRow(preset, [...savedIds, ...rows.map(({ id }) => id)])], defaultId,
    }),
    updateRow: (id, patch) => setProviderEdits({
      rows: rows.map((item) => (item.id === id ? { ...item, ...patch } : item)), defaultId,
    }),
    removeRow: (id) => setProviderEdits({
      rows: rows.filter((row) => row.id !== id), defaultId: defaultId === id ? undefined : defaultId,
    }),
    selectDefault: (id) => setProviderEdits({ rows, defaultId: id }),
    save: () => mutation.mutate(),
    canApplyModel: rows.length > 0,
    applyCatalogModel: (modelRef) => {
      const targetId = defaultId ?? rows[0]?.id;
      if (!targetId) return;
      setProviderEdits({
        rows: rows.map((row) => (row.id === targetId ? { ...row, model: piCatalogModelName(modelRef) } : row)),
        defaultId: defaultId ?? targetId,
      });
    },
  };
}
