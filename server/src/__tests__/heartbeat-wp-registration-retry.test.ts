import { describe, expect, it, vi } from "vitest";
import {
  WORK_PRODUCT_REGISTRATION_RETRY_BUDGET,
  WORK_PRODUCT_REGISTRATION_RETRY_REQUIRED_ACTION,
  countPriorWorkProductRegistrationAutoBlocks,
  flushWorkProductRegistrationRetries,
} from "../services/heartbeat-wp-registration-retry.js";
import { settleDispatchBoundTerminalFailure } from "../services/heartbeat-dispatch-settle.js";
import { SHUTDOWN_INTERRUPTED_ERROR_CODE } from "../services/shutdown-flush.js";

vi.mock("../services/missions/qa-rework-cap-oversight-wake.js", () => ({
  hasLiveWakeCoverage: vi.fn(),
}));

import { hasLiveWakeCoverage } from "../services/missions/qa-rework-cap-oversight-wake.js";

describe("heartbeat-wp-registration-retry", () => {
  it("counts prior structured auto-block activity rows for the issue", async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ id: "a1" }],
        }),
      }),
    };
    const count = await countPriorWorkProductRegistrationAutoBlocks(fakeDb as never, "co-1", "iss-1");
    expect(count).toBe(1);
    expect(WORK_PRODUCT_REGISTRATION_RETRY_BUDGET).toBe(1);
  });

  it("enqueues bounded registration-only retry when no live wake coverage exists", async () => {
    vi.mocked(hasLiveWakeCoverage).mockResolvedValueOnce(false);
    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    await flushWorkProductRegistrationRetries({} as never, enqueueWakeup, [
      {
        companyId: "co-1",
        issueId: "iss-1",
        agentId: "ag-1",
        missionId: "mis-1",
        attempt: 1,
        requiredAction: WORK_PRODUCT_REGISTRATION_RETRY_REQUIRED_ACTION,
      },
    ]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      "ag-1",
      expect.objectContaining({
        reason: "work_product_registration_retry",
        idempotencyKey: "wp-registration-retry:iss-1:1",
        contextSnapshot: expect.objectContaining({
          issueId: "iss-1",
          missionId: "mis-1",
          attempt: 1,
        }),
      }),
    );
  });

  it("skips wakeup when live wake coverage already exists", async () => {
    vi.mocked(hasLiveWakeCoverage).mockResolvedValueOnce(true);
    const enqueueWakeup = vi.fn().mockResolvedValue(undefined);
    await flushWorkProductRegistrationRetries({} as never, enqueueWakeup, [
      {
        companyId: "co-1",
        issueId: "iss-2",
        agentId: "ag-1",
        missionId: null,
        attempt: 1,
        requiredAction: WORK_PRODUCT_REGISTRATION_RETRY_REQUIRED_ACTION,
      },
    ]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

describe("settleDispatchBoundTerminalFailure shutdown/process_lost guards", () => {
  it.each(["process_lost", SHUTDOWN_INTERRUPTED_ERROR_CODE, "c5_held_not_invoked"])(
    "skips dispatch settle without hitting DB for errorCode=%s",
    async (errorCode) => {
      const select = vi.fn();
      await settleDispatchBoundTerminalFailure({
        db: { select } as never,
        run: {
          id: "run-1",
          companyId: "co-1",
          status: "failed",
          issueId: "iss-1",
          workflowStepRunId: "step-1",
          errorCode,
        } as never,
      });
      expect(select).not.toHaveBeenCalled();
    },
  );
});
