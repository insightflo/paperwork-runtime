import { describe, expect, it } from "vitest";
import { isAdapterTypeEnabled } from "../agent-config-adapter-types";
import { adapterLabels } from "../agent-config-primitives";

describe("devin_local adapter wiring", () => {
  it("enables the devin_local adapter type", () => {
    expect(isAdapterTypeEnabled("devin_local")).toBe(true);
  });

  it("labels devin_local as Devin (local)", () => {
    expect(adapterLabels.devin_local).toBe("Devin (local)");
  });
});
