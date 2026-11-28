import { describe, expect, it } from "vitest";
import { getServerAdapter, listServerAdapters } from "../adapters/registry.js";
import { devinLocalAdapter } from "../adapters/devin-local/index.js";
import { execute } from "../adapters/devin-local/execute.js";
import { testEnvironment } from "../adapters/devin-local/test.js";
import { devinLocalSessionCodec } from "../adapters/devin-local/parse.js";
import { DEVIN_LOCAL_MODELS, listDevinLocalModels } from "../adapters/devin-local/models.js";

describe("devin_local server adapter registry contract", () => {
  it("returns the registered devin_local adapter from getServerAdapter", () => {
    const adapter = getServerAdapter("devin_local");

    expect(adapter).toBe(devinLocalAdapter);
    expect(adapter.type).toBe("devin_local");
  });

  it("wires the adapter contract exports and metadata", () => {
    expect(devinLocalAdapter.execute).toBe(execute);
    expect(devinLocalAdapter.testEnvironment).toBe(testEnvironment);
    expect(devinLocalAdapter.sessionCodec).toBe(devinLocalSessionCodec);
    expect(devinLocalAdapter.models).toBe(DEVIN_LOCAL_MODELS);
    expect(devinLocalAdapter.listModels).toBe(listDevinLocalModels);
    expect(devinLocalAdapter.supportsLocalAgentJwt).toBe(true);
    expect(devinLocalAdapter.agentConfigurationDoc).toContain("Adapter: devin_local");
  });

  it("lists devin_local among server adapters with non-empty static models", () => {
    const adapters = listServerAdapters();

    expect(adapters).toContain(devinLocalAdapter);
    expect(adapters.map((adapter) => adapter.type)).toContain("devin_local");
    expect(DEVIN_LOCAL_MODELS.length).toBeGreaterThan(0);
    expect(DEVIN_LOCAL_MODELS.every((model) => model.id.length > 0 && model.label.length > 0)).toBe(true);
  });
});
