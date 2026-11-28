import { describe, expect, it } from "vitest";
import {
  estimateUsageCostUsd,
  lookupModelPricing,
  MODEL_TOKEN_PRICING,
} from "../services/adapter-model-cost-table.js";

describe("estimateUsageCostUsd", () => {
  it.each(["swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"])(
    "returns zero cost and freeTier for Devin SWE-2 Flash model %s",
    (model) => {
      expect(estimateUsageCostUsd({
        model,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedInputTokens: 250_000,
      })).toEqual({ costUsd: 0, freeTier: true });
    },
  );

  it("computes paid model cost with cached input tokens", () => {
    expect(estimateUsageCostUsd({
      model: "glm-5.3",
      inputTokens: 100_000,
      outputTokens: 20_000,
      cachedInputTokens: 50_000,
    })).toEqual({ costUsd: 0.241, freeTier: false });
  });

  it("clamps negative token counts to zero", () => {
    expect(estimateUsageCostUsd({
      model: "glm-5.3",
      inputTokens: -100_000,
      outputTokens: 10_000,
      cachedInputTokens: -50_000,
    })).toEqual({ costUsd: 0.044, freeTier: false });
  });

  it("rounds estimated cost to six decimals", () => {
    expect(estimateUsageCostUsd({
      model: "gpt-5.4",
      inputTokens: 333,
      outputTokens: 0,
    })).toEqual({ costUsd: 0.000833, freeTier: false });
  });

  it("returns null cost for unknown models", () => {
    expect(estimateUsageCostUsd({
      model: "unknown-local-model",
      inputTokens: 100_000,
      outputTokens: 20_000,
    })).toEqual({ costUsd: null, freeTier: false });
  });
});

describe("lookupModelPricing", () => {
  it("matches model ids case-insensitively by prefix and prefers the longest pricing key", () => {
    expect(lookupModelPricing("GLM-5.3-FLASH-20261001"))
      .toBe(MODEL_TOKEN_PRICING["glm-5.3-flash"]);
  });
});
