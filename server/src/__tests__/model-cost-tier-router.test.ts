import { describe, expect, it } from "vitest";
import { routeModelForTask } from "../services/model-cost-tier-router.js";

describe("model cost tier router", () => {
  it("routes devin_local light work to the economy flash tier", () => {
    const result = routeModelForTask({ adapterType: "devin_local", complexity: "light" });

    expect(result).toMatchObject({
      adapterType: "devin_local",
      selectedModel: "swe-2-flash-medium",
      tier: "economy",
      downgradedForBudget: false,
    });
  });

  it("routes devin_local standard work to the balanced flash tier", () => {
    const result = routeModelForTask({ adapterType: "devin_local", complexity: "standard" });

    expect(result).toMatchObject({
      adapterType: "devin_local",
      selectedModel: "swe-2-flash-high",
      tier: "balanced",
      downgradedForBudget: false,
    });
  });

  it("routes devin_local heavy work to the frontier tier under normal budget pressure", () => {
    const result = routeModelForTask({
      adapterType: "devin_local",
      complexity: "heavy",
      budgetPressure: "normal",
    });

    expect(result).toMatchObject({
      adapterType: "devin_local",
      selectedModel: "swe-2-1-max",
      tier: "frontier",
      downgradedForBudget: false,
    });
  });

  it("downgrades devin_local heavy work to balanced under critical budget pressure", () => {
    const result = routeModelForTask({
      adapterType: "devin_local",
      complexity: "heavy",
      budgetPressure: "critical",
    });

    expect(result).toMatchObject({
      adapterType: "devin_local",
      selectedModel: "swe-2-flash-high",
      tier: "balanced",
      downgradedForBudget: true,
    });
    expect(result.reason).toContain("Critical budget pressure");
  });

  it("honors a preferred model when budget pressure is not critical", () => {
    const result = routeModelForTask({
      adapterType: "devin_local",
      complexity: "heavy",
      budgetPressure: "normal",
      preferredModel: "custom-preferred-model",
    });

    expect(result).toMatchObject({
      selectedModel: "custom-preferred-model",
      tier: "frontier",
      downgradedForBudget: false,
    });
  });

  it("ignores a preferred model and forces the budget downgrade under critical pressure", () => {
    const result = routeModelForTask({
      adapterType: "devin_local",
      complexity: "heavy",
      budgetPressure: "critical",
      preferredModel: "custom-preferred-model",
    });

    expect(result).toMatchObject({
      selectedModel: "swe-2-flash-high",
      tier: "balanced",
      downgradedForBudget: true,
    });
    expect(result.reason).toContain("ignored the preferred model");
  });

  it("provides deterministic defaults for codex_local, claude_local, and pi_local", () => {
    const cases = [
      {
        adapterType: "codex_local",
        complexity: "light" as const,
        selectedModel: "gpt-5.4-nano",
        tier: "economy" as const,
      },
      {
        adapterType: "claude_local",
        complexity: "standard" as const,
        selectedModel: "claude-sonnet-4-6",
        tier: "balanced" as const,
      },
      {
        adapterType: "pi_local",
        complexity: "heavy" as const,
        selectedModel: "openai/gpt-5.6-terra",
        tier: "frontier" as const,
      },
    ];

    for (const testCase of cases) {
      const result = routeModelForTask({
        adapterType: testCase.adapterType,
        complexity: testCase.complexity,
      });

      expect(result).toMatchObject({
        adapterType: testCase.adapterType,
        selectedModel: testCase.selectedModel,
        tier: testCase.tier,
        downgradedForBudget: false,
      });
    }
  });

  it("uses a capped safe fallback for unknown adapter types", () => {
    const result = routeModelForTask({ adapterType: "future_unknown_adapter", complexity: "heavy" });

    expect(result).toMatchObject({
      adapterType: "future_unknown_adapter",
      selectedModel: "swe-2-flash-high",
      tier: "balanced",
      downgradedForBudget: false,
    });
    expect(result.reason).toContain("Unknown adapter type");
  });
});
