import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOT_POLICY,
  canAgentAccessFolder,
  isMcpServerAllowed,
  normalizeBotPolicy,
  validateBotPolicy,
} from "../services/agent-bot-policy.js";

describe("bot policy defaults and validation", () => {
  it.each([["undefined", undefined], ["null", null]])("uses safe defaults for %s", (_label, raw) => {
    const policy = normalizeBotPolicy(raw);
    expect(policy).toEqual(DEFAULT_BOT_POLICY);
    expect(policy.accessLevel).toBe("read_only");
    expect(policy.allowedFolders).toEqual([]);
    expect(policy).toMatchObject({
      allowComputerUse: false, allowLocalScripts: false, canStartNewThreads: false,
      mcpAccess: { mode: "allowlist", servers: [] }, memoryLimit: 1000, maxConcurrentTasks: 1,
    });
    expect(isMcpServerAllowed(policy, "GitHub")).toBe(false);
    expect(validateBotPolicy(raw)).toEqual({ ok: true, policy: DEFAULT_BOT_POLICY });
  });

  it("returns independent mutable normalized values", () => {
    const first = normalizeBotPolicy(undefined);
    first.allowedFolders.push({ path: "/tmp/x", mode: "rw" });
    first.mcpAccess.servers.push("server");
    expect(normalizeBotPolicy(undefined)).toEqual(DEFAULT_BOT_POLICY);
    expect(Object.isFrozen(DEFAULT_BOT_POLICY.allowedFolders)).toBe(true);
  });

  it("roundtrips every UI field and preserves explicit unlimited caps", () => {
    const raw = {
      accessLevel: "ask", allowedFolders: [{ path: "/work/team", mode: "rw" }],
      allowComputerUse: true, allowLocalScripts: false, canStartNewThreads: true,
      mcpAccess: { mode: "denylist", servers: ["unsafe"] }, busyMessagePolicy: "side_task",
      notificationLevel: "all", fastMode: true, showPlanCard: false,
      memoryLimit: null, maxConcurrentTasks: null,
    };
    expect(validateBotPolicy(raw)).toEqual({ ok: true, policy: raw });
  });

  it.each([
    { label: "access enum", raw: { accessLevel: "admin" } },
    { label: "boolean", raw: { allowComputerUse: "yes" } },
    { label: "folder collection", raw: { allowedFolders: "/work" } },
    { label: "folder mode", raw: { allowedFolders: [{ path: "/work", mode: "execute" }] } },
    { label: "MCP mode", raw: { mcpAccess: { mode: "sometimes", servers: [] } } },
    { label: "MCP server list", raw: { mcpAccess: { mode: "allowlist", servers: [1] } } },
    { label: "busy message enum", raw: { busyMessagePolicy: "interrupt" } },
    { label: "notification enum", raw: { notificationLevel: false } },
    { label: "toggle type", raw: { fastMode: 1 } },
    { label: "resource type", raw: { memoryLimit: "10" } },
    { label: "top-level type", raw: 5 },
  ])("rejects invalid supplied $label", ({ raw }) => {
    expect(validateBotPolicy(raw).ok).toBe(false);
  });

  it("normalizes unknown or malformed fields to restrictive defaults", () => {
    expect(normalizeBotPolicy({ accessLevel: "admin", allowLocalScripts: 1, showPlanCard: "no" }))
      .toMatchObject({ accessLevel: "read_only", allowLocalScripts: false, showPlanCard: true });
  });
});

describe("resource caps", () => {
  it("clamps negative finite values while validation rejects them", () => {
    expect(normalizeBotPolicy({ memoryLimit: -1, maxConcurrentTasks: -1 }))
      .toMatchObject({ memoryLimit: 0, maxConcurrentTasks: 1 });
  });

  it("floors finite values and clamps them to UI limits", () => {
    expect(normalizeBotPolicy({ memoryLimit: 18.9, maxConcurrentTasks: 2.9 }))
      .toMatchObject({ memoryLimit: 18, maxConcurrentTasks: 2 });
    expect(normalizeBotPolicy({ memoryLimit: 20000, maxConcurrentTasks: 99 }))
      .toMatchObject({ memoryLimit: 10000, maxConcurrentTasks: 16 });
    expect(normalizeBotPolicy({ memoryLimit: 0, maxConcurrentTasks: 0 }))
      .toMatchObject({ memoryLimit: 0, maxConcurrentTasks: 1 });
  });

  it.each([
    { memoryLimit: -1 }, { maxConcurrentTasks: -1 }, { memoryLimit: Number.NaN },
    { maxConcurrentTasks: Number.POSITIVE_INFINITY },
  ])("rejects invalid resource caps: %o", (raw) => {
    expect(validateBotPolicy(raw).ok).toBe(false);
  });

  it("defaults malformed caps and preserves null as unlimited", () => {
    expect(normalizeBotPolicy({ memoryLimit: "12", maxConcurrentTasks: Number.NaN }))
      .toMatchObject({ memoryLimit: 1000, maxConcurrentTasks: 1 });
    expect(normalizeBotPolicy({ memoryLimit: null, maxConcurrentTasks: null }))
      .toMatchObject({ memoryLimit: null, maxConcurrentTasks: null });
  });

  it("validates finite caps after flooring and clamping", () => {
    expect(validateBotPolicy({ memoryLimit: 0.9, maxConcurrentTasks: 0 })).toMatchObject({
      ok: true, policy: { memoryLimit: 0, maxConcurrentTasks: 1 },
    });
    expect(validateBotPolicy({ memoryLimit: 20000, maxConcurrentTasks: 99 })).toMatchObject({
      ok: true, policy: { memoryLimit: 10000, maxConcurrentTasks: 16 },
    });
  });
});

describe("folder grants", () => {
  it("canonicalizes, trims, deduplicates with read-only winning, and drops unsafe grants", () => {
    const policy = normalizeBotPolicy({ allowedFolders: [
      { path: " /tmp/team/ ", mode: "rw" }, { path: "/tmp/team", mode: "ro" },
      { path: "/tmp/../private", mode: "rw" }, { path: "C:\\tmp\\..\\private", mode: "rw" },
      { path: "relative/path", mode: "rw" }, { path: "/tmp/a\0b", mode: "rw" }, { path: "   ", mode: "ro" },
    ] });
    expect(policy.allowedFolders).toEqual([{ path: "/tmp/team", mode: "ro" }]);
  });

  it.each(["relative/path", "/tmp/a/../private", "C:\\tmp\\..\\private", "/tmp/a\0b"])(
    "rejects unsafe grant path %s", (path) => {
      expect(validateBotPolicy({ allowedFolders: [{ path, mode: "ro" }] }).ok).toBe(false);
    },
  );

  it("checks exact paths and descendants with read/write modes and boundaries", () => {
    const policy = normalizeBotPolicy({ allowedFolders: [
      { path: "/work/team", mode: "ro" }, { path: "/work/shared", mode: "rw" },
    ] });
    expect(canAgentAccessFolder(policy, "/work/team", "ro")).toBe(true);
    expect(canAgentAccessFolder(policy, "/work/team/docs/file", "ro")).toBe(true);
    expect(canAgentAccessFolder(policy, "/work/team", "rw")).toBe(false);
    expect(canAgentAccessFolder(policy, "/work/shared/file", "rw")).toBe(true);
    expect(canAgentAccessFolder(policy, "/work/shared/file", "ro")).toBe(true);
    expect(canAgentAccessFolder(policy, "/work/teamwork/file", "ro")).toBe(false);
  });

  it.each(["relative", "/work/team/../private", "/work/team\0x", " /work/team"])(
    "denies unsafe or altered target path %s", (target) => {
      expect(canAgentAccessFolder(normalizeBotPolicy({
        allowedFolders: [{ path: "/work/team", mode: "rw" }],
      }), target, "ro")).toBe(false);
    },
  );

  it("supports absolute Windows drive and UNC paths lexically", () => {
    const policy = normalizeBotPolicy({ allowedFolders: [
      { path: "C:\\Work\\Team\\", mode: "rw" }, { path: "\\\\server\\share\\team", mode: "ro" },
    ] });
    expect(canAgentAccessFolder(policy, "C:\\Work\\Team\\docs", "rw")).toBe(true);
    expect(canAgentAccessFolder(policy, "\\\\server\\share\\team\\docs", "ro")).toBe(true);
  });

  it("deduplicates Windows case variants with read-only winning", () => {
    expect(normalizeBotPolicy({ allowedFolders: [
      { path: "C:\\Work\\Team", mode: "rw" }, { path: "c:\\work\\team\\", mode: "ro" },
    ] }).allowedFolders).toEqual([{ path: "C:\\Work\\Team", mode: "ro" }]);
  });
});

describe("MCP allow rules", () => {
  it("trims identifiers, deduplicates lists, and compares exact case-sensitive names", () => {
    const policy = normalizeBotPolicy({ mcpAccess: { mode: "allowlist", servers: [" GitHub ", "GitHub", " "] } });
    expect(policy.mcpAccess.servers).toEqual(["GitHub"]);
    expect(isMcpServerAllowed(policy, " GitHub ")).toBe(true);
    expect(isMcpServerAllowed(policy, "github")).toBe(false);
  });

  it("applies allow_all and denylist semantics while rejecting empty or null-byte IDs", () => {
    expect(isMcpServerAllowed(normalizeBotPolicy({ mcpAccess: { mode: "allow_all", servers: [] } }), "git"))
      .toBe(true);
    const deny = normalizeBotPolicy({ mcpAccess: { mode: "denylist", servers: ["unsafe"] } });
    expect(isMcpServerAllowed(deny, "unsafe")).toBe(false);
    expect(isMcpServerAllowed(deny, "safe")).toBe(true);
    expect(isMcpServerAllowed(deny, " ")).toBe(false);
    expect(isMcpServerAllowed(deny, "bad\0id")).toBe(false);
  });

  it.each([
    { mode: "denylist", servers: ["bad", 1] }, { mode: "denylist" },
    { mode: "denylist", servers: ["bad\0id"] }, { mode: "denylist", servers: [" "] },
  ])("turns malformed denylist config into deny-all: %o", (mcpAccess) => {
    const policy = normalizeBotPolicy({ mcpAccess });
    expect(policy.mcpAccess).toEqual({ mode: "allowlist", servers: [] });
    expect(isMcpServerAllowed(policy, "anything")).toBe(false);
  });

  it("is idempotent after canonical normalization", () => {
    const once = normalizeBotPolicy({
      allowedFolders: [{ path: "/work//team/.", mode: "rw" }],
      mcpAccess: { mode: "allowlist", servers: [" tool ", "tool"] }, memoryLimit: 1200.8,
    });
    expect(normalizeBotPolicy(once)).toEqual(once);
  });
});
