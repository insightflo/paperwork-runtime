import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { models as antigravityFallbackModels } from "@paperclipai/adapter-antigravity-local";
import { listAdapterModels } from "../adapters/index.js";
import {
  parseAntigravityModelsOutput,
  resetAntigravityModelsCacheForTests,
  setAntigravityModelsRunnerForTests,
} from "../adapters/antigravity-models.js";

const ORIGINAL_ANTIGRAVITY_COMMAND = process.env.PAPERCLIP_ANTIGRAVITY_COMMAND;

describe("antigravity_local model listing", () => {
  beforeEach(() => {
    delete process.env.PAPERCLIP_ANTIGRAVITY_COMMAND;
    resetAntigravityModelsCacheForTests();
    setAntigravityModelsRunnerForTests(null);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_ANTIGRAVITY_COMMAND === undefined) {
      delete process.env.PAPERCLIP_ANTIGRAVITY_COMMAND;
    } else {
      process.env.PAPERCLIP_ANTIGRAVITY_COMMAND = ORIGINAL_ANTIGRAVITY_COMMAND;
    }
    resetAntigravityModelsCacheForTests();
    setAntigravityModelsRunnerForTests(null);
  });

  it("falls back to auto when agy CLI discovery is unavailable", async () => {
    setAntigravityModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "spawn agy ENOENT",
      hasError: true,
    }));

    const models = await listAdapterModels("antigravity_local");
    expect(models).toEqual(antigravityFallbackModels);
  });

  it("loads tab-separated agy models with labels, keeps auto first, ignores stderr spinner text, and caches", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: [
        "gemini-4-argon-high\tGemini 4 Argon (High)",
        "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
        "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
      ].join("\n"),
      stderr: "Fetching available models...\n",
      hasError: false,
    }));
    setAntigravityModelsRunnerForTests(runner);

    const first = await listAdapterModels("antigravity_local");
    const second = await listAdapterModels("antigravity_local");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("agy", ["models"]);
    expect(first).toEqual(second);
    expect(first[0]).toEqual({ id: "auto", label: "Auto (Antigravity settings)" });
    expect(first).toContainEqual({ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" });
    expect(first).toContainEqual({
      id: "gemini-4-hydrogen-xhigh",
      label: "Gemini 4 Hydrogen (XHigh)",
    });
    expect(first).toContainEqual({ id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" });
    expect(first.some((m) => m.id.toLowerCase().includes("fetching"))).toBe(false);
  });

  it("strips ANSI/carriage-return spinner prefixes and honors PAPERCLIP_ANTIGRAVITY_COMMAND", async () => {
    process.env.PAPERCLIP_ANTIGRAVITY_COMMAND = "/custom/bin/agy";
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "\r\u001b[2K⠋ Fetching...\rgemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n",
      stderr: "",
      hasError: false,
    }));
    setAntigravityModelsRunnerForTests(runner);

    const models = await listAdapterModels("antigravity_local");

    expect(runner).toHaveBeenCalledWith("/custom/bin/agy", ["models"]);
    expect(models).toContainEqual({ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" });
  });

  it("returns stale cached models when a subsequent CLI refresh fails after TTL expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    let calls = 0;
    setAntigravityModelsRunnerForTests(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 0,
          stdout: "gemini-4-argon-medium\tGemini 4 Argon (Medium)\n",
          stderr: "",
          hasError: false,
        };
      }
      return { status: 1, stdout: "", stderr: "temporary network error", hasError: false };
    });

    try {
      const first = await listAdapterModels("antigravity_local");
      vi.advanceTimersByTime(61_000);
      const second = await listAdapterModels("antigravity_local");

      expect(calls).toBe(2);
      expect(second).toEqual(first);
      expect(second).toContainEqual({ id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" });
    } finally {
      vi.useRealTimers();
    }

    const parsed = parseAntigravityModelsOutput(
      '{"models":[{"id":"gemini-4-hydrogen-high","label":"Gemini 4 Hydrogen (High)"}]}',
    );
    expect(parsed).toEqual([{ id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" }]);
  });
});
