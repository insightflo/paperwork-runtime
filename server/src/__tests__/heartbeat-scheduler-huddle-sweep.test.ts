import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatScheduler } from "../services/heartbeat-scheduler.js";

const timerIntervalMs = 30_000;

function createHeartbeat() {
  return {
    tickTimers: vi.fn(async () => ({ enqueued: 0 })),
    reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
    reapStaleBusyMissionRuntimes: vi.fn(async () => ({ reaped: 0 })),
    reapStalledIssueExecutionLocks: vi.fn(async () => ({ reaped: 0 })),
    resumeQueuedRuns: vi.fn(async () => ({ resumed: 0, runIds: [] })),
  };
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("heartbeat scheduler exception huddle timeout sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes the sweep with the timer-tick date and logs timed-out huddles", async () => {
    const heartbeat = createHeartbeat();
    const logger = createLogger();
    const sweepTimedOutExceptionHuddles = vi.fn(async () => ({
      scanned: 4,
      timedOut: 2,
      wokeChair: 2,
    }));
    const scheduler = createHeartbeatScheduler({
      heartbeat,
      logger,
      timerIntervalMs,
      recoveryIntervalMs: 300_000,
      sweepTimedOutExceptionHuddles,
    });

    scheduler.start();
    await flushMicrotasks();
    expect(sweepTimedOutExceptionHuddles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(timerIntervalMs);
    await flushMicrotasks();

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(1);
    expect(sweepTimedOutExceptionHuddles).toHaveBeenCalledTimes(1);
    const timerNow = heartbeat.tickTimers.mock.calls[0]?.[0];
    expect(timerNow).toBeInstanceOf(Date);
    expect(sweepTimedOutExceptionHuddles).toHaveBeenCalledWith(timerNow);
    expect(logger.info).toHaveBeenCalledWith(
      { scanned: 4, timedOut: 2, wokeChair: 2 },
      "swept timed-out exception huddles",
    );

    scheduler.stop();
  });

  it("catches and logs sweep errors without breaking later timer ticks", async () => {
    const heartbeat = createHeartbeat();
    const logger = createLogger();
    const failure = new Error("sweep boom");
    const sweepTimedOutExceptionHuddles = vi.fn()
      .mockImplementationOnce(async () => {
        throw failure;
      })
      .mockImplementationOnce(async () => ({ scanned: 1, timedOut: 0, wokeChair: 0 }));
    const scheduler = createHeartbeatScheduler({
      heartbeat,
      logger,
      timerIntervalMs,
      recoveryIntervalMs: 300_000,
      sweepTimedOutExceptionHuddles,
    });

    scheduler.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(timerIntervalMs);
    await flushMicrotasks();

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(1);
    expect(sweepTimedOutExceptionHuddles).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure },
      "exception huddle timeout sweep failed; continuing timer tick",
    );

    await vi.advanceTimersByTimeAsync(timerIntervalMs);
    await flushMicrotasks();

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(2);
    expect(sweepTimedOutExceptionHuddles).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("preserves existing timer behavior with zero errors when the sweep is omitted", async () => {
    const heartbeat = createHeartbeat();
    const logger = createLogger();
    const scheduler = createHeartbeatScheduler({
      heartbeat,
      logger,
      timerIntervalMs,
      recoveryIntervalMs: 300_000,
    });

    scheduler.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(timerIntervalMs);
    await flushMicrotasks();

    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    scheduler.stop();
  });
});
