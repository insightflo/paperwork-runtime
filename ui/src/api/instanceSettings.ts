import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
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
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
};
