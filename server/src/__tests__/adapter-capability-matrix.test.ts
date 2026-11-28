import { describe, expect, it } from "vitest";
import {
  getAdapterCapabilityProfile,
  listMultiSlotCapableAdapters,
} from "../services/adapter-capability-matrix.js";

describe("getAdapterCapabilityProfile", () => {
  it("returns the devin_local headless capability profile", () => {
    const profile = getAdapterCapabilityProfile("devin_local");

    expect(profile).toMatchObject({
      adapterType: "devin_local",
      supportsSessionResume: true,
      supportsMultiSlot: true,
      requiresWorkspaceTrustBypass: true,
      requiresInProcessModel: true,
      defaultMaxConcurrentRuns: 4,
      maxRecommendedSlots: 10,
    });
  });

  it("returns a conservative single-slot fallback for unknown adapter types", () => {
    const profile = getAdapterCapabilityProfile("unknown_local");

    expect(profile).toMatchObject({
      adapterType: "unknown_local",
      supportsSessionResume: false,
      supportsMultiSlot: false,
      requiresWorkspaceTrustBypass: false,
      requiresInProcessModel: false,
      defaultMaxConcurrentRuns: 1,
      maxRecommendedSlots: 1,
    });
  });
});

describe("listMultiSlotCapableAdapters", () => {
  it("returns multi-slot adapters sorted by adapter type and includes devin_local", () => {
    const profiles = listMultiSlotCapableAdapters();

    expect(profiles.every((profile) => profile.supportsMultiSlot)).toBe(true);
    expect(profiles.map((profile) => profile.adapterType)).toEqual([
      "claude_local",
      "codex_local",
      "commandcode_local",
      "devin_local",
      "pi_local",
    ]);
    expect(profiles.some((profile) => profile.adapterType === "devin_local")).toBe(true);
  });
});
