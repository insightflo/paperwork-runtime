export type TaskComplexityTier = "light" | "standard" | "heavy";
export type BudgetPressure = "normal" | "elevated" | "critical";

export interface ModelTierRouteInput {
  adapterType: string;
  complexity: TaskComplexityTier;
  budgetPressure?: BudgetPressure;
  preferredModel?: string | null;
}

export interface ModelTierRouteResult {
  adapterType: string;
  selectedModel: string;
  tier: "economy" | "balanced" | "frontier";
  downgradedForBudget: boolean;
  reason: string;
}

type ModelCostTier = ModelTierRouteResult["tier"];

interface AdapterTierModels {
  economy: string;
  balanced: string;
  frontier: string;
}

const ADAPTER_TIER_MODELS: Partial<Record<string, AdapterTierModels>> = {
  devin_local: {
    economy: "swe-2-flash-medium",
    balanced: "swe-2-flash-high",
    frontier: "swe-2-1-max",
  },
  codex_local: {
    economy: "gpt-5.4-nano",
    balanced: "gpt-5.4-mini",
    frontier: "gpt-5.6-terra",
  },
  claude_local: {
    economy: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    frontier: "claude-opus-4-8",
  },
  pi_local: {
    economy: "openai/gpt-5.4-nano",
    balanced: "openai/gpt-5.4-mini",
    frontier: "openai/gpt-5.6-terra",
  },
};

const UNKNOWN_ADAPTER_TIER_MODELS: AdapterTierModels = {
  economy: "swe-2-flash-medium",
  balanced: "swe-2-flash-high",
  frontier: "swe-2-flash-high",
};

const COMPLEXITY_TIER: Record<TaskComplexityTier, ModelCostTier> = {
  light: "economy",
  standard: "balanced",
  heavy: "frontier",
};

function normalizeAdapterType(adapterType: string): string {
  const normalized = adapterType.trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function hasAdapterTierModels(adapterType: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADAPTER_TIER_MODELS, adapterType);
}

function defaultReason(complexity: TaskComplexityTier, tier: ModelCostTier, budgetPressure: BudgetPressure): string {
  return `Selected cheapest capable ${tier} tier for ${complexity} work under ${budgetPressure} budget pressure.`;
}

export function routeModelForTask(input: ModelTierRouteInput): ModelTierRouteResult {
  const adapterType = normalizeAdapterType(input.adapterType);
  const budgetPressure = input.budgetPressure ?? "normal";
  const preferredModel = input.preferredModel?.trim() ?? "";
  const knownAdapter = hasAdapterTierModels(adapterType);
  const models = knownAdapter ? ADAPTER_TIER_MODELS[adapterType]! : UNKNOWN_ADAPTER_TIER_MODELS;
  const requestedTier = COMPLEXITY_TIER[input.complexity];

  if (preferredModel.length > 0 && budgetPressure !== "critical") {
    return {
      adapterType,
      selectedModel: preferredModel,
      tier: requestedTier,
      downgradedForBudget: false,
      reason: `Preferred model honored because budget pressure is ${budgetPressure}.`,
    };
  }

  let tier = requestedTier;
  if (!knownAdapter && tier === "frontier") {
    tier = "balanced";
  }
  let downgradedForBudget = false;
  if (knownAdapter && input.complexity === "heavy" && budgetPressure === "critical") {
    tier = "balanced";
    downgradedForBudget = true;
  }

  let reason = defaultReason(input.complexity, tier, budgetPressure);
  if (downgradedForBudget) {
    reason = preferredModel.length > 0
      ? "Critical budget pressure ignored the preferred model and downgraded heavy work to the balanced tier."
      : "Critical budget pressure downgraded heavy work to the balanced tier.";
  } else if (preferredModel.length > 0) {
    reason = "Critical budget pressure ignored the preferred model; using the cost-controlled default.";
  } else if (!knownAdapter) {
    reason = "Unknown adapter type; using the capped fallback model ladder.";
  }

  return {
    adapterType,
    selectedModel: models[tier],
    tier,
    downgradedForBudget,
    reason,
  };
}
