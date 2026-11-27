import { describe, expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import {
  DEFAULT_PROVIDER_FAILURE_HOLD_MS,
  DEFAULT_QUOTA_FALLBACK_HOLD_MS,
  DEFAULT_QUOTA_RESET_GRACE_MS,
  createUsageLimitGate,
  globalUsageLimitGate,
} from "../services/usage-limit-gate.js";
import {
  applyAdapterFallbackRuntimeConfig,
  resolveAdapterFallbackAdapterType,
  resolveAdapterFallbackConfig,
  selectNextAdapterFallbackEntry,
} from "../services/heartbeat-adapter-fallback.js";

const key = (overrides: Record<string, unknown> = {}) => ({ adapterType: "claude_local", provider: "openai", model: "gpt-5.4-mini", ...overrides });
const runRow = (retryOfRunId: string | null) => ({ retryOfRunId }) as unknown as typeof heartbeatRuns.$inferSelect;
const READY = { blocked: false, kind: "ready", resetsAtMs: null };

describe("usage limit gate", () => {
  it("holds a quota limit until resetsAtMs + grace when the reset is in the future", () => {
    const gate = createUsageLimitGate();
    gate.recordQuotaLimit(key(), { resetsAtMs: 61_000, nowMs: 1_000 });
    expect(gate.isBlocked(key(), 1_000)).toMatchObject({ blocked: true, kind: "limit", resetsAtMs: 61_000 + DEFAULT_QUOTA_RESET_GRACE_MS });
    expect(gate.isBlocked(key(), 61_000 + DEFAULT_QUOTA_RESET_GRACE_MS - 1).blocked).toBe(true);
    expect(gate.isBlocked(key(), 61_000 + DEFAULT_QUOTA_RESET_GRACE_MS)).toEqual(READY);
  });

  it("falls back to the default quota hold when resetsAtMs is missing or not in the future", () => {
    const gate = createUsageLimitGate();
    gate.recordQuotaLimit(key(), { nowMs: 5_000 });
    expect(gate.isBlocked(key(), 5_000).resetsAtMs).toBe(5_000 + DEFAULT_QUOTA_FALLBACK_HOLD_MS);
    gate.clear();
    gate.recordQuotaLimit(key(), { resetsAtMs: 4_000, nowMs: 5_000 });
    expect(gate.isBlocked(key(), 5_000).resetsAtMs).toBe(5_000 + DEFAULT_QUOTA_FALLBACK_HOLD_MS);
  });

  it("never shortens an existing later hold when a new quota limit arrives", () => {
    const gate = createUsageLimitGate();
    gate.recordQuotaLimit(key(), { resetsAtMs: 10_061_000, nowMs: 1_000 });
    gate.recordQuotaLimit(key(), { nowMs: 2_000 });
    expect(gate.isBlocked(key(), 2_000)).toMatchObject({ blocked: true, kind: "limit", resetsAtMs: 10_061_000 + DEFAULT_QUOTA_RESET_GRACE_MS });
  });

  it("blocks provider failures for the cooldown with kind failed", () => {
    const gate = createUsageLimitGate();
    gate.recordProviderFailure(key(), { nowMs: 1_000 });
    expect(gate.isBlocked(key(), 1_000)).toMatchObject({ blocked: true, kind: "failed", resetsAtMs: 1_000 + DEFAULT_PROVIDER_FAILURE_HOLD_MS });
    gate.recordProviderFailure(key(), { nowMs: 2_000, cooldownMs: 5_000, reason: "spawn failed" });
    expect(gate.isBlocked(key(), 2_000)).toMatchObject({ blocked: true, kind: "failed", resetsAtMs: 7_000, reason: "spawn failed" });
    expect(gate.isBlocked(key(), 7_000)).toEqual(READY);
  });

  it("refreshes provider failure holds with the newest cooldown observation", () => {
    const gate = createUsageLimitGate();
    gate.recordProviderFailure(key(), { nowMs: 1_000, cooldownMs: 60_000 });
    gate.recordProviderFailure(key(), { nowMs: 2_000, cooldownMs: 1_000, reason: "spawn failed" });
    expect(gate.isBlocked(key(), 2_000)).toMatchObject({ blocked: true, kind: "failed", resetsAtMs: 3_000, reason: "spawn failed" });
    expect(gate.isBlocked(key(), 3_000)).toEqual(READY);
  });

  it("recordSuccess clears both limit and failure entries for the key", () => {
    const gate = createUsageLimitGate();
    gate.recordQuotaLimit(key(), { resetsAtMs: 61_000, nowMs: 1_000 });
    gate.recordSuccess(key());
    expect(gate.isBlocked(key(), 1_000).blocked).toBe(false);
    gate.recordProviderFailure(key(), { nowMs: 1_000 });
    gate.recordSuccess(key());
    expect(gate.isBlocked(key(), 1_000)).toEqual(READY);
    expect(gate.getSnapshot(1_000)).toEqual({ limitedModels: [], failedModels: [] });
  });

  it("snapshots active limited and failed entries separately and prunes expired ones", () => {
    const gate = createUsageLimitGate();
    gate.recordQuotaLimit(key(), { resetsAtMs: 61_000, nowMs: 1_000, reason: "quota exhausted" });
    gate.recordProviderFailure(key({ provider: "anthropic", model: "claude-fallback" }), { nowMs: 1_000, cooldownMs: 5_000 });
    const snapshot = gate.getSnapshot(1_000);
    expect(snapshot.limitedModels).toEqual([{ adapterType: "claude_local", provider: "openai", model: "gpt-5.4-mini", kind: "limit", resetsAtMs: 91_000, reason: "quota exhausted" }]);
    expect(snapshot.failedModels).toEqual([{ adapterType: "claude_local", provider: "anthropic", model: "claude-fallback", kind: "failed", resetsAtMs: 6_000, reason: null }]);
    const later = gate.getSnapshot(6_000);
    expect(later.failedModels).toEqual([]);
    expect(later.limitedModels).toHaveLength(1);
  });

  it("normalizes keys so equivalent adapter/provider/model tuples share one entry", () => {
    const gate = createUsageLimitGate();
    gate.recordQuotaLimit(key({ adapterType: " claude_local ", provider: "" }), { resetsAtMs: 61_000, nowMs: 1_000 });
    expect(gate.isBlocked(key({ provider: null }), 1_000).blocked).toBe(true);
    gate.recordSuccess(key({ adapterType: "claude_local", provider: undefined, model: "gpt-5.4-mini" }));
    expect(gate.getSnapshot(1_000)).toEqual({ limitedModels: [], failedModels: [] });
  });
  it("clear() resets all state and the global singleton exposes the gate API", () => {
    const gate = createUsageLimitGate();
    gate.recordProviderFailure(key(), { nowMs: 1_000 });
    gate.clear();
    expect(gate.getSnapshot(1_000)).toEqual({ limitedModels: [], failedModels: [] });
    for (const method of ["recordQuotaLimit", "recordProviderFailure", "recordSuccess", "isBlocked", "getSnapshot", "clear"] as const) {
      expect(typeof globalUsageLimitGate[method]).toBe("function");
    }
  });
});
describe("resolveAdapterFallbackConfig", () => {
  it("keeps the legacy single-command config behavior", () => {
    const config = resolveAdapterFallbackConfig({
      command: "main",
      fallbackCommand: "fallback-agent",
      fallback: { provider: "anthropic", model: "claude-fallback", maxAttempts: 2, triggers: ["exit_error"], thinking: "high", thinkingLadder: ["medium", "high"] },
    });
    expect(config).toMatchObject({ command: "fallback-agent", provider: "anthropic", model: "claude-fallback", maxAttempts: 2, automatic: true, returnToPrimaryOnReset: true, order: [] });
    expect(config!.triggers.has("exit_error")).toBe(true);
    expect(config!.triggers.has("process_lost")).toBe(false);
  });

  it("returns null without any fallback route", () => {
    expect(resolveAdapterFallbackConfig(null)).toBeNull();
    expect(resolveAdapterFallbackConfig({})).toBeNull();
    expect(resolveAdapterFallbackConfig({ command: "main", fallback: {} })).toBeNull();
  });

  it("validates and deduplicates the ordered chain with order-derived defaults", () => {
    const config = resolveAdapterFallbackConfig({
      command: "main",
      fallback: {
        order: [
          { provider: "openai", model: "gpt-5.4-mini" },
          { adapterType: "codex_local", command: "codex", model: "gpt-5.6-luna" },
          { provider: "openai", model: "gpt-5.4-mini" },
          {},
          { thinking: "high" },
          { command: "third-agent" },
          { command: "fourth" }, { command: "fifth" }, { command: "sixth" },
          { command: "seventh" }, { command: "eighth" }, { command: "ninth" },
        ],
      },
    });
    expect(config!.order).toEqual([
      { provider: "openai", model: "gpt-5.4-mini" },
      { adapterType: "codex_local", command: "codex", model: "gpt-5.6-luna" },
      { command: "third-agent" },
      { command: "fourth" }, { command: "fifth" }, { command: "sixth" }, { command: "seventh" }, { command: "eighth" },
    ]);
    expect(config!.maxAttempts).toBe(8);
    for (const trigger of ["process_lost", "provider_quota_exhausted", "provider_overloaded", "rate_limit", "adapter_failed"]) expect(config!.triggers.has(trigger)).toBe(true);
  });

  it("honors automatic/returnToPrimaryOnReset opt-outs and explicit overrides", () => {
    const config = resolveAdapterFallbackConfig({ fallback: { command: "fb", automatic: false, returnToPrimaryOnReset: false, maxAttempts: 5 } });
    expect(config).toMatchObject({ command: "fb", automatic: false, returnToPrimaryOnReset: false, maxAttempts: 5 });
  });

  it("supports a same-adapter model/provider-only fallback without any command", () => {
    const config = resolveAdapterFallbackConfig({ command: "main", fallback: { provider: "openai", model: "gpt-5.4-mini" } });
    expect(config).toMatchObject({ command: "", provider: "openai", model: "gpt-5.4-mini", maxAttempts: 1, order: [] });
  });

  it("populates the legacy command from the first ordered entry when no legacy command exists", () => {
    const config = resolveAdapterFallbackConfig({ command: "main", fallback: { order: [{ command: "codex", model: "gpt-5.6-luna" }, { provider: "openai" }] } });
    expect(config!.command).toBe("codex");
  });
});
describe("selectNextAdapterFallbackEntry", () => {
  const chainConfig = resolveAdapterFallbackConfig({
    command: "main",
    fallback: {
      order: [
        { provider: "openai", model: "gpt-5.4-mini" },
        { adapterType: "codex_local", command: "codex", model: "gpt-5.6-luna" },
        { command: "third-agent", thinking: "high" },
      ],
    },
  })!;

  it("walks the ordered chain hop by hop and resolves adapter type/command per entry", () => {
    const first = selectNextAdapterFallbackEntry({ fallback: chainConfig, currentAttempt: 0, defaultAdapterType: "claude_local", defaultCommand: "main" });
    expect(first).toMatchObject({ candidateIndex: 0, resolvedCommand: "main", resolvedAdapterType: "claude_local" });
    expect(first!.entry).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
    const second = selectNextAdapterFallbackEntry({ fallback: chainConfig, currentAttempt: 1, defaultAdapterType: "claude_local" });
    expect(second).toMatchObject({ candidateIndex: 1, resolvedCommand: "codex", resolvedAdapterType: "codex_local" });
    const third = selectNextAdapterFallbackEntry({ fallback: chainConfig, currentAttempt: 2, defaultAdapterType: "claude_local" });
    expect(third).toMatchObject({ candidateIndex: 2, resolvedCommand: "third-agent", resolvedAdapterType: "claude_local" });
    expect(third!.entry.thinking).toBe("high");
    expect(selectNextAdapterFallbackEntry({ fallback: chainConfig, currentAttempt: 3, defaultAdapterType: "claude_local" })).toBeNull();
  });

  it("skips blocked candidates and returns the first unblocked entry", () => {
    const result = selectNextAdapterFallbackEntry({
      fallback: chainConfig,
      currentAttempt: 0,
      defaultAdapterType: "claude_local",
      isCandidateBlocked: (candidate) => candidate.provider === "openai" || candidate.adapterType === "codex_local",
    });
    expect(result).toMatchObject({ candidateIndex: 2, resolvedCommand: "third-agent" });
    expect(selectNextAdapterFallbackEntry({ fallback: chainConfig, currentAttempt: 0, defaultAdapterType: "claude_local", isCandidateBlocked: () => true })).toBeNull();
  });
  it("returns the legacy single entry within maxAttempts and null beyond or when blocked", () => {
    const legacy = resolveAdapterFallbackConfig({ fallback: { command: "fb", provider: "anthropic", model: "claude-fallback", maxAttempts: 2 } })!;
    const first = selectNextAdapterFallbackEntry({ fallback: legacy, currentAttempt: 0, defaultAdapterType: "claude_local", defaultCommand: "main" });
    expect(first).toMatchObject({ candidateIndex: 0, resolvedCommand: "fb", resolvedAdapterType: "claude_local" });
    expect(first!.entry).toEqual({ command: "fb", provider: "anthropic", model: "claude-fallback" });
    expect(selectNextAdapterFallbackEntry({ fallback: legacy, currentAttempt: 2, defaultAdapterType: "claude_local" })).toBeNull();
    expect(selectNextAdapterFallbackEntry({ fallback: legacy, currentAttempt: 1, defaultAdapterType: "claude_local", isCandidateBlocked: () => true })).toBeNull();
  });

  it("returns null when automatic switching is disabled", () => {
    const manual = resolveAdapterFallbackConfig({ fallback: { command: "fb", automatic: false } })!;
    expect(selectNextAdapterFallbackEntry({ fallback: manual, currentAttempt: 0, defaultAdapterType: "claude_local" })).toBeNull();
    const manualChain = resolveAdapterFallbackConfig({ fallback: { order: [{ command: "codex" }], automatic: false } })!;
    expect(selectNextAdapterFallbackEntry({ fallback: manualChain, currentAttempt: 0, defaultAdapterType: "claude_local" })).toBeNull();
  });
});
describe("adapter fallback runtime application", () => {
  const context = (overrides: Record<string, unknown>) => ({ wakeReason: "adapter_fallback", fallbackOfRunId: "run-1", ...overrides });

  it("applies provider/model/adapterType overrides on a fallback run even without fallbackCommand", () => {
    const config = applyAdapterFallbackRuntimeConfig({
      run: runRow("run-1"),
      context: context({ fallbackProvider: "openai", fallbackModel: "gpt-5.4-mini", fallbackAdapterType: "codex_local" }),
      config: { command: "main", provider: "anthropic", model: "primary-model" },
    });
    expect(config).toEqual({ command: "main", provider: "openai", model: "gpt-5.4-mini", adapterType: "codex_local" });
  });

  it("keeps the legacy command+thinking override behavior when fallbackCommand exists", () => {
    const config = applyAdapterFallbackRuntimeConfig({ run: runRow("run-1"), context: context({ fallbackCommand: "fb-agent", fallbackThinking: "high" }), config: { command: "main" } });
    expect(config).toEqual({ command: "fb-agent", thinking: "high" });
  });

  it("leaves non-fallback runs untouched", () => {
    const original = { command: "main" };
    expect(applyAdapterFallbackRuntimeConfig({ run: runRow(null), context: context({ fallbackCommand: "fb" }), config: original })).toBe(original);
  });

  it("resolves the fallback adapter type only for valid adapter_fallback retry runs", () => {
    expect(resolveAdapterFallbackAdapterType({ run: runRow("run-1"), context: context({ fallbackAdapterType: "codex_local" }), defaultAdapterType: "claude_local" })).toBe("codex_local");
    expect(resolveAdapterFallbackAdapterType({ run: runRow("run-1"), context: context({}), defaultAdapterType: "claude_local" })).toBe("claude_local");
    expect(resolveAdapterFallbackAdapterType({ run: runRow(null), context: context({ fallbackAdapterType: "codex_local" }), defaultAdapterType: "claude_local" })).toBe("claude_local");
  });
});
