export interface ModelTokenPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  freeTier?: boolean;
}

export interface TokenUsageEstimateInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

const FREE_TIER_PRICING: ModelTokenPricing = { inputPerMillionUsd: 0, outputPerMillionUsd: 0, cachedInputPerMillionUsd: 0, freeTier: true };
const SWE_2_1_PRICING: ModelTokenPricing = { inputPerMillionUsd: 2, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.2 };
const CLAUDE_SONNET_PRICING: ModelTokenPricing = { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cachedInputPerMillionUsd: 0.3 };
const GLM_5_3_PRICING: ModelTokenPricing = { inputPerMillionUsd: 1.4, outputPerMillionUsd: 4.4, cachedInputPerMillionUsd: 0.26 };
const GLM_4_6_PRICING: ModelTokenPricing = { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2, cachedInputPerMillionUsd: 0.11 };

export const MODEL_TOKEN_PRICING: Readonly<Record<string, ModelTokenPricing>> = {
  "swe-2-flash-medium": FREE_TIER_PRICING,
  "swe-2-flash-high": FREE_TIER_PRICING,
  "swe-2-flash-max": FREE_TIER_PRICING,
  "swe-2-1-low": SWE_2_1_PRICING,
  "swe-2-1-medium": SWE_2_1_PRICING,
  "swe-2-1-high": SWE_2_1_PRICING,
  "swe-2-1-max": SWE_2_1_PRICING,
  "claude-opus-4-6": { inputPerMillionUsd: 5, outputPerMillionUsd: 25, cachedInputPerMillionUsd: 0.5 },
  "claude-opus-4": { inputPerMillionUsd: 15, outputPerMillionUsd: 75, cachedInputPerMillionUsd: 1.5 },
  "claude-sonnet-4-6": CLAUDE_SONNET_PRICING,
  "claude-sonnet-4-5": CLAUDE_SONNET_PRICING,
  "claude-sonnet-4": CLAUDE_SONNET_PRICING,
  "claude-haiku-5-5": { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, cachedInputPerMillionUsd: 0.01 },
  "claude-haiku-4-5": { inputPerMillionUsd: 1, outputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.1 },
  "gpt-6.2-astra": { inputPerMillionUsd: 8, outputPerMillionUsd: 40, cachedInputPerMillionUsd: 0.4 },
  "gpt-6.2-sol": { inputPerMillionUsd: 2, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.1 },
  "gpt-5.6-luna": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2, cachedInputPerMillionUsd: 0.02 },
  "gpt-5.4": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15, cachedInputPerMillionUsd: 0.25 },
  "gpt-5.4-mini": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5, cachedInputPerMillionUsd: 0.075 },
  "gpt-5.4-nano": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25, cachedInputPerMillionUsd: 0.02 },
  "gpt-5.2": { inputPerMillionUsd: 1.75, outputPerMillionUsd: 14, cachedInputPerMillionUsd: 0.175 },
  "gpt-5.1": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.125 },
  "gpt-5": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.125 },
  "gpt-5-mini": { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.025 },
  "gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10, cachedInputPerMillionUsd: 1.25 },
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6, cachedInputPerMillionUsd: 0.075 },
  "glm-5.3": GLM_5_3_PRICING,
  "glm-5.3-flash": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.5, cachedInputPerMillionUsd: 0.03 },
  "glm-5.3-flashx": { inputPerMillionUsd: 0.37, outputPerMillionUsd: 1.25, cachedInputPerMillionUsd: 0.075 },
  "glm-5.2": GLM_5_3_PRICING,
  "glm-5.1": GLM_5_3_PRICING,
  "glm-5": { inputPerMillionUsd: 1, outputPerMillionUsd: 3.2, cachedInputPerMillionUsd: 0.2 },
  "glm-4.7": GLM_4_6_PRICING,
  "glm-4.6": GLM_4_6_PRICING,
};

export function lookupModelPricing(model: string): ModelTokenPricing | null {
  const exact = MODEL_TOKEN_PRICING[model];
  if (exact) return exact;

  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return null;

  let bestKey: string | null = null;
  for (const key of Object.keys(MODEL_TOKEN_PRICING)) {
    const normalizedKey = key.toLowerCase();
    const matches = normalizedModel.startsWith(normalizedKey);
    if (matches && (bestKey === null || normalizedKey.length > bestKey.length)) {
      bestKey = key;
    }
  }

  return bestKey ? MODEL_TOKEN_PRICING[bestKey] : null;
}

function clampTokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function estimateUsageCostUsd(input: TokenUsageEstimateInput): {
  costUsd: number | null;
  freeTier: boolean;
} {
  const pricing = lookupModelPricing(input.model);
  if (!pricing) return { costUsd: null, freeTier: false };
  if (pricing.freeTier) return { costUsd: 0, freeTier: true };

  const microUsd =
    clampTokenCount(input.inputTokens) * pricing.inputPerMillionUsd +
    clampTokenCount(input.outputTokens) * pricing.outputPerMillionUsd +
    clampTokenCount(input.cachedInputTokens) * pricing.cachedInputPerMillionUsd;

  return { costUsd: Math.round(microUsd) / 1_000_000, freeTier: false };
}
