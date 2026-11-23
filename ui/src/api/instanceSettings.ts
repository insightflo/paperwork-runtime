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

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
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
    api.get<LoginActionPlan>(`/instance/settings/general/provider-auth/${encodeURIComponent(provider)}/login-plan`),
};
