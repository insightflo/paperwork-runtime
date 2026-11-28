// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { AdapterConfigFieldsProps, CreateConfigValues } from "../types";
import { getUIAdapter } from "../registry";
import { devinLocalUIAdapter } from "../devin-local";
import { buildDevinLocalConfig } from "../devin-local/build-config";
import { DevinLocalConfigFields } from "../devin-local/config-fields";
import { parseDevinStdoutLine } from "../devin-local/parse-stdout";

const ts = "2026-11-28T12:00:00.000Z";

function baseValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
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

function passthroughEff<T>(_group: "adapterConfig", _field: string, original: T): T {
  return original;
}

function createConfigFieldsProps(): AdapterConfigFieldsProps {
  return {
    mode: "create",
    isCreate: true,
    adapterType: "devin_local",
    values: baseValues(),
    set: () => {},
    config: {},
    eff: passthroughEff,
    mark: () => {},
    models: [],
  };
}

describe("devinLocalUIAdapter", () => {
  it("is registered as the devin_local UI adapter", () => {
    const adapter = getUIAdapter("devin_local");

    expect(adapter).toBe(devinLocalUIAdapter);
    expect(adapter.type).toBe("devin_local");
    expect(adapter.label).toBe("Devin (local)");
  });
});

describe("DevinLocalConfigFields", () => {
  it("shows Korean headless and free-tier guidance while keeping config building backward-compatible", () => {
    const markup = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(DevinLocalConfigFields, createConfigFieldsProps())),
    );

    expect(markup).toContain("Devin model hints");
    expect(markup).toContain('aria-label="Devin permission mode"');
    expect(markup).toContain("--respect-workspace-trust false");
    expect(markup).toContain("--process-model in-process");
    expect(markup).toContain("자동 적용됩니다");
    expect(markup).toContain("swe-2-flash-*");
    expect(markup).toContain("262K Free tier");
    expect(markup).toContain("swe-2-flash-medium/high");
    expect(markup).toContain("swe-2-flash-medium");
    expect(markup).toContain("swe-2-flash-high");

    const config = buildDevinLocalConfig(baseValues({
      instructionsFilePath: "/workspace/AGENTS.md",
      extraArgs: "--verbosity, 2",
    }));

    expect(config).toMatchObject({
      model: "swe-2-flash-medium",
      permissionMode: "dangerous",
      instructionsFilePath: "/workspace/AGENTS.md",
      timeoutSec: 0,
      graceSec: 20,
    });
    expect(config.extraArgs).toEqual(["--verbosity", "2"]);
  });
});

describe("buildDevinLocalConfig", () => {
  it("defaults the model and permission mode for non-interactive automation", () => {
    const config = buildDevinLocalConfig(baseValues());

    expect(config.model).toBe("swe-2-flash-medium");
    expect(config.permissionMode).toBe("dangerous");
    expect(config.timeoutSec).toBe(0);
    expect(config.graceSec).toBe(20);
  });

  it("preserves explicit model, cwd, and command values", () => {
    const config = buildDevinLocalConfig(baseValues({
      model: "swe-2-1-max",
      cwd: "/tmp/devin-workspace",
      command: "devin",
    }));

    expect(config.model).toBe("swe-2-1-max");
    expect(config.cwd).toBe("/tmp/devin-workspace");
    expect(config.command).toBe("devin");
  });

  it("preserves a selected permission mode and parses comma-separated extra args", () => {
    const values = {
      ...baseValues({ extraArgs: "--verbosity, 2" }),
      permissionMode: "smart",
    } as CreateConfigValues & { permissionMode: string };

    const config = buildDevinLocalConfig(values);

    expect(config.permissionMode).toBe("smart");
    expect(config.extraArgs).toEqual(["--verbosity", "2"]);
  });
});

describe("parseDevinStdoutLine", () => {
  it("returns plain Devin print output as a clean stdout transcript entry", () => {
    expect(parseDevinStdoutLine("Implemented the requested change.", ts)).toEqual([
      { kind: "stdout", ts, text: "Implemented the requested change." },
    ]);
  });

  it("returns no entries for blank output", () => {
    expect(parseDevinStdoutLine("   ", ts)).toEqual([]);
  });

  it("parses structured assistant deltas when a wrapper emits NDJSON", () => {
    const line = JSON.stringify({ type: "text_delta", delta: "working" });

    expect(parseDevinStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "working", delta: true },
    ]);
  });

  it("parses structured result frames when a wrapper emits NDJSON", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      text: "done",
      usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 2 },
    });

    expect(parseDevinStdoutLine(line, ts)).toEqual([
      {
        kind: "result",
        ts,
        text: "done",
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 2,
        costUsd: 0,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });
});
