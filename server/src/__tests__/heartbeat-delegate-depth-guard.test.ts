import { describe, expect, it } from "vitest";
import { evaluateDelegationGuard, type DelegationGuardInput } from "../services/heartbeat-delegate-depth-guard.js";

const baseInput: DelegationGuardInput = {
  parentAgentId: "parent",
  targetAgentId: "child",
  currentDepth: 0,
  activeChildrenCount: 0,
};

describe("evaluateDelegationGuard", () => {
  it("allows delegation within the default depth and fan-out limits", () => {
    expect(evaluateDelegationGuard(baseInput)).toEqual({ allowed: true });
  });

  it("rejects direct self-delegation as a cycle", () => {
    const result = evaluateDelegationGuard({ ...baseInput, targetAgentId: "parent" });

    expect(result).toMatchObject({ allowed: false, reason: "cycle_detected" });
  });

  it("rejects a target that appears in the multi-hop ancestor chain", () => {
    const result = evaluateDelegationGuard({
      ...baseInput,
      targetAgentId: "grandparent",
      ancestorAgentIds: ["root", "grandparent"],
    });

    expect(result).toMatchObject({ allowed: false, reason: "cycle_detected" });
  });

  it("allows the depth boundary just below the default maximum and rejects at it", () => {
    expect(evaluateDelegationGuard({ ...baseInput, currentDepth: 2 })).toEqual({ allowed: true });
    expect(evaluateDelegationGuard({ ...baseInput, currentDepth: 3 })).toMatchObject({
      allowed: false,
      reason: "max_depth_exceeded",
    });
  });

  it("allows the active-children boundary just below the default maximum and rejects at it", () => {
    expect(evaluateDelegationGuard({ ...baseInput, activeChildrenCount: 3 })).toEqual({ allowed: true });
    expect(evaluateDelegationGuard({ ...baseInput, activeChildrenCount: 4 })).toMatchObject({
      allowed: false,
      reason: "max_active_children_exceeded",
    });
  });

  it("honors custom depth and active-children limits", () => {
    expect(evaluateDelegationGuard({ ...baseInput, currentDepth: 1, maxDepth: 2 }))
      .toEqual({ allowed: true });
    expect(evaluateDelegationGuard({ ...baseInput, currentDepth: 2, maxDepth: 2 })).toMatchObject({
      allowed: false,
      reason: "max_depth_exceeded",
    });
    expect(evaluateDelegationGuard({ ...baseInput, activeChildrenCount: 1, maxActiveChildren: 2 }))
      .toEqual({ allowed: true });
    expect(evaluateDelegationGuard({ ...baseInput, activeChildrenCount: 2, maxActiveChildren: 2 }))
      .toMatchObject({
        allowed: false,
        reason: "max_active_children_exceeded",
      });
  });

  it("reports cycles before numeric limit failures", () => {
    const result = evaluateDelegationGuard({
      ...baseInput,
      targetAgentId: "parent",
      currentDepth: 99,
      activeChildrenCount: 99,
    });

    expect(result).toMatchObject({ allowed: false, reason: "cycle_detected" });
  });
});
