import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import type { CliRuntimeId, PiCliActionResult, PiCliStatusSnapshot } from "@paperclipai/shared/types/instance";
import type { LoginActionPlan, ProviderAuthId, ProviderAuthStatus } from "../components/ProviderAuthPanel";
import { api } from "./client";

// The shared package defines this response but does not export it from its root.
export interface LlmStructuredConnectionTestResult {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  models: string[];
  error?: string;
}

/** GET /instance/settings/usage-limit-gate 한 건(어댑터·프로바이더·모델 단위 홀드). 서버 usage-limit-gate 서비스와 동형. */
export interface UsageLimitEntrySnapshot {
  adapterType: string | null;
  provider: string | null;
  model: string | null;
  kind: "limit" | "failed";
  resetsAtMs: number;
  reason: string | null;
}

/** [stage28-w2] 현재 쿼터 제한·실패 쿨다운 홀드의 읽기 전용 스냅샷. */
export interface UsageLimitGateSnapshot {
  limitedModels: UsageLimitEntrySnapshot[];
  failedModels: UsageLimitEntrySnapshot[];
}

export type PromptCacheTtl = "default" | "5m" | "1h";
export type ProviderAccountPoolStrategy = "earliest_reset" | "round_robin" | "manual";

/**
 * [stage28-w2] W1(stage28/w1-account-pool)이 packages/shared 에 추가할 필드의 UI 로컬 교집합 타입.
 * W1 병합 전에도 이 워크트리가 독립적으로 컴파일되도록 하며, 병합 후 shared 타입으로 흡수 예정.
 */
export type UsageLimitGateGeneralSettings = InstanceGeneralSettings & {
  hiddenModels?: string[];
  promptCacheTtl?: PromptCacheTtl;
  providerAccountPoolStrategy?: ProviderAccountPoolStrategy;
};
export type UsageLimitGateGeneralSettingsPatch = PatchInstanceGeneralSettings & {
  hiddenModels?: string[];
  promptCacheTtl?: PromptCacheTtl;
  providerAccountPoolStrategy?: ProviderAccountPoolStrategy;
};

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<UsageLimitGateGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: UsageLimitGateGeneralSettingsPatch) =>
    api.patch<UsageLimitGateGeneralSettings>("/instance/settings/general", patch),
  getUsageLimitGate: () => api.get<UsageLimitGateSnapshot>("/instance/settings/usage-limit-gate"),
  testLlmStructuredConnection: (input: { providerId?: string; baseUrl: string; apiKey?: string }) =>
    api.post<LlmStructuredConnectionTestResult>("/instance/settings/general/llm-structured/test", input),
  getPiCliStatus: () =>
    api.get<PiCliStatusSnapshot>("/instance/settings/general/pi-cli/status"),
  syncPiCli: (input?: { direction?: "both" | "to_pi" | "from_pi" }) =>
    api.post<PiCliActionResult>("/instance/settings/general/pi-cli/sync", input ?? { direction: "both" }),
  updatePiCli: (input: { runtimeId?: CliRuntimeId; target: "self" | "models" }) =>
    api.post<PiCliActionResult>("/instance/settings/general/pi-cli/update", input),
  logoutPiCliProvider: (input: { runtimeId?: CliRuntimeId; providerId: string }) =>
    api.post<PiCliActionResult>("/instance/settings/general/pi-cli/logout", input),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  getProviderAuth: () =>
    api.get<{ providers: ProviderAuthStatus[] }>("/instance/settings/general/provider-auth"),
  getProviderLoginPlan: (provider: ProviderAuthId) =>
    api
      .get<{ plan: LoginActionPlan }>(
        `/instance/settings/general/provider-auth/${encodeURIComponent(provider)}/login-plan`,
      )
      .then((res) => res.plan),
};
