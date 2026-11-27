import { describe, expect, it, vi } from "vitest";
import { createEndpointBotPairingService } from "../services/endpoint-bot-pairing.js";
import { dispatchChannelMessageToEndpoint, parseEndpointMentionCommand } from "../services/endpoint-channel-dispatch.js";

const companyId = "company-a", nowMs = 1_000;
function setup(mode: "ro" | "rw" = "rw", owner = companyId) {
  const store = createEndpointBotPairingService();
  const { code } = store.issuePairingCode({
    companyId: owner, botName: "my-mac", requestedFolders: [{ path: "/work", mode }], nowMs,
  });
  const { deviceId } = store.completePairing({ code, os: "darwin", arch: "arm64", detectedClis: [], nowMs });
  const dispatch = (messageText: string, at = nowMs) => dispatchChannelMessageToEndpoint({
    companyId, messageText, store, nowMs: at,
  });
  const pending = () => store.pollPendingTasks({ companyId: owner, deviceId });
  return { store, deviceId, dispatch, pending };
}

describe("endpoint mention parsing", () => {
  it.each([
    "Hello everyone", "@agent please review this", "@agent list", "@agent read", "@agent run /work",
    "@my-mac run /work --", "@my-mac run -- pwd", "@my-mac delete /work",
    "Please ask @my-mac list /work", "person@my-mac list /work", "@bad!name list /work",
    "@my-mac list /work\n@other run /work -- pwd",
  ])("leaves ordinary chat or incomplete commands untouched: %j", (messageText) => {
    expect(parseEndpointMentionCommand(messageText)).toBeNull();
  });

  it("parses list with whitespace, case-insensitive verbs and a valid slug", () => {
    expect(parseEndpointMentionCommand("  @My-Mac_1.local LIST /work/My Projects  ")).toEqual({
      botName: "My-Mac_1.local", kind: "list_dir", targetPath: "/work/My Projects",
    });
  });

  it("parses read without changing a Windows path", () => {
    expect(parseEndpointMentionCommand("@my-mac read C:\\Work\\README.md")).toEqual({
      botName: "my-mac", kind: "read_file", targetPath: "C:\\Work\\README.md",
    });
  });

  it("parses run and preserves shell text after the first separator", () => {
    expect(parseEndpointMentionCommand('@my-mac run /work/My Projects -- echo "hi" && tool -- --help')).toEqual({
      botName: "my-mac", kind: "shell_exec", targetPath: "/work/My Projects", command: 'echo "hi" && tool -- --help',
    });
  });
});

describe("channel endpoint dispatch", () => {
  it("returns unmatched without querying or enqueuing for normal agent chat", () => {
    const { store, dispatch } = setup();
    const list = vi.spyOn(store, "listEndpoints"), enqueue = vi.spyOn(store, "enqueueLocalTask");
    expect(dispatch("@agent please review this")).toEqual({ matched: false });
    expect(list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns a useful reply for an unknown bot", () => {
    const { dispatch, pending } = setup();
    expect(dispatch("@unknown list /work")).toMatchObject({
      matched: true, ok: false, reason: "endpoint_not_found", replyText: expect.stringContaining("@unknown"),
    });
    expect(pending()).toEqual([]);
  });

  it("cannot dispatch to a matching bot in another company", () => {
    const { dispatch, pending } = setup("rw", "company-b");
    expect(dispatch("@my-mac read /work/a")).toMatchObject({ reason: "endpoint_not_found" });
    expect(pending()).toEqual([]);
  });

  it("rejects an offline endpoint without enqueuing", () => {
    const { dispatch, pending } = setup();
    expect(dispatch("@my-mac list /work", nowMs + 60_001)).toMatchObject({
      matched: true, ok: false, reason: "endpoint_offline", replyText: expect.stringContaining("@my-mac"),
    });
    expect(pending()).toEqual([]);
  });

  it.each([
    ["@MY-MAC list /work", "list_dir", "/work", undefined],
    ["@my-mac read /work/README.md", "read_file", "/work/README.md", undefined],
    ["@my-mac run /work -- pwd", "shell_exec", "/work", "pwd"],
  ])("enqueues an online command exactly once: %s", (messageText, kind, targetPath, command) => {
    const { dispatch, pending, deviceId } = setup();
    const result = dispatch(messageText);
    const tasks = pending();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ companyId, deviceId, kind, targetPath, command, status: "pending", createdAtMs: nowMs });
    expect(result).toMatchObject({
      matched: true, ok: true, deviceId, taskId: tasks[0]!.taskId, replyText: expect.stringContaining("@my-mac"),
    });
  });

  it("blocks shell execution in a read-only folder", () => {
    const { dispatch, pending } = setup("ro");
    expect(dispatch("@my-mac run /work -- pwd")).toMatchObject({
      matched: true, ok: false, reason: "policy_denied", replyText: expect.any(String),
    });
    expect(pending()).toEqual([]);
  });

  it.each(["list", "read"])("allows %s in a read-only folder", (verb) => {
    const { dispatch, pending } = setup("ro");
    expect(dispatch(`@my-mac ${verb} /work/a`)).toMatchObject({ ok: true });
    expect(pending()).toHaveLength(1);
  });

  it.each(["/work/../secret", "/work/..\\secret", "/work-other/a", "/secret", "relative/path"])(
    "blocks traversal and paths outside grants: %s", (targetPath) => {
      const { dispatch, pending } = setup();
      expect(dispatch(`@my-mac read ${targetPath}`)).toMatchObject({ matched: true, ok: false, reason: "policy_denied" });
      expect(pending()).toEqual([]);
    },
  );

  it("uses one clock snapshot for presence and task creation when no time is injected", () => {
    const { store, pending } = setup();
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs + 60_000);
    try {
      expect(dispatchChannelMessageToEndpoint({ companyId, messageText: "@my-mac list /work", store })).toMatchObject({ ok: true });
      expect(pending()[0]?.createdAtMs).toBe(nowMs + 60_000);
      expect(clock).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});
