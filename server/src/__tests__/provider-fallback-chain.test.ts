import { describe, expect, it } from "vitest";
import {
  selectHealthyFallbackCandidate,
  type FallbackCandidate,
  type ProviderHealthState,
} from "../services/provider-fallback-chain.js";

const chain: readonly FallbackCandidate[] = [
  { adapterType: "claude_local", model: "claude-opus-4", provider: "anthropic" },
  { adapterType: "codex_local", model: "gpt-5.2", provider: "openai" },
  { adapterType: "gemini_local", model: "gemini-3-pro", provider: "google" },
];

describe("selectHealthyFallbackCandidate", () => {
  it("selects the primary candidate when it is healthy", () => {
    const result = selectHealthyFallbackCandidate(chain, [
      { provider: "anthropic" },
      { provider: "openai" },
    ]);

    expect(result.selected).toEqual(chain[0]);
    expect(result.usedFallback).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it("falls back to the second candidate when the primary is cooling down", () => {
    const result = selectHealthyFallbackCandidate(chain, [
      { provider: "anthropic", coolingDown: true },
    ]);

    expect(result.selected).toEqual(chain[1]);
    expect(result.usedFallback).toBe(true);
    expect(result.skipped).toEqual([
      { candidate: chain[0], reason: "cooling_down" },
    ]);
  });

  it("skips authFatal and circuitOpen candidates with priority-ordered reasons", () => {
    const states: ProviderHealthState[] = [
      { provider: "anthropic", authFatal: true, coolingDown: true },
      { provider: "openai", circuitOpen: true },
    ];
    const result = selectHealthyFallbackCandidate(chain, states);

    expect(result.selected).toEqual(chain[2]);
    expect(result.usedFallback).toBe(true);
    expect(result.skipped).toEqual([
      { candidate: chain[0], reason: "auth_fatal" },
      { candidate: chain[1], reason: "circuit_open" },
    ]);
  });

  it("prefers auth_fatal over circuit_open and circuit_open over cooling_down per provider", () => {
    const result = selectHealthyFallbackCandidate(chain, [
      { provider: "anthropic", circuitOpen: true, coolingDown: true },
      { provider: "openai", authFatal: true, circuitOpen: true },
    ]);

    expect(result.skipped).toEqual([
      { candidate: chain[0], reason: "circuit_open" },
      { candidate: chain[1], reason: "auth_fatal" },
    ]);
    expect(result.selected).toEqual(chain[2]);
  });

  it("returns selected null with the full skipped audit list when all candidates are unhealthy", () => {
    const result = selectHealthyFallbackCandidate(chain, [
      { provider: "anthropic", coolingDown: true },
      { provider: "openai", authFatal: true },
      { provider: "google", circuitOpen: true },
    ]);

    expect(result.selected).toBeNull();
    expect(result.usedFallback).toBe(false);
    expect(result.skipped).toEqual([
      { candidate: chain[0], reason: "cooling_down" },
      { candidate: chain[1], reason: "auth_fatal" },
      { candidate: chain[2], reason: "circuit_open" },
    ]);
  });

  it("returns selected null for an empty chain", () => {
    const result = selectHealthyFallbackCandidate([], [
      { provider: "anthropic", authFatal: true },
    ]);

    expect(result.selected).toBeNull();
    expect(result.usedFallback).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it("treats candidates with no health state entry as healthy", () => {
    const result = selectHealthyFallbackCandidate(chain, []);

    expect(result.selected).toEqual(chain[0]);
    expect(result.usedFallback).toBe(false);
    expect(result.skipped).toEqual([]);
  });
});
