export const RUNTIME_PROTOCOL_WINDOW = {
  minimum: 1,
  maximum: 2,
  current: 2,
} as const;

export type RuntimeCapabilityKey =
  | "secretRedaction"
  | "conversationHandoff"
  | "fanoutBarrier"
  | "userFirstPreemption"
  | "traceWaterfall"
  | "providerQuotaRings"
  | "remoteWorkspaceFrame";

export type RuntimeCapabilities = Record<RuntimeCapabilityKey, boolean>;

export interface RuntimeCompatibilitySnapshot {
  serverVersion: string;
  protocol: {
    minimum: number;
    maximum: number;
    current: number;
  };
  capabilities: RuntimeCapabilities;
}

export function buildRuntimeCompatibility(input: {
  serverVersion: string;
  capabilities?: Partial<RuntimeCapabilities>;
}): RuntimeCompatibilitySnapshot {
  return {
    serverVersion: input.serverVersion,
    protocol: { ...RUNTIME_PROTOCOL_WINDOW },
    capabilities: {
      secretRedaction: true,
      conversationHandoff: true,
      fanoutBarrier: true,
      userFirstPreemption: true,
      traceWaterfall: true,
      providerQuotaRings: true,
      remoteWorkspaceFrame: true,
      ...input.capabilities,
    },
  };
}

export function isProtocolVersionCompatible(
  compatibility: Pick<RuntimeCompatibilitySnapshot, "protocol">,
  clientVersion: number,
): boolean {
  if (!Number.isInteger(clientVersion)) return false;
  return clientVersion >= compatibility.protocol.minimum && clientVersion <= compatibility.protocol.maximum;
}

export function hasRuntimeCapability(
  compatibility: Pick<RuntimeCompatibilitySnapshot, "capabilities"> | null | undefined,
  capability: RuntimeCapabilityKey,
): boolean {
  return compatibility?.capabilities?.[capability] === true;
}
