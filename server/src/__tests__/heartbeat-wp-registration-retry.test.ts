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

  it("isolates per-entry failure: a rejected first wakeup still flushes the second entry", async () => {
    // [항목별 실패 격리] 첫 항목의 enqueueWakeup reject 는 warn 후 무시되고, closeout 플러시는
    // throw 없이 resolve 해야 한다. 두 번째 항목은 자체 멱등키로 정상 큐잉된다.
    vi.mocked(hasLiveWakeCoverage).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const enqueueWakeup = vi.fn()
      .mockRejectedValueOnce(new Error("wakeup queue unavailable"))
      .mockResolvedValueOnce(undefined);
    await expect(
      flushWorkProductRegistrationRetries({} as never, enqueueWakeup, [
        {
          companyId: "co-1",
          issueId: "iss-fail",
          agentId: "ag-1",
          missionId: null,
          attempt: 1,
          requiredAction: WORK_PRODUCT_REGISTRATION_RETRY_REQUIRED_ACTION,
        },
        {
          companyId: "co-1",
          issueId: "iss-ok",
          agentId: "ag-2",
          missionId: "mis-2",
          attempt: 1,
          requiredAction: WORK_PRODUCT_REGISTRATION_RETRY_REQUIRED_ACTION,
        },
      ]),
    ).resolves.toBeUndefined();
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup).toHaveBeenNthCalledWith(
      2,
      "ag-2",
      expect.objectContaining({
        reason: "work_product_registration_retry",
        idempotencyKey: "wp-registration-retry:iss-ok:1",
        contextSnapshot: expect.objectContaining({ issueId: "iss-ok", missionId: "mis-2", attempt: 1 }),
      }),
    );
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
