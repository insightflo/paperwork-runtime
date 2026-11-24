import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  PaperworkEngineRedactorError,
  REDACTED_UNSCANNED,
  REDACTOR_MAX_TEXT_BYTES,
  redactTextFailClosed,
} from "../services/paperwork-engine-redactor.js";

const mocks = vi.hoisted(() => ({
  getShared: vi.fn(),
  engineCall: vi.fn(),
}));

vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: mocks.getShared,
}));

const sharedEngine = { call: mocks.engineCall } as unknown as PaperworkEngineClient;
const SECRET_INPUT = "tok sk-ant-abc123def456 ok";

describe("redactTextFailClosed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getShared.mockReturnValue(sharedEngine);
    mocks.engineCall.mockResolvedValue({ redacted: "tok [redacted] ok", changed: true });
  });

  it("returns engine-redacted text for secret input", async () => {
    await expect(redactTextFailClosed(SECRET_INPUT)).resolves.toBe("tok [redacted] ok");
    expect(mocks.getShared).toHaveBeenCalledTimes(1);
    expect(mocks.engineCall).toHaveBeenCalledWith(
      "redactor.redact_text",
      { text: SECRET_INPUT },
      { timeoutMs: undefined },
    );
  });

  it("returns clean text unchanged via the engine", async () => {
    mocks.engineCall.mockResolvedValue({ redacted: "plain", changed: false });
    await expect(redactTextFailClosed("plain")).resolves.toBe("plain");
  });

  it("uses an injected engineClient instead of the shared one", async () => {
    const injected = { call: vi.fn().mockResolvedValue({ redacted: "x", changed: false }) };
    const engine = injected as unknown as PaperworkEngineClient;
    await expect(redactTextFailClosed("x", { engineClient: engine, timeoutMs: 50 })).resolves.toBe("x");
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(injected.call).toHaveBeenCalledWith(
      "redactor.redact_text",
      { text: "x" },
      { timeoutMs: 50 },
    );
  });

  it("forwards exactly MAX_TEXT_BYTES (UTF-8) to the engine", async () => {
    const atLimit = "y".repeat(REDACTOR_MAX_TEXT_BYTES);
    await redactTextFailClosed(atLimit);
    expect(mocks.engineCall).toHaveBeenCalledWith(
      "redactor.redact_text", { text: atLimit }, { timeoutMs: undefined },
    );
  });

  it.each<[string, string]>([
    ["ascii one over", "y".repeat(REDACTOR_MAX_TEXT_BYTES + 1)],
    ["multibyte over bytes", "€".repeat(Math.floor(REDACTOR_MAX_TEXT_BYTES / 3) + 1)],
    ["ill-formed lone surrogate", "a\ud800b"],
  ])("degrades %s to the sentinel before engine access", async (_label, input) => {
    await expect(redactTextFailClosed(input)).resolves.toBe(REDACTED_UNSCANNED);
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["null result", null],
    ["array result", ["x"]],
    ["redacted non-string", { redacted: 7, changed: true }],
    ["missing changed", { redacted: "x" }],
    ["changed non-boolean", { redacted: "x", changed: "yes" }],
    ["missing redacted", { changed: true }],
  ])("degrades malformed wire response (%s) to the sentinel", async (_label, reply) => {
    mocks.engineCall.mockResolvedValue(reply);
    const out = await redactTextFailClosed(SECRET_INPUT);
    expect(out).toBe(REDACTED_UNSCANNED);
    expect(out).not.toContain("sk-ant-abc123def456");
  });

  it("degrades rpc/transport failures to the sentinel without leaking raw text", async () => {
    for (const setup of [
      () => mocks.engineCall.mockRejectedValueOnce(new Error("timeout")),
      () => mocks.engineCall.mockRejectedValueOnce(Object.assign(new Error("engine exited"), { code: "process_exited" })),
      () => mocks.getShared.mockReturnValueOnce(null),
      () => mocks.getShared.mockImplementationOnce(() => { throw new Error("no bin"); }),
    ]) {
      setup();
      const out = await redactTextFailClosed(SECRET_INPUT);
      expect(out).toBe(REDACTED_UNSCANNED);
      expect(out).not.toContain(SECRET_INPUT);
    }
    expect(mocks.engineCall).toHaveBeenCalledTimes(2);
    expect(mocks.getShared).toHaveBeenCalledTimes(4);
  });

  it("degrades an explicit null engineClient to the sentinel", async () => {
    await expect(redactTextFailClosed(SECRET_INPUT, { engineClient: null }))
      .resolves.toBe(REDACTED_UNSCANNED);
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["number", 42],
    ["null", null],
    ["undefined", undefined],
    ["object", { text: "x" }],
    ["array", ["x"]],
    ["boolean", true],
  ])("rejects non-string input (%s) fail-closed before engine access", async (_label, input) => {
    const pending = redactTextFailClosed(input);
    await expect(pending).rejects.toThrow(PaperworkEngineRedactorError);
    await expect(pending).rejects.toMatchObject({ reason: "invalid_input" });
    expect(mocks.getShared).not.toHaveBeenCalled();
    expect(mocks.engineCall).not.toHaveBeenCalled();
  });
});
