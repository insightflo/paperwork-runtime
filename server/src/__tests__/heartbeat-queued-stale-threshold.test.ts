import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV,
  QUEUED_STALE_THRESHOLD_CEILING_MS,
  QUEUED_STALE_THRESHOLD_FLOOR_MS,
  clampQueuedStaleThresholdMs,
  createHeartbeatScheduler,
  defaultQueuedStaleThresholdMs,
  parseQueuedStaleThresholdMsEnv,
  resolveQueuedStaleThresholdMs,
} from "../services/heartbeat-scheduler.js";

const RECOVERY_STALE_MS = 5 * 60 * 1000;
// 기존 기본값: max(recovery*3, 15m) = 900_000ms (900s)
const DEFAULT_QUEUED_STALE_MS = Math.max(RECOVERY_STALE_MS * 3, 15 * 60 * 1000);

function makeSchedulerHarness() {
  const heartbeat = {
    tickTimers: vi.fn(async () => ({ enqueued: 0 })),
    reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
    reapStaleBusyMissionRuntimes: vi.fn(async () => ({ reaped: 0 })),
    reapStalledIssueExecutionLocks: vi.fn(async () => ({ reaped: 0 })),
    resumeQueuedRuns: vi.fn(async () => ({ resumed: 0, runIds: [] })),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const create = () => createHeartbeatScheduler({ heartbeat, logger, timerIntervalMs: 30_000, recoveryIntervalMs: 300_000 });
  return { heartbeat, logger, create };
}

async function firstRecoveryCall(harness: ReturnType<typeof makeSchedulerHarness>) {
  const scheduler = harness.create();
  scheduler.start();
  await Promise.resolve();
  await Promise.resolve();
  scheduler.stop();
  expect(harness.heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);
  return harness.heartbeat.reapOrphanedRuns.mock.calls[0]?.[0];
}

describe("PAPERCLIP_QUEUED_STALE_THRESHOLD_MS parsing", () => {
  describe("parseQueuedStaleThresholdMsEnv", () => {
    it("returns null for unset, blank, non-numeric, NaN and non-positive values", () => {
      expect(parseQueuedStaleThresholdMsEnv(undefined)).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("   ")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("abc")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("12abc")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("NaN")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("Infinity")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("0")).toBeNull();
      expect(parseQueuedStaleThresholdMsEnv("-900000")).toBeNull();
    });

    it("parses positive integers and truncates fractional input", () => {
      expect(parseQueuedStaleThresholdMsEnv("900000")).toBe(900_000);
      expect(parseQueuedStaleThresholdMsEnv(" 1200000 ")).toBe(1_200_000);
      expect(parseQueuedStaleThresholdMsEnv("1e6")).toBe(1_000_000);
      expect(parseQueuedStaleThresholdMsEnv("1500.9")).toBe(1_500);
    });
  });

  describe("clampQueuedStaleThresholdMs", () => {
    it("clamps into the [1min, 24h] safety band", () => {
      expect(clampQueuedStaleThresholdMs(1_000)).toBe(QUEUED_STALE_THRESHOLD_FLOOR_MS);
      expect(clampQueuedStaleThresholdMs(60_000)).toBe(QUEUED_STALE_THRESHOLD_FLOOR_MS);
      expect(clampQueuedStaleThresholdMs(900_000)).toBe(900_000);
      expect(clampQueuedStaleThresholdMs(86_400_000)).toBe(QUEUED_STALE_THRESHOLD_CEILING_MS);
      expect(clampQueuedStaleThresholdMs(99_999_999_999)).toBe(QUEUED_STALE_THRESHOLD_CEILING_MS);
    });
  });

  describe("resolveQueuedStaleThresholdMs", () => {
    it("falls back to the existing default max(recovery*3, 15m) when env is unset or invalid", () => {
      expect(defaultQueuedStaleThresholdMs(RECOVERY_STALE_MS)).toBe(DEFAULT_QUEUED_STALE_MS);
      expect(resolveQueuedStaleThresholdMs(undefined, RECOVERY_STALE_MS)).toBe(DEFAULT_QUEUED_STALE_MS);
      expect(resolveQueuedStaleThresholdMs("", RECOVERY_STALE_MS)).toBe(DEFAULT_QUEUED_STALE_MS);
      expect(resolveQueuedStaleThresholdMs("not-a-number", RECOVERY_STALE_MS)).toBe(DEFAULT_QUEUED_STALE_MS);
      expect(resolveQueuedStaleThresholdMs("0", RECOVERY_STALE_MS)).toBe(DEFAULT_QUEUED_STALE_MS);
    });

    it("honors a valid env value and clamps out-of-band values", () => {
      expect(resolveQueuedStaleThresholdMs("1200000", RECOVERY_STALE_MS)).toBe(1_200_000);
      expect(resolveQueuedStaleThresholdMs("30000", RECOVERY_STALE_MS)).toBe(QUEUED_STALE_THRESHOLD_FLOOR_MS);
      expect(resolveQueuedStaleThresholdMs("999999999999", RECOVERY_STALE_MS)).toBe(QUEUED_STALE_THRESHOLD_CEILING_MS);
    });
  });
});

describe("PAPERCLIP_QUEUED_STALE_THRESHOLD_MS scheduler wiring", () => {
  const originalEnv = process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV];
    else process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV] = originalEnv;
  });

  it("keeps the legacy default threshold when the env is unset", async () => {
    delete process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV];
    const opts = await firstRecoveryCall(makeSchedulerHarness());
    expect(opts).toEqual({
      staleThresholdMs: RECOVERY_STALE_MS,
      activeExecutionTimeoutMs: 15 * 60 * 1000,
      queuedStaleThresholdMs: DEFAULT_QUEUED_STALE_MS,
    });
  });

  it("passes the env-resolved threshold to reapOrphanedRuns", async () => {
    process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV] = "1200000";
    const opts = await firstRecoveryCall(makeSchedulerHarness());
    expect(opts?.queuedStaleThresholdMs).toBe(1_200_000);
  });

  it("clamps an out-of-band env value before handing it to reapOrphanedRuns", async () => {
    process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV] = "5000";
    const opts = await firstRecoveryCall(makeSchedulerHarness());
    expect(opts?.queuedStaleThresholdMs).toBe(QUEUED_STALE_THRESHOLD_FLOOR_MS);
  });

  it("falls back to the default and warns when the env value is invalid", async () => {
    const harness = makeSchedulerHarness();
    process.env[PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV] = "soon-ish";
    const opts = await firstRecoveryCall(harness);
    expect(opts?.queuedStaleThresholdMs).toBe(DEFAULT_QUEUED_STALE_MS);
    expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining(PAPERCLIP_QUEUED_STALE_THRESHOLD_MS_ENV));
  });
});
