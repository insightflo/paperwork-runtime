import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  composeRunFailureNotification,
  shouldSuppressRunFailure,
} from "../channel/telegram/run-failure-notification.js";

const base = { status: "failed", runId: "738a692f-2222-4222-8222-222222222222" };

describe("stale_queued run failure suppression", () => {
  it.each(["stale_queued", "STALE_QUEUED", "Stale_Queued", " stale_queued "])(
    "suppresses stale_queued error code: %s",
    (errorCode) => {
      const input = { ...base, errorCode };
      expect(shouldSuppressRunFailure(input)).toBe(true);
      expect(composeRunFailureNotification(input)).toBeNull();
    },
  );

  it.each([
    "run went stale_queued while waiting for a free queue slot",
    "queue saturation: run stale_queued after 300s",
    "RUN STALE_QUEUED after queue saturation",
    "run stale_queued_timeout: no free worker slot",
  ])("suppresses error text containing stale_queued: %s", (error) => {
    const input = { ...base, error };
    expect(shouldSuppressRunFailure(input)).toBe(true);
    expect(composeRunFailureNotification(input)).toBeNull();
  });

  it.each(["error", "errorMessage", "errorCode", "stderrExcerpt"] as const)(
    "suppresses stale_queued found in %s",
    (field) => {
      const input = { ...base, [field]: "run stale_queued: queue saturated" };
      expect(shouldSuppressRunFailure(input)).toBe(true);
    },
  );

  it.each([
    "401 Unauthorized: invalid API key",
    "Process crashed with SIGSEGV",
    "Missing tool: renderer",
    "contract violation: expected JSON object",
    "retry exhausted: stale queued run without marker",
    "exit 1529",
  ])("keeps genuine runtime failure alerts: %s", (error) => {
    const input = { ...base, error };
    expect(shouldSuppressRunFailure(input)).toBe(false);
    expect(composeRunFailureNotification(input)).toContain("런 실패");
  });

  it("suppresses heartbeat_workflow_identity_mismatch guard cancellations", () => {
    const input = { status: "cancelled", runId: base.runId, errorCode: "heartbeat_workflow_identity_mismatch" };
    expect(shouldSuppressRunFailure(input)).toBe(true);
    expect(composeRunFailureNotification(input)).toBeNull();
  });

  it("keeps genuine failure alerts when only an unrelated code is present", () => {
    const input = { ...base, errorCode: "adapter_failed" };
    expect(shouldSuppressRunFailure(input)).toBe(false);
    expect(composeRunFailureNotification(input)).toContain("런 실패");
  });
});
