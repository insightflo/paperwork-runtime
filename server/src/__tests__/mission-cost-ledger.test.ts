import { describe, expect, it } from "vitest";
import {
  aggregateMissionCostLedger,
  type MissionRunCostEntry,
} from "../services/mission-cost-ledger.js";

function entry(runId: string, adapterType: string, costUsd: number): MissionRunCostEntry {
  return {
    runId,
    adapterType,
    model: "test-model",
    costUsd,
  };
}

describe("aggregateMissionCostLedger", () => {
  it("returns an empty summary for empty input", () => {
    expect(aggregateMissionCostLedger([])).toEqual({
      totalRuns: 0,
      freeTierRuns: 0,
      paidRuns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      byAdapter: [],
    });
  });

  it("aggregates mixed devin_local free-tier and paid runs across adapters", () => {
    const summary = aggregateMissionCostLedger([
      {
        runId: "run-devin-free",
        adapterType: "devin_local",
        model: "swe-2-flash-medium",
        costUsd: 0,
        freeTier: true,
        inputTokens: 1200,
        outputTokens: 300,
      },
      {
        runId: "run-devin-paid",
        adapterType: "devin_local",
        model: "swe-2.1-max",
        costUsd: 0.125001,
        freeTier: false,
        inputTokens: 2000,
        outputTokens: 500,
      },
      {
        runId: "run-claude-paid",
        adapterType: "claude_local",
        model: "claude-sonnet-5-0",
        costUsd: 0.4,
        inputTokens: 3000,
        outputTokens: 700,
      },
      {
        runId: "run-codex-free",
        adapterType: "codex_local",
        model: "gpt-5.4-mini",
        costUsd: 0,
        freeTier: true,
        inputTokens: 800,
        outputTokens: 200,
      },
    ]);

    expect(summary).toEqual({
      totalRuns: 4,
      freeTierRuns: 2,
      paidRuns: 2,
      totalCostUsd: 0.525001,
      totalTokens: 8700,
      byAdapter: [
        {
          adapterType: "claude_local",
          runCount: 1,
          freeTierRuns: 0,
          totalCostUsd: 0.4,
          totalTokens: 3700,
        },
        {
          adapterType: "devin_local",
          runCount: 2,
          freeTierRuns: 1,
          totalCostUsd: 0.125001,
          totalTokens: 4000,
        },
        {
          adapterType: "codex_local",
          runCount: 1,
          freeTierRuns: 1,
          totalCostUsd: 0,
          totalTokens: 1000,
        },
      ],
    });
  });

  it("sorts adapters by rounded cost, run count, then adapter type deterministically", () => {
    const summary = aggregateMissionCostLedger([
      entry("run-gamma", "gamma_local", 0.3),
      entry("run-zeta-1", "zeta_local", 0.2),
      entry("run-alpha", "alpha_local", 0.3),
      entry("run-zeta-2", "zeta_local", 0.1),
      entry("run-beta", "beta_local", 0.4),
    ]);

    expect(summary.byAdapter.map((adapter) => adapter.adapterType)).toEqual([
      "beta_local",
      "zeta_local",
      "alpha_local",
      "gamma_local",
    ]);
    expect(summary.byAdapter[1]).toMatchObject({
      adapterType: "zeta_local",
      runCount: 2,
      totalCostUsd: 0.3,
    });
  });

  it("clamps negative cost and token values to zero", () => {
    const summary = aggregateMissionCostLedger([
      {
        runId: "run-negative",
        adapterType: "devin_local",
        model: "swe-2-flash-high",
        costUsd: -2.5,
        freeTier: true,
        inputTokens: -10,
        outputTokens: 25,
      },
      {
        runId: "run-positive",
        adapterType: "devin_local",
        model: "swe-2.1-max",
        costUsd: 0.123456789,
        inputTokens: 10,
        outputTokens: -5,
      },
    ]);

    expect(summary).toEqual({
      totalRuns: 2,
      freeTierRuns: 1,
      paidRuns: 1,
      totalCostUsd: 0.123457,
      totalTokens: 35,
      byAdapter: [
        {
          adapterType: "devin_local",
          runCount: 2,
          freeTierRuns: 1,
          totalCostUsd: 0.123457,
          totalTokens: 35,
        },
      ],
    });
  });
});
