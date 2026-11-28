import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OVERLOAD_MAX_COOLDOWN_RETRIES,
  computeOverloadCooldownSec,
  isTransientServerOverloadError,
  resolveOverloadFailureHandling,
  scheduleOverloadCooldownRetry,
  shouldEscalateToHumanOnFailure,
} from "../services/heartbeat-overload-backoff.js";

describe("isTransientServerOverloadError", () => {
  it("matches provider 429 / rate-limit / overload texts case-insensitively", () => {
    expect(isTransientServerOverloadError("Rate limit reached for requests")).toBe(true);
    expect(isTransientServerOverloadError("rate limit reached for requests")).toBe(true);
    expect(isTransientServerOverloadError("Request failed: HTTP 429")).toBe(true);
    expect(isTransientServerOverloadError("(429) too many requests")).toBe(true);
    expect(isTransientServerOverloadError("Too Many Requests")).toBe(true);
    expect(isTransientServerOverloadError("provider is currently overloaded")).toBe(true);
    expect(isTransientServerOverloadError("Overloaded_Error from upstream")).toBe(true);
    expect(isTransientServerOverloadError("gateway responded 529")).toBe(true);
    expect(isTransientServerOverloadError("HTTP 503 Service Unavailable")).toBe(true);
  });

  it("rejects non-overload failures and does not match digits inside longer numbers", () => {
    expect(isTransientServerOverloadError(null)).toBe(false);
    expect(isTransientServerOverloadError(undefined)).toBe(false);
    expect(isTransientServerOverloadError("")).toBe(false);
    expect(isTransientServerOverloadError("spawn glm ENOENT")).toBe(false);
    expect(isTransientServerOverloadError("ECONNRESET while reading stdout")).toBe(false);
    expect(isTransientServerOverloadError("exit code 1")).toBe(false);
    expect(isTransientServerOverloadError("log reached 14293 bytes")).toBe(false);
    expect(isTransientServerOverloadError("model glm-529x not found")).toBe(false);
  });
});

describe("computeOverloadCooldownSec", () => {
  it("progresses 30/60/120/240 and caps at 300s", () => {
    expect(computeOverloadCooldownSec(1)).toBe(30);
    expect(computeOverloadCooldownSec(2)).toBe(60);
    expect(computeOverloadCooldownSec(3)).toBe(120);
    expect(computeOverloadCooldownSec(4)).toBe(240);
    expect(computeOverloadCooldownSec(5)).toBe(300);
    expect(computeOverloadCooldownSec(6)).toBe(300);
    expect(computeOverloadCooldownSec(10)).toBe(300);
  });

  it("clamps invalid attempts to the first rung", () => {
    expect(computeOverloadCooldownSec(0)).toBe(30);
    expect(computeOverloadCooldownSec(Number.NaN)).toBe(30);
  });
});

describe("OVERLOAD_MAX_COOLDOWN_RETRIES", () => {
  it("is 5", () => {
    expect(OVERLOAD_MAX_COOLDOWN_RETRIES).toBe(5);
  });
});

describe("shouldEscalateToHumanOnFailure", () => {
  it("never escalates a human card for overload failures — even when retries are exhausted", () => {
    expect(shouldEscalateToHumanOnFailure({ isOverload: true })).toBe(false);
    expect(shouldEscalateToHumanOnFailure({ isOverload: true, retriesExhausted: true })).toBe(false);
  });

  it("preserves existing behavior for non-overload failures", () => {
    expect(shouldEscalateToHumanOnFailure({ isOverload: false, retriesExhausted: true })).toBe(true);
    expect(shouldEscalateToHumanOnFailure({ isOverload: false })).toBe(false);
  });
});

describe("resolveOverloadFailureHandling", () => {
  it("schedules a cooldown retry for a fresh 429 overload failure", () => {
    const decision = resolveOverloadFailureHandling({
      errorText: "Rate limit reached for requests",
      processLossRetryCount: 0,
    });
    expect(decision.isOverload).toBe(true);
    expect(decision.retryQueued).toBe(true);
    expect(decision.attempt).toBe(1);
    expect(decision.cooldownSec).toBe(30);
    expect(decision.escalateToHuman).toBe(false);
  });

  it("keeps retrying inside the bounded budget regardless of the generic 1-retry cap", () => {
    const decision = resolveOverloadFailureHandling({
      errorText: "HTTP 429 too many requests",
      processLossRetryCount: 3,
    });
    expect(decision.retryQueued).toBe(true);
    expect(decision.attempt).toBe(4);
    expect(decision.cooldownSec).toBe(240);
    expect(decision.escalateToHuman).toBe(false);
  });

  it("defers cleanly without a human card when the cooldown retry budget is exhausted", () => {
    const decision = resolveOverloadFailureHandling({
      errorText: "Rate limit reached for requests",
      processLossRetryCount: 5,
    });
    expect(decision.isOverload).toBe(true);
    expect(decision.retryQueued).toBe(false);
    expect(decision.cooldownSec).toBe(0);
    expect(decision.escalateToHuman).toBe(false);
  });

  it("preserves the existing escalate-on-exhaustion path for non-overload errors", () => {
    const decision = resolveOverloadFailureHandling({
      errorText: "adapter command exited with code 2",
      processLossRetryCount: 0,
    });
    expect(decision.isOverload).toBe(false);
    expect(decision.retryQueued).toBe(false);
    expect(decision.cooldownSec).toBe(0);
    expect(decision.escalateToHuman).toBe(true);
  });
});

describe("scheduleOverloadCooldownRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the cooldown before enqueueing the retry exactly once", async () => {
    vi.useFakeTimers();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const timer = scheduleOverloadCooldownRetry({ cooldownSec: 30, enqueue });

    expect(enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    timer.unref?.();
  });

  it("routes enqueue failures to onError instead of leaking unhandled rejections", async () => {
    vi.useFakeTimers();
    const enqueue = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const onError = vi.fn();
    const timer = scheduleOverloadCooldownRetry({ cooldownSec: 60, enqueue, onError });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    timer.unref?.();
  });
});
