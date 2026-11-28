import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVIN_LOCAL_MODEL,
  DEVIN_LOCAL_MODELS,
  isDevinFreeTierModel,
  resolveDevinLocalModel,
} from "../adapters/devin-local/models.js";

describe("DEVIN_LOCAL_MODELS", () => {
  it("contains the default Devin local model", () => {
    expect(DEVIN_LOCAL_MODELS.some((model) => model.id === DEFAULT_DEVIN_LOCAL_MODEL)).toBe(true);
  });

  it("has unique non-empty id values", () => {
    const ids = DEVIN_LOCAL_MODELS.map((model) => model.id);

    expect(ids.every((id) => id.trim().length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique non-empty label values", () => {
    const labels = DEVIN_LOCAL_MODELS.map((model) => model.label);

    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("isDevinFreeTierModel", () => {
  it.each(["swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"])(
    "matches %s as a free-tier model",
    (model) => {
      expect(isDevinFreeTierModel(model)).toBe(true);
    },
  );

  it.each(["  swe-2-flash-medium  ", "SWE-2-FLASH-HIGH", "\tSwe-2-Flash-Max\n"])(
    "matches whitespace and case variant %s",
    (model) => {
      expect(isDevinFreeTierModel(model)).toBe(true);
    },
  );

  it.each(["swe-2-1-max", "", null, undefined])(
    "rejects non-free-tier or empty input %s",
    (model) => {
      expect(isDevinFreeTierModel(model)).toBe(false);
    },
  );
});

describe("resolveDevinLocalModel", () => {
  it("trims a valid model value", () => {
    expect(resolveDevinLocalModel("  swe-2-1-high  ")).toBe("swe-2-1-high");
  });

  it.each(["", "   ", "\t\n", null, undefined])(
    "falls back to the default model for blank input %s",
    (model) => {
      expect(resolveDevinLocalModel(model)).toBe(DEFAULT_DEVIN_LOCAL_MODEL);
    },
  );
});
