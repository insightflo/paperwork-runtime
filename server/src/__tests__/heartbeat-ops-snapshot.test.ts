import { describe, expect, it } from "vitest";
import {
  buildConcurrencyOpsSnapshot,
  type ConcurrencyOpsSnapshotInput,
} from "../services/heartbeat-ops-snapshot.js";

const baseInput: ConcurrencyOpsSnapshotInput = {
  companyId: "company-1",
  capturedAtIso: "2026-01-02T03:04:05.000Z",
  totalSlots: 8,
  totalRunning: 6,
  totalQueued: 2,
  jainFairnessIndex: 0.82,
  sloBreachedLanes: [],
  deadlockCount: 0,
  coolingDownProviders: [],
};

describe("buildConcurrencyOpsSnapshot", () => {
  it("builds a healthy compact snapshot", () => {
    expect(buildConcurrencyOpsSnapshot(baseInput)).toEqual({
      companyId: "company-1",
      capturedAtIso: "2026-01-02T03:04:05.000Z",
      utilizationPercent: 75,
      totalSlots: 8,
      totalRunning: 6,
      totalQueued: 2,
      jainFairnessIndex: 0.82,
      sloBreachedLanes: [],
      deadlockCount: 0,
      coolingDownProviders: [],
      attentionRequired: false,
      summaryLine: "슬롯 6/8 (75%) · 대기 2건 · 정상",
    });
  });

  it("requires attention for deadlock, SLO breach, provider cooldown, and low fairness", () => {
    const patches: Partial<ConcurrencyOpsSnapshotInput>[] = [
      { deadlockCount: 1 },
      { sloBreachedLanes: ["lane-a"] },
      { coolingDownProviders: ["provider-a"] },
      { jainFairnessIndex: 0.49 },
    ];

    for (const patch of patches) {
      const snapshot = buildConcurrencyOpsSnapshot({ ...baseInput, ...patch });

      expect(snapshot.attentionRequired).toBe(true);
      expect(snapshot.summaryLine).toBe("슬롯 6/8 (75%) · 대기 2건 · 점검 필요");
    }
  });

  it("deduplicates and sorts lanes and providers", () => {
    const snapshot = buildConcurrencyOpsSnapshot({
      ...baseInput,
      sloBreachedLanes: ["zeta", "alpha", "zeta", "beta"],
      coolingDownProviders: ["openai", "anthropic", "openai"],
    });

    expect(snapshot.sloBreachedLanes).toEqual(["alpha", "beta", "zeta"]);
    expect(snapshot.coolingDownProviders).toEqual(["anthropic", "openai"]);
  });

  it("clamps negative counts and reports zero utilization with zero slots", () => {
    const snapshot = buildConcurrencyOpsSnapshot({
      ...baseInput,
      totalSlots: -8,
      totalRunning: -6,
      totalQueued: -2,
      deadlockCount: -1,
      jainFairnessIndex: 1.4,
    });

    expect(snapshot.totalSlots).toBe(0);
    expect(snapshot.totalRunning).toBe(0);
    expect(snapshot.totalQueued).toBe(0);
    expect(snapshot.deadlockCount).toBe(0);
    expect(snapshot.jainFairnessIndex).toBe(1);
    expect(snapshot.utilizationPercent).toBe(0);
    expect(snapshot.attentionRequired).toBe(false);
    expect(snapshot.summaryLine).toBe("슬롯 0/0 (0%) · 대기 0건 · 정상");
  });

  it("caps utilization at 100 percent", () => {
    const snapshot = buildConcurrencyOpsSnapshot({
      ...baseInput,
      totalSlots: 8,
      totalRunning: 10,
    });

    expect(snapshot.utilizationPercent).toBe(100);
    expect(snapshot.summaryLine).toContain("슬롯 10/8 (100%)");
  });
});
