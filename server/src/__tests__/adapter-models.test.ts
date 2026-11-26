import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetClaudeModelsCacheForTests } from "../adapters/claude-models.js";
import { setLocalCliModelsRunnerForTests } from "../adapters/local-cli-models.js";

// Snapshot the original values of every process.env key this file mutates
// (top-level, beforeEach, or inline within tests) so afterAll can restore
// the pristine env for subsequent test files in the same vitest worker.
const __ENV_RESTORE: Record<string, string | undefined> = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  PAPERCLIP_OPENCODE_COMMAND: process.env.PAPERCLIP_OPENCODE_COMMAND,
};

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetCodexModelsCacheForTests();
    resetClaudeModelsCacheForTests();
    setLocalCliModelsRunnerForTests(null);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(__ENV_RESTORE)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no CLI or OpenAI discovery is available", async () => {
    setLocalCliModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.6-sol")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.6-luna")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.4-mini")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads codex models from Codex CLI before OpenAI discovery", async () => {
    process.env.OPENAI_API_KEY = "***";
    const runner = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ models: [{ id: "gpt-5.5-codex" }, { id: "gpt-5.3-codex-spark" }] }),
      stderr: "",
      hasError: false,
    }));
    setLocalCliModelsRunnerForTests(runner);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-from-openai" }] }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5.5-codex")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("loads codex models dynamically from OpenAI when CLI discovery fails and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "***";
    setLocalCliModelsRunnerForTests(() => ({
      status: 1,
      stdout: "",
      stderr: "no codex catalog",
      hasError: false,
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("loads claude models from Claude CLI and merges fallback options", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ models: [{ id: "claude-sonnet-5-0" }, { id: "claude-opus-4-6" }] }),
      stderr: "",
      hasError: false,
    }));
    setLocalCliModelsRunnerForTests(runner);

    const first = await listAdapterModels("claude_local");
    const second = await listAdapterModels("claude_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "claude-sonnet-5-0")).toBe(true);
    expect(first.some((model) => model.id === "claude-opus-4-6")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });

  it("returns an empty list for the retired hermes_local adapter", async () => {
    const models = await listAdapterModels("hermes_local");
    expect(models).toEqual([]);
  });
});
