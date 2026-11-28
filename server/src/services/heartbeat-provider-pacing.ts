export interface ProviderPacingInput {
  provider: string;
  configuredSlots: number;
  inFlightProviderRuns: number;
  recentRateLimitCount: number;
  cooldownUntilMs?: number | null;
  nowMs?: number;
}

export interface ProviderPacingDecision {
  provider: string;
  effectiveSlots: number;
  canDispatchNow: boolean;
  reason: "ok" | "cooldown_active" | "provider_throttled" | "at_slot_limit";
  retryAfterMs: number;
}

export function evaluateProviderPacing(input: ProviderPacingInput): ProviderPacingDecision {
  const configuredSlots = Math.max(1, input.configuredSlots);
  const nowMs = input.nowMs ?? 0;

  if (input.cooldownUntilMs && input.cooldownUntilMs > nowMs) {
    return {
      provider: input.provider,
      effectiveSlots: 0,
      canDispatchNow: false,
      reason: "cooldown_active",
      retryAfterMs: input.cooldownUntilMs - nowMs,
    };
  }

  let effectiveSlots = configuredSlots;
  if (input.recentRateLimitCount >= 3) {
    effectiveSlots = 1;
  } else if (input.recentRateLimitCount >= 1) {
    effectiveSlots = Math.max(1, Math.ceil(configuredSlots / 2));
  }

  if (input.inFlightProviderRuns >= effectiveSlots) {
    return {
      provider: input.provider,
      effectiveSlots,
      canDispatchNow: false,
      reason: input.recentRateLimitCount > 0 ? "provider_throttled" : "at_slot_limit",
      retryAfterMs: 0,
    };
  }

  return {
    provider: input.provider,
    effectiveSlots,
    canDispatchNow: true,
    reason: "ok",
    retryAfterMs: 0,
  };
}
