import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  computeProviderBackoffMs,
  shouldTripProviderCircuit,
} from "../services/heartbeat-provider-backoff.js";

describe("classifyProviderFailure", () => {
  it("classifies rate-limit failures from status codes and provider text", () => {
    expect(classifyProviderFailure({ errorMessage: "HTTP 429 from provider" })).toBe("rate_limit");
    expect(classifyProviderFailure({ errorMessage: "Rate limit exceeded for requests" })).toBe("rate_limit");
    expect(classifyProviderFailure({ stderr: "Too Many Requests" })).toBe("rate_limit");
    expect(classifyProviderFailure({ stderr: "quota exceeded for current model" })).toBe("rate_limit");
  });

  it("classifies overloaded failures from status codes and provider text", () => {
    expect(classifyProviderFailure({ errorMessage: "HTTP 503 Service Unavailable" })).toBe("overloaded");
    expect(classifyProviderFailure({ stderr: "provider returned 529" })).toBe("overloaded");
    expect(classifyProviderFailure({ errorMessage: "model is currently overloaded" })).toBe("overloaded");
    expect(classifyProviderFailure({ errorMessage: "insufficient capacity" })).toBe("overloaded");
    expect(classifyProviderFailure({ stderr: "temporarily unavailable; try again" })).toBe("overloaded");
  });

  it("classifies transient network failures from errno text and gateway statuses", () => {
    expect(classifyProviderFailure({ errorMessage: "ECONNRESET" })).toBe("network_transient");
    expect(classifyProviderFailure({ stderr: "request failed with ETIMEDOUT" })).toBe("network_transient");
    expect(classifyProviderFailure({ errorMessage: "fetch failed" })).toBe("network_transient");
    expect(classifyProviderFailure({ stderr: "socket hang up" })).toBe("network_transient");
    expect(classifyProviderFailure({ errorMessage: "bad gateway 502" })).toBe("network_transient");
    expect(classifyProviderFailure({ errorMessage: "gateway timeout 504" })).toBe("network_transient");
  });

  it("classifies authentication and authorization failures as fatal", () => {
    expect(classifyProviderFailure({ errorMessage: "HTTP 401 Unauthorized" })).toBe("auth_fatal");
    expect(classifyProviderFailure({ errorMessage: "HTTP 403 Forbidden" })).toBe("auth_fatal");
    expect(classifyProviderFailure({ stderr: "invalid api key" })).toBe("auth_fatal");
    expect(classifyProviderFailure({ stderr: "authentication failed for provider" })).toBe("auth_fatal");
  });

  it("returns unknown for empty or unrecognized failures", () => {
    expect(classifyProviderFailure({})).toBe("unknown");
    expect(classifyProviderFailure({ errorMessage: null, stderr: null, exitCode: 1 })).toBe("unknown");
    expect(classifyProviderFailure({ errorMessage: "spawn adapter ENOENT", exitCode: 1 })).toBe("unknown");
  });

  it("does not match status codes embedded in longer alphanumeric tokens", () => {
    expect(classifyProviderFailure({ errorMessage: "model glm-529x missing" })).toBe("unknown");
    expect(classifyProviderFailure({ stderr: "wrote 14293 bytes" })).toBe("unknown");
  });
});

describe("computeProviderBackoffMs", () => {
  it("computes exponential backoff progression with defaults", () => {
    expect(computeProviderBackoffMs({ errorClass: "rate_limit", consecutiveFailures: 1 })).toEqual({
      retryable: true,
      delayMs: 15_000,
    });
    expect(computeProviderBackoffMs({ errorClass: "rate_limit", consecutiveFailures: 2 }).delayMs).toBe(30_000);
    expect(computeProviderBackoffMs({ errorClass: "overloaded", consecutiveFailures: 3 }).delayMs).toBe(60_000);
    expect(computeProviderBackoffMs({ errorClass: "network_transient", consecutiveFailures: 4 }).delayMs).toBe(120_000);
  });

  it("caps exponential backoff at maxMs", () => {
    expect(computeProviderBackoffMs({ errorClass: "rate_limit", consecutiveFailures: 10 }).delayMs).toBe(300_000);
    expect(computeProviderBackoffMs({
      errorClass: "rate_limit",
      consecutiveFailures: 4,
      baseMs: 10_000,
      maxMs: 50_000,
    }).delayMs).toBe(50_000);
  });

  it("honors retryAfterSec when larger and clamps it to maxMs", () => {
    expect(computeProviderBackoffMs({
      errorClass: "rate_limit",
      consecutiveFailures: 1,
      retryAfterSec: 45,
    }).delayMs).toBe(45_000);
    expect(computeProviderBackoffMs({
      errorClass: "rate_limit",
      consecutiveFailures: 1,
      retryAfterSec: 600,
    }).delayMs).toBe(300_000);
    expect(computeProviderBackoffMs({
      errorClass: "rate_limit",
      consecutiveFailures: 3,
      retryAfterSec: 10,
    }).delayMs).toBe(60_000);
  });

  it("returns non-retryable zero-delay results for auth_fatal and unknown", () => {
    expect(computeProviderBackoffMs({ errorClass: "auth_fatal", consecutiveFailures: 1 })).toEqual({
      retryable: false,
      delayMs: 0,
    });
    expect(computeProviderBackoffMs({ errorClass: "unknown", consecutiveFailures: 5, retryAfterSec: 30 })).toEqual({
      retryable: false,
      delayMs: 0,
    });
  });
});

describe("shouldTripProviderCircuit", () => {
  it("trips retryable classes at the default threshold", () => {
    expect(shouldTripProviderCircuit({ errorClass: "rate_limit", consecutiveFailures: 2 })).toBe(false);
    expect(shouldTripProviderCircuit({ errorClass: "rate_limit", consecutiveFailures: 3 })).toBe(true);
    expect(shouldTripProviderCircuit({ errorClass: "overloaded", consecutiveFailures: 3 })).toBe(true);
    expect(shouldTripProviderCircuit({ errorClass: "network_transient", consecutiveFailures: 4 })).toBe(true);
  });

  it("supports custom thresholds", () => {
    expect(shouldTripProviderCircuit({ errorClass: "overloaded", consecutiveFailures: 4, threshold: 5 })).toBe(false);
    expect(shouldTripProviderCircuit({ errorClass: "overloaded", consecutiveFailures: 5, threshold: 5 })).toBe(true);
  });

  it("always trips auth_fatal at one failure and never trips unknown", () => {
    expect(shouldTripProviderCircuit({ errorClass: "auth_fatal", consecutiveFailures: 0 })).toBe(false);
    expect(shouldTripProviderCircuit({ errorClass: "auth_fatal", consecutiveFailures: 1 })).toBe(true);
    expect(shouldTripProviderCircuit({ errorClass: "auth_fatal", consecutiveFailures: 1, threshold: 10 })).toBe(true);
    expect(shouldTripProviderCircuit({ errorClass: "unknown", consecutiveFailures: 99 })).toBe(false);
  });
});
