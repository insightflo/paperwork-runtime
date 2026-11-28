import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FRESH_PROMOTION_HANDOFF_GRACE_MS,
  latestQueueActivityMs,
} from "../services/heartbeat-queued-stale-recovery.js";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offsetMs: number) => new Date(BASE_MS + offsetMs);

describe("FRESH_PROMOTION_HANDOFF_GRACE_MS", () => {
  it("is positive and at least 30 seconds", () => {
    expect(FRESH_PROMOTION_HANDOFF_GRACE_MS).toBeGreaterThan(0);
    expect(FRESH_PROMOTION_HANDOFF_GRACE_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("latestQueueActivityMs", () => {
  it("uses updatedAt when it is newer than createdAt", () => {
    expect(latestQueueActivityMs(at(1_000), at(2_000))).toBe(BASE_MS + 2_000);
  });

  it("uses createdAt when it is newer than updatedAt", () => {
    expect(latestQueueActivityMs(at(2_000), at(1_000))).toBe(BASE_MS + 2_000);
  });

  it("uses the shared timestamp when createdAt and updatedAt are equal", () => {
    expect(latestQueueActivityMs(at(1_000), at(1_000))).toBe(BASE_MS + 1_000);
  });

  it("falls back to createdAt when updatedAt is null", () => {
    expect(latestQueueActivityMs(at(1_000), null)).toBe(BASE_MS + 1_000);
  });

  it("falls back to createdAt when updatedAt is undefined at runtime", () => {
    expect(latestQueueActivityMs(at(1_000), undefined as unknown as null)).toBe(BASE_MS + 1_000);
  });

  it("falls back to updatedAt when createdAt is null", () => {
    expect(latestQueueActivityMs(null, at(2_000))).toBe(BASE_MS + 2_000);
  });

  it("returns null when both timestamps are null", () => {
    expect(latestQueueActivityMs(null, null)).toBeNull();
  });

  it("keeps the accepted input contract to Date or null, not ISO strings", () => {
    expectTypeOf<Parameters<typeof latestQueueActivityMs>>().toEqualTypeOf<[Date | null, Date | null]>();
  });
});
