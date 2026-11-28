export interface AdapterCapabilityProfile {
  adapterType: string;
  displayName: string;
  supportsSessionResume: boolean;
  supportsMultiSlot: boolean;
  requiresWorkspaceTrustBypass: boolean;
  requiresInProcessModel: boolean;
  defaultMaxConcurrentRuns: number;
  maxRecommendedSlots: number;
}

function capabilityProfile(profile: AdapterCapabilityProfile): AdapterCapabilityProfile {
  return Object.freeze(profile);
}

export const LOCAL_ADAPTER_CAPABILITIES: Readonly<Record<string, AdapterCapabilityProfile>> = Object.freeze({
  devin_local: capabilityProfile({
    adapterType: "devin_local",
    displayName: "Devin (local)",
    supportsSessionResume: true,
    supportsMultiSlot: true,
    requiresWorkspaceTrustBypass: true,
    requiresInProcessModel: true,
    defaultMaxConcurrentRuns: 4,
    maxRecommendedSlots: 10,
  }),
  pi_local: capabilityProfile({
    adapterType: "pi_local",
    displayName: "Pi (local)",
    supportsSessionResume: true,
    supportsMultiSlot: true,
    requiresWorkspaceTrustBypass: false,
    requiresInProcessModel: false,
    defaultMaxConcurrentRuns: 1,
    maxRecommendedSlots: 4,
  }),
  codex_local: capabilityProfile({
    adapterType: "codex_local",
    displayName: "Codex (local)",
    supportsSessionResume: true,
    supportsMultiSlot: true,
    requiresWorkspaceTrustBypass: false,
    requiresInProcessModel: false,
    defaultMaxConcurrentRuns: 1,
    maxRecommendedSlots: 4,
  }),
  claude_local: capabilityProfile({
    adapterType: "claude_local",
    displayName: "Claude Code (local)",
    supportsSessionResume: true,
    supportsMultiSlot: true,
    requiresWorkspaceTrustBypass: false,
    requiresInProcessModel: false,
    defaultMaxConcurrentRuns: 1,
    maxRecommendedSlots: 4,
  }),
  commandcode_local: capabilityProfile({
    adapterType: "commandcode_local",
    displayName: "Command Code (local)",
    supportsSessionResume: true,
    supportsMultiSlot: true,
    requiresWorkspaceTrustBypass: true,
    requiresInProcessModel: false,
    defaultMaxConcurrentRuns: 1,
    maxRecommendedSlots: 4,
  }),
});

export function getAdapterCapabilityProfile(adapterType: string): AdapterCapabilityProfile {
  const known = LOCAL_ADAPTER_CAPABILITIES[adapterType];
  if (known) return known;

  return Object.freeze({
    adapterType,
    displayName: "Unknown local adapter",
    supportsSessionResume: false,
    supportsMultiSlot: false,
    requiresWorkspaceTrustBypass: false,
    requiresInProcessModel: false,
    defaultMaxConcurrentRuns: 1,
    maxRecommendedSlots: 1,
  });
}

function compareAdapterTypesAscending(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function listMultiSlotCapableAdapters(): AdapterCapabilityProfile[] {
  return Object.values(LOCAL_ADAPTER_CAPABILITIES)
    .filter((profile) => profile.supportsMultiSlot)
    .sort((left, right) => compareAdapterTypesAscending(left.adapterType, right.adapterType));
}
