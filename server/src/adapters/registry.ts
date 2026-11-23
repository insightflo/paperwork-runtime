import type { ServerAdapterModule } from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import { acpxLocalAdapter } from "./acpx-retired.js";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@paperclipai/adapter-codex-local";
import { listCodexModels } from "./codex-models.js";
import { listClaudeModels } from "./claude-models.js";
import { listHermesModels } from "./hermes-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import { agentConfigurationDoc as piAgentConfigurationDoc } from "@paperclipai/adapter-pi-local";
import {
  execute as commandCodeExecute,
  testEnvironment as commandCodeTestEnvironment,
  sessionCodec as commandCodeSessionCodec,
  listCommandCodeSkills,
  syncCommandCodeSkills,
  listCommandCodeModels,
  discoverCommandCodeModelEffortsCached,
} from "@paperclipai/adapter-commandcode-local/server";
import { agentConfigurationDoc as commandCodeAgentConfigurationDoc } from "@paperclipai/adapter-commandcode-local";
import {
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { executeHermesLocal } from "./hermes-local-execute.js";
import { listHermesSkills, syncHermesSkills } from "./hermes-skills.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};
const commandCodeLocalAdapter: ServerAdapterModule = {
  type: "commandcode_local",
  execute: commandCodeExecute,
  testEnvironment: commandCodeTestEnvironment,
  listSkills: listCommandCodeSkills,
  syncSkills: syncCommandCodeSkills,
  sessionCodec: commandCodeSessionCodec,
  sessionManagement: getAdapterSessionManagement("commandcode_local") ?? undefined,
  models: [],
  listModels: listCommandCodeModels,
  listModelEfforts: discoverCommandCodeModelEffortsCached,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: commandCodeAgentConfigurationDoc,
};
const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: executeHermesLocal,
  testEnvironment: hermesTestEnvironment,
  sessionCodec: hermesSessionCodec,
  sessionManagement: getAdapterSessionManagement("hermes_local") ?? undefined,
  models: hermesModels,
  listModels: listHermesModels,
  supportsLocalAgentJwt: true,
  listSkills: listHermesSkills,
  syncSkills: syncHermesSkills,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
};
const adaptersByType = new Map<string, ServerAdapterModule>(
  [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    piLocalAdapter,
    commandCodeLocalAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ].map((a) => [a.type, a]),
);

export function getServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // Fall back to process adapter for unknown types for explicit legacy callers.
    return processAdapter;
  }
  return adapter;
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) throw new Error(`Unknown adapter type: ${type}`);
  return adapter;
}

export async function listAdapterModels(
  type: string,
  provider?: string,
): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels(provider);
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelEfforts(type: string, modelId: string): Promise<string[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter?.listModelEfforts) return [];
  return adapter.listModelEfforts(modelId);
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}
