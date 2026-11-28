import { beforeEach, describe, expect, it, vi } from "vitest";

const { sender, registerOutboundHandler } = vi.hoisted(() => ({
  sender: vi.fn().mockResolvedValue(undefined),
  registerOutboundHandler: vi.fn(),
}));

vi.mock("../channel/index.js", () => ({
  getChannelRegistry: () => ({
    getTelegramSender: () => sender,
    registerOutboundHandler,
  }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/run-honesty-guard.js", () => ({
  applyRunHonestyCaveat: vi.fn(async (_db, _run, text) => text),
}));

import {
  composeRunFailureNotification,
  formatEventNotification,
  initOutboundNotifier,
} from "../channel/telegram/outbound.js";

const base = { status: "failed", runId: "738a692f-1111-4111-8111-111111111111" };
const retryFlags = [
  "willRetry", "autoRetryScheduled", "fallbackScheduled", "retryScheduled", "suppressedByRetry",
] as const;
const overloads = [
  "429", "HTTP 429: provider busy", "Rate limit reached for requests",
  "RATE LIMIT REACHED FOR REQUESTS", "Provider overloaded", "OVERLOADED",
  "HTTP 529", "503 Service Unavailable", "503 service unavailable", "Too Many Requests",
  "Adapter failed\nCaused by: 429 Rate limit reached for requests",
];

describe("Telegram run failure suppression", () => {
  it.each(overloads)("suppresses overload in both formatters: %s", (error) => {
    expect(composeRunFailureNotification({ ...base, error })).toBeNull();
    expect(formatEventNotification({ type: "heartbeat.run.status", payload: { ...base, error } })).toBeNull();
  });

  it.each(retryFlags)("suppresses an explicitly scheduled recovery: %s", (flag) => {
    const input = { ...base, error: "Adapter exited", [flag]: true };
    expect(composeRunFailureNotification(input)).toBeNull();
    expect(formatEventNotification({ type: "heartbeat.run.status", payload: input })).toBeNull();
  });

  it.each(["adapter_failed_transient", "ADAPTER_FAILED_TRANSIENT", "429", "529"])(
    "suppresses transient error code %s", (errorCode) => {
      const input = { ...base, errorCode };
      expect(composeRunFailureNotification(input)).toBeNull();
      expect(formatEventNotification({ type: "heartbeat.run.status", payload: input })).toBeNull();
    },
  );

  it.each([
    "401 Unauthorized: invalid API key", "403 Forbidden", "Process crashed with SIGSEGV",
    "Missing tool: renderer", "adapter_failed", "File /tmp/4291 missing", "exit 1529",
  ])("preserves unrecovered failure notifications: %s", (error) => {
    expect(composeRunFailureNotification({ ...base, error })).toContain("런 실패");
    expect(formatEventNotification({ type: "heartbeat.run.status", payload: { ...base, error } }))
      .toContain("Failed");
  });

  it.each(retryFlags)("does not treat false or malformed %s as a scheduled retry", (flag) => {
    for (const value of [false, "false", "true", 0, 1, null]) {
      const input = { ...base, [flag]: value };
      expect(composeRunFailureNotification(input)).toContain("런 실패");
      expect(formatEventNotification({ type: "heartbeat.run.status", payload: input })).toContain("Failed");
    }
  });

  it("keeps overload matching scoped to run failures", () => {
    expect(formatEventNotification({
      type: "plugin.worker.crashed", payload: { pluginKey: "overloaded", willRetry: true },
    })).toContain("Plugin worker crashed");
  });
});

describe("Telegram outbound sender", () => {
  beforeEach(() => vi.clearAllMocks());

  async function handlerFor(row: Record<string, unknown> | null, lookupFails = false) {
    const query = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn(() => {
        if (lookupFails) query.limit.mockRejectedValueOnce(new Error("DB unavailable"));
        return query;
      }),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(row ? [row] : []),
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve([{
          companyId: "telegram-429-company", enabled: true, configJson: { telegramChatId: 42 },
        }]).then(resolve);
      },
    };
    await initOutboundNotifier({ select: () => query } as never);
    return registerOutboundHandler.mock.calls[0]![1] as (
      event: { type: string; payload: Record<string, unknown> },
    ) => Promise<void>;
  }

  it.each([
    { error: "429 Rate limit reached for requests" },
    { errorCode: "adapter_failed_transient" },
    { error: "Adapter exited", stderrExcerpt: "HTTP 529: overloaded" },
  ])("never falls back to a generic alert after DB-based suppression: %j", async (row) => {
    const handle = await handlerFor(row);
    await handle({ type: "heartbeat.run.status", payload: base });
    expect(sender).not.toHaveBeenCalled();
  });

  it.each(retryFlags)("suppresses payload %s even with a terminal DB error", async (flag) => {
    const handle = await handlerFor({ error: "Adapter exited", agentName: "Operator" });
    await handle({ type: "heartbeat.run.status", payload: { ...base, [flag]: true } });
    expect(sender).not.toHaveBeenCalled();
  });

  it("suppresses payload overload when the run cannot be loaded", async () => {
    const handle = await handlerFor(null);
    await handle({ type: "heartbeat.run.status", payload: { ...base, error: "HTTP 429" } });
    expect(sender).not.toHaveBeenCalled();
  });

  it("suppresses overload before the operator-conversation reply path", async () => {
    const handle = await handlerFor({
      ...base, error: "HTTP 429", agentName: "Operator",
      contextSnapshot: { telegramOperatorMessage: true, telegramChatId: 42 },
    });
    await handle({ type: "heartbeat.run.status", payload: base });
    expect(sender).not.toHaveBeenCalled();
  });

  it.each(["401 Unauthorized", "Process crashed", "Missing tool: renderer"])(
    "sends one enriched alert for terminal failure: %s", async (error) => {
      const handle = await handlerFor({ error, agentName: "Operator" });
      await handle({ type: "heartbeat.run.status", payload: base });
      expect(sender).toHaveBeenCalledExactlyOnceWith(42, expect.stringContaining("런 실패"));
      expect(sender.mock.calls[0]![1]).toContain(error);
    },
  );

  it.each([false, true])("preserves generic terminal alerts when the lookup fails: %s", async (lookupFails) => {
    const handle = await handlerFor(null, lookupFails);
    await handle({ type: "heartbeat.run.status", payload: base });
    expect(sender).toHaveBeenCalledExactlyOnceWith(42, expect.stringContaining("Failed"));
  });

  it("preserves successful operator-conversation replies", async () => {
    const handle = await handlerFor({
      status: "succeeded", agentName: "Operator", resultJson: { result: "Completed" },
      contextSnapshot: { telegramOperatorMessage: true, telegramChatId: 42 },
    });
    await handle({ type: "heartbeat.run.status", payload: { ...base, status: "succeeded", willRetry: true } });
    expect(sender).toHaveBeenCalledExactlyOnceWith(42, "Operator\nCompleted");
  });
});
