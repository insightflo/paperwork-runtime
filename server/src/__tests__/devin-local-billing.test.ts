import { describe, expect, it } from "vitest";
import { resolveDevinLocalBilling } from "../adapters/devin-local/execute.js";

describe("resolveDevinLocalBilling", () => {
  it.each(["swe-2-flash-medium", "swe-2-flash-high", "SWE-2-FLASH-MAX"])(
    "records %s as zero-cost subscription billing",
    (model) => {
      expect(resolveDevinLocalBilling(model)).toEqual({ billingType: "subscription", costUsd: 0 });
    },
  );

  it.each(["swe-2-1-max", "", "custom-model"])(
    "keeps %s as unknown billing without a fabricated cost",
    (model) => {
      expect(resolveDevinLocalBilling(model)).toEqual({ billingType: "unknown", costUsd: null });
    },
  );

  it("trims surrounding whitespace before matching free-tier models", () => {
    expect(resolveDevinLocalBilling("  swe-2-flash-medium  ")).toEqual({
      billingType: "subscription",
      costUsd: 0,
    });
  });
});
