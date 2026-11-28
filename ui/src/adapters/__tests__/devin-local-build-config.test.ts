import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "../types";
import { buildDevinLocalConfig } from "../devin-local/build-config";

type DevinLocalCreateConfigValues = CreateConfigValues & {
  permissionMode?: unknown;
};

function baseValues(overrides: Partial<DevinLocalCreateConfigValues> = {}): DevinLocalCreateConfigValues {
  return {
    adapterType: "devin_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildDevinLocalConfig normalization", () => {
  it("defaults blank model and permission mode values", () => {
    const config = buildDevinLocalConfig(baseValues({
      model: " \t\n ",
      permissionMode: "   ",
    }));

    expect(config.model).toBe("swe-2-flash-medium");
    expect(config.permissionMode).toBe("dangerous");
  });

  it("preserves custom model, command, and cwd values", () => {
    const config = buildDevinLocalConfig(baseValues({
      model: "swe-2-1-max",
      command: "devin",
      cwd: "/tmp/devin-workspace",
    }));

    expect(config.model).toBe("swe-2-1-max");
    expect(config.command).toBe("devin");
    expect(config.cwd).toBe("/tmp/devin-workspace");
  });

  it("trims extra args and drops empty tokens", () => {
    const config = buildDevinLocalConfig(baseValues({
      extraArgs: " --verbose, ,, --json ,\t--watch  ",
    }));

    expect(config.extraArgs).toEqual(["--verbose", "--json", "--watch"]);
  });

  it("omits extra args when the input only contains whitespace and empty tokens", () => {
    const config = buildDevinLocalConfig(baseValues({
      extraArgs: " , ,\t,  ,",
    }));

    expect(config).not.toHaveProperty("extraArgs");
  });
});
