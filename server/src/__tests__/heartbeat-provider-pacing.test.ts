import { expect, it } from "vitest";
import { evaluateProviderPacing } from "../services/heartbeat-provider-pacing.js";

it("allows full concurrency when the provider is healthy", () => {
  expect(evaluateProviderPacing({
    provider: "devin",
    configuredSlots: 4,
    inFlightProviderRuns: 3,
    recentRateLimitCount: 0,
  })).toEqual({
    provider: "devin",
    effectiveSlots: 4,
    canDispatchNow: true,
    reason: "ok",
    retryAfterMs: 0,
  });
});

it("halves effective slots after one or two recent rate limits", () => {
  for (const recentRateLimitCount of [1, 2]) {
    expect(evaluateProviderPacing({
      provider: "zai",
      configuredSlots: 5,
      inFlightProviderRuns: 2,
      recentRateLimitCount,
    })).toEqual({
      provider: "zai",
      effectiveSlots: 3,
      canDispatchNow: true,
      reason: "ok",
      retryAfterMs: 0,
    });
  }
});

it("clamps the provider to one slot after three or more recent rate limits", () => {
  const decision = evaluateProviderPacing({
    provider: "anthropic",
    configuredSlots: 8,
    inFlightProviderRuns: 1,
    recentRateLimitCount: 3,
  });

  expect(decision).toEqual({
    provider: "anthropic",
    effectiveSlots: 1,
    canDispatchNow: false,
    reason: "provider_throttled",
    retryAfterMs: 0,
  });
});

it("blocks dispatch during an active cooldown with the exact retry delay", () => {
  expect(evaluateProviderPacing({
    provider: "zai",
    configuredSlots: 4,
    inFlightProviderRuns: 0,
    recentRateLimitCount: 0,
    cooldownUntilMs: 12_500,
    nowMs: 10_000,
  })).toEqual({
    provider: "zai",
    effectiveSlots: 0,
    canDispatchNow: false,
    reason: "cooldown_active",
    retryAfterMs: 2_500,
  });
});

it("keeps pacing decisions isolated across independent providers", () => {
  const throttled = evaluateProviderPacing({
    provider: "zai",
    configuredSlots: 4,
    inFlightProviderRuns: 1,
    recentRateLimitCount: 2,
  });
  const healthy = evaluateProviderPacing({
    provider: "devin",
    configuredSlots: 4,
    inFlightProviderRuns: 1,
    recentRateLimitCount: 0,
  });

  expect(throttled.effectiveSlots).toBe(2);
  expect(throttled.canDispatchNow).toBe(true);
  expect(healthy).toEqual({
    provider: "devin",
    effectiveSlots: 4,
    canDispatchNow: true,
    reason: "ok",
    retryAfterMs: 0,
  });
});
