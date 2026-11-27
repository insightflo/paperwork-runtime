import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import {
  type InstanceGeneralSettings,
  instanceExperimentalSettingsSchema,
  judgmentBaseUrlSchema,
  judgmentModelIdSchema,
  type InstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  type InstanceSettings,
  type PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import type { LlmStructuredConnectionTestResult } from "@paperclipai/shared/types/instance";
import { llmStructuredProviderFieldsSchema, type LlmStructuredTestConnectionInput } from "@paperclipai/shared/validators/instance";
import { eq } from "drizzle-orm";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";

const DEFAULT_SINGLETON_KEY = "default";

function hasEncryptedMaterial(value: unknown): value is { material: StoredSecretVersionMaterial } {
  if (value === null || typeof value !== "object" || !("material" in value)) return false;
  const { material } = value;
  return material !== null && typeof material === "object" &&
    "scheme" in material && material.scheme === "local_encrypted_v1" &&
    "iv" in material && typeof material.iv === "string" &&
    "tag" in material && typeof material.tag === "string" &&
    "ciphertext" in material && typeof material.ciphertext === "string";
}

function readProviders(raw: unknown) {
  return Array.isArray(raw) ? raw.flatMap((entry: unknown) => {
    const parsed = llmStructuredProviderFieldsSchema.safeParse(entry);
    if (!parsed.success) return [];
    const { model, ...fields } = parsed.data;
    const { apiKeyEncrypted } = entry as Record<string, unknown>;
    return [{ ...fields, ...(model ? { model } : {}), apiKeyEncrypted }];
  }) : undefined;
}

async function resolveKey(encrypted: unknown) {
  if (!hasEncryptedMaterial(encrypted)) return undefined;
  return localEncryptedProvider.resolveVersion({ material: encrypted.material, externalRef: null }).catch(() => undefined);
}

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const baseUrl = judgmentBaseUrlSchema.safeParse(source.judgmentBaseUrl);
  const modelId = judgmentModelIdSchema.safeParse(source.judgmentModelId);
  const llmBaseUrl = judgmentBaseUrlSchema.safeParse(source.llmStructuredBaseUrl);
  const llmModel = judgmentModelIdSchema.safeParse(source.llmStructuredModel);
  const providers = readProviders(source.llmStructuredProviders);
  const defaultProvider = providers?.find(({ id }) => id === source.llmStructuredDefaultProviderId);
  // 필드 단위 검증: 한 필드가 손상되어도 다른 필드(예: censorUsernameInLogs)까지
  // 기본값으로 되돌리지 않는다. null/불량값은 해당 오버라이드만 뺀다.
  return {
    censorUsernameInLogs: source.censorUsernameInLogs === true,
    ...(baseUrl.success && baseUrl.data !== null ? { judgmentBaseUrl: baseUrl.data } : {}),
    ...(modelId.success && modelId.data !== null ? { judgmentModelId: modelId.data } : {}),
    judgmentApiKeyConfigured: hasEncryptedMaterial(source.judgmentApiKeyEncrypted),
    ...(llmBaseUrl.success && llmBaseUrl.data !== null ? { llmStructuredBaseUrl: llmBaseUrl.data } : {}),
    ...(llmModel.success && llmModel.data !== null ? { llmStructuredModel: llmModel.data } : {}),
    llmStructuredApiKeyConfigured: hasEncryptedMaterial(source.llmStructuredApiKeyEncrypted),
    ...(providers ? { llmStructuredProviders: providers.map(({ apiKeyEncrypted, ...fields }) => ({
      ...fields, apiKeyConfigured: hasEncryptedMaterial(apiKeyEncrypted),
    })) } : {}),
    ...(defaultProvider ? { llmStructuredDefaultProviderId: defaultProvider.id } : {}),
  };
}

function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const parsed = instanceExperimentalSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      enableIsolatedWorkspaces: parsed.data.enableIsolatedWorkspaces ?? false,
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
      enableHeartbeatFinalizationV1: parsed.data.enableHeartbeatFinalizationV1 ?? false,
      enableRunTerminalBoundaryV1: parsed.data.enableRunTerminalBoundaryV1 ?? false,
      enableRunReopenGuardV1: parsed.data.enableRunReopenGuardV1 ?? false,
      enableRunRecoveryServiceV1: parsed.data.enableRunRecoveryServiceV1 ?? false,
      enableWorkProductBindingV1: parsed.data.enableWorkProductBindingV1 ?? false,
      enableKnowledgePatternInjection: parsed.data.enableKnowledgePatternInjection ?? false,
      enableQaRebindRecoveryV1: parsed.data.enableQaRebindRecoveryV1 ?? false,
      enableQaRebindRecoveryCompanyIdsV1: parsed.data.enableQaRebindRecoveryCompanyIdsV1 ?? [],
      // [소비 하드닝 4단계 — 플래그 쓰기 경로] 스키마와 이 투영이 함께 있어야 PATCH 로 저장된다.
      enableWorkProductSelectorRejectV1: parsed.data.enableWorkProductSelectorRejectV1 ?? false,
      enableWorkProductSelectorRejectCompanyIdsV1: parsed.data.enableWorkProductSelectorRejectCompanyIdsV1 ?? [],
      broadSearchAllowedCompanyIdsV1: parsed.data.broadSearchAllowedCompanyIdsV1 ?? [],
      broadSearchAllowedMissionIdsV1: parsed.data.broadSearchAllowedMissionIdsV1 ?? [],
      broadSearchAllowedAgentIdsV1: parsed.data.broadSearchAllowedAgentIdsV1 ?? [],
      enableStaleSourceIssueWakeupV1: parsed.data.enableStaleSourceIssueWakeupV1 ?? false,
      staleSourceIssueWakeupAllowedMissionIdsV1: parsed.data.staleSourceIssueWakeupAllowedMissionIdsV1 ?? [],
      enableResumeReviewReliefV1: parsed.data.enableResumeReviewReliefV1 ?? false,
      resumeReviewReliefAllowedMissionIdsV1: parsed.data.resumeReviewReliefAllowedMissionIdsV1 ?? [],
    };
  }
  return {
    enableIsolatedWorkspaces: false,
    autoRestartDevServerWhenIdle: false,
    enableHeartbeatFinalizationV1: false,
    enableRunTerminalBoundaryV1: false,
    enableRunReopenGuardV1: false,
    enableRunRecoveryServiceV1: false,
    enableWorkProductBindingV1: false,
    enableKnowledgePatternInjection: false,
    enableQaRebindRecoveryV1: false,
    enableQaRebindRecoveryCompanyIdsV1: [],
    // [소비 하드닝 4단계] 파싱 실패 폴백 기본값도 스키마 전체 키와 일치시킨다(fail-open).
    enableWorkProductSelectorRejectV1: false,
    enableWorkProductSelectorRejectCompanyIdsV1: [],
    broadSearchAllowedCompanyIdsV1: [],
    broadSearchAllowedMissionIdsV1: [],
    broadSearchAllowedAgentIdsV1: [],
    enableStaleSourceIssueWakeupV1: false,
    staleSourceIssueWakeupAllowedMissionIdsV1: [],
    enableResumeReviewReliefV1: false,
    resumeReviewReliefAllowedMissionIdsV1: [],
  };
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    general: normalizeGeneralSettings(row.general),
    experimental: normalizeExperimentalSettings(row.experimental),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instanceSettingsService(db: Db) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    return created;
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },
    /** 저장된 판단(Jev) API 키 복호화. 미설정·실패면 undefined(server env 키 폴백 유지). */
    getJudgmentApiKey: async (): Promise<string | undefined> =>
      resolveKey((await getOrCreateRow()).general.judgmentApiKeyEncrypted),

    getLlmStructuredRuntimeConfig: async (providerId?: string): Promise<{ baseUrl?: string; model?: string; apiKey?: string }> => {
      const { general } = await getOrCreateRow();
      const providers = readProviders(general.llmStructuredProviders);
      const selectedId = providerId ?? general.llmStructuredDefaultProviderId ?? providers?.[0]?.id;
      const provider = providers?.find(({ id }) => id === selectedId);
      if (provider) {
        return { baseUrl: provider.baseUrl, model: provider.model, apiKey: await resolveKey(provider.apiKeyEncrypted) };
      }
      const { llmStructuredBaseUrl: baseUrl, llmStructuredModel: model } = normalizeGeneralSettings(general);
      return { baseUrl, model, apiKey: await resolveKey(general.llmStructuredApiKeyEncrypted) };
    },

    testLlmStructuredConnection: async (
      input: LlmStructuredTestConnectionInput, deps?: { fetchImpl?: typeof fetch },
    ): Promise<LlmStructuredConnectionTestResult> => {
      let apiKey = input.apiKey?.trim();
      if (!apiKey) {
        const { general } = await getOrCreateRow();
        const encrypted = input.providerId === undefined ? general.llmStructuredApiKeyEncrypted
          : readProviders(general.llmStructuredProviders)?.find(({ id }) => id === input.providerId)?.apiKeyEncrypted;
        apiKey = await resolveKey(encrypted);
      }
      if (!apiKey) return { ok: false, latencyMs: 0, models: [], error: "api_key_required" };
      const start = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let statusCode: number | undefined;
      const result = (models: string[], error?: string) => ({
        ok: !error, statusCode, latencyMs: Math.round(performance.now() - start), models, ...(error ? { error } : {}),
      });
      try {
        const response = await (deps?.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}/models`, {
          method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal, redirect: "error",
        });
        statusCode = response.status;
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return result([], "upstream_http_error");
        }
        const payload = await response.json();
        const entries = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
        if (!Array.isArray(entries)) return result([], "invalid_models_response");
        const models = new Set<string>();
        for (const entry of entries) {
          const value = typeof entry === "string" ? entry : entry?.id ?? entry?.name;
          if (typeof value === "string" && value.trim() && !value.includes(apiKey)) models.add(value.trim());
        }
        return result([...models].sort().slice(0, 200));
      } catch (err) {
        return result([], controller.signal.aborted ? "timeout" : err instanceof SyntaxError && statusCode !== undefined
          ? "invalid_models_response" : "network_error");
      } finally {
        clearTimeout(timer);
      }
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextGeneral: Record<string, unknown> = { ...normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      }) };
      for (const maskedFlag of ["llmStructuredApiKeyConfigured", "judgmentApiKeyConfigured"] as const) delete nextGeneral[maskedFlag];
      if (typeof patch.llmStructuredApiKey === "string") {
        const { material } = await localEncryptedProvider.createVersion({ value: patch.llmStructuredApiKey, externalRef: null });
        nextGeneral.llmStructuredApiKeyEncrypted = { material };
      } else if (patch.llmStructuredApiKey === undefined && Object.hasOwn(current.general, "llmStructuredApiKeyEncrypted")) {
        nextGeneral.llmStructuredApiKeyEncrypted = current.general.llmStructuredApiKeyEncrypted;
      }
      if (typeof patch.judgmentApiKey === "string") {
        const { material } = await localEncryptedProvider.createVersion({ value: patch.judgmentApiKey, externalRef: null });
        nextGeneral.judgmentApiKeyEncrypted = { material };
      } else if (patch.judgmentApiKey === undefined && Object.hasOwn(current.general, "judgmentApiKeyEncrypted")) {
        nextGeneral.judgmentApiKeyEncrypted = current.general.judgmentApiKeyEncrypted;
      }
      const existing = readProviders(current.general.llmStructuredProviders);
      if (patch.llmStructuredProviders !== undefined) {
        nextGeneral.llmStructuredProviders = await Promise.all(patch.llmStructuredProviders.map(async ({ apiKey, ...fields }) => {
          const encrypted = apiKey === undefined ? existing?.find(({ id }) => id === fields.id)?.apiKeyEncrypted
            : apiKey === null ? undefined : { material: (await localEncryptedProvider.createVersion({ value: apiKey, externalRef: null })).material };
          return { ...fields, ...(hasEncryptedMaterial(encrypted) ? { apiKeyEncrypted: encrypted } : {}) };
        }));
      } else if (existing) {
        nextGeneral.llmStructuredProviders = existing;
      }
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: nextGeneral,
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = normalizeExperimentalSettings({
        ...normalizeExperimentalSettings(current.experimental),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
