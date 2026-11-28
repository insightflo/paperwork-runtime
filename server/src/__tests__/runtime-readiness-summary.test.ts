import { describe, expect, it } from "vitest";
import {
  buildRuntimeReadinessSummary,
  type RuntimeReadinessInput,
} from "../services/runtime-readiness-summary.js";

function makeInput(overrides: Partial<RuntimeReadinessInput> = {}): RuntimeReadinessInput {
  return {
    companyId: "company-1",
    readyAdapters: ["claude"],
    totalSlots: 4,
    totalRunning: 1,
    totalQueued: 2,
    criticalAlertCount: 0,
    budgetExhaustedMissions: 0,
    ...overrides,
  };
}

describe("buildRuntimeReadinessSummary", () => {
  it("builds a ready summary when adapters, slots, alerts, and budgets are clear", () => {
    const summary = buildRuntimeReadinessSummary(makeInput());

    expect(summary).toMatchObject({
      companyId: "company-1",
      grade: "ready",
      readyAdapters: ["claude"],
      missingAdapters: [],
      totalSlots: 4,
      totalRunning: 1,
      totalQueued: 2,
      criticalAlertCount: 0,
      budgetExhaustedMissions: 0,
    });
    expect(summary.headline).toContain("준비 완료");
    expect(summary.headline).toContain("실행 1/4 슬롯");
    expect(summary.headline).toContain("대기 2개");
  });

  it("deduplicates and sorts ready and missing adapters", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({
      readyAdapters: ["zeta", "alpha", "zeta", "beta", "alpha"],
      missingAdapters: ["gamma", "adapter-b", "gamma", "adapter-a"],
    }));

    expect(summary.readyAdapters).toEqual(["alpha", "beta", "zeta"]);
    expect(summary.missingAdapters).toEqual(["adapter-a", "adapter-b", "gamma"]);
  });

  it("is degraded when any adapter is missing", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({ missingAdapters: ["codex"] }));

    expect(summary.grade).toBe("degraded");
    expect(summary.headline).toContain("저하");
    expect(summary.headline).toContain("미준비 1개");
  });

  it("is degraded when any mission has exhausted its budget", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({ budgetExhaustedMissions: 2 }));

    expect(summary.grade).toBe("degraded");
    expect(summary.budgetExhaustedMissions).toBe(2);
    expect(summary.headline).toContain("예산 소진 미션 2개");
  });

  it("is blocked when no adapters are ready", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({ readyAdapters: [] }));

    expect(summary.grade).toBe("blocked");
    expect(summary.headline).toContain("차단");
    expect(summary.headline).toContain("준비 어댑터 0개");
  });

  it("is blocked when fleet slot capacity is zero", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({ totalSlots: 0 }));

    expect(summary.grade).toBe("blocked");
    expect(summary.headline).toContain("실행 1/0 슬롯");
  });

  it("is blocked when critical alerts are active", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({ criticalAlertCount: 3 }));

    expect(summary.grade).toBe("blocked");
    expect(summary.headline).toContain("치명 알림 3개");
  });

  it("clamps negative counts to zero before grading", () => {
    const summary = buildRuntimeReadinessSummary(makeInput({
      totalSlots: -4,
      totalRunning: -1,
      totalQueued: -2,
      criticalAlertCount: -3,
      budgetExhaustedMissions: -5,
    }));

    expect(summary).toMatchObject({
      totalSlots: 0,
      totalRunning: 0,
      totalQueued: 0,
      criticalAlertCount: 0,
      budgetExhaustedMissions: 0,
    });
    expect(summary.grade).toBe("blocked");
  });

  it("treats omitted optional collections and mission counts as empty", () => {
    const input = makeInput();
    delete input.missingAdapters;
    delete input.budgetExhaustedMissions;

    const summary = buildRuntimeReadinessSummary(input);

    expect(summary.missingAdapters).toEqual([]);
    expect(summary.budgetExhaustedMissions).toBe(0);
    expect(summary.grade).toBe("ready");
  });
});
