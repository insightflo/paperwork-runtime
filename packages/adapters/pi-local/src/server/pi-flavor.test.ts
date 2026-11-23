import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";
import { buildPiArgs, piFlavor, type PiFlavorBuildArgsInput } from "./pi-flavor.js";

const baseInput = (overrides: Partial<PiFlavorBuildArgsInput> = {}): PiFlavorBuildArgsInput => ({
  command: "pi",
  prompt: "do work",
  resumeSessionId: null,
  model: "xai/grok-4",
  effort: "high",
  maxTurns: 0,
  extraArgs: [],
  config: {},
  provider: "xai",
  modelId: "grok-4",
  thinking: "high",
  systemPromptExtension: "SYS",
  skillsDir: "/skills",
  sessionFile: "/sessions/s1.jsonl",
  ...overrides,
});

const flagsOf = (args: string[]) => args.filter((arg) => arg.startsWith("--"));

describe("buildPiArgs", () => {
  it("emits flags in the expected order", () => {
    expect(buildPiArgs(baseInput())).toEqual([
      "--mode", "rpc",
      "--append-system-prompt", "SYS",
      "--provider", "xai",
      "--model", "grok-4",
      "--thinking", "high",
      "--tools", "read,bash,edit,write,grep,find,ls",
      "--session", "/sessions/s1.jsonl",
      "--skill", "/skills",
    ]);
  });

  it("keeps --tools/--skill at the tail with extraArgs appended last", () => {
    const args = buildPiArgs(baseInput({ extraArgs: ["--verbose", "--x=1"] }));
    expect(args.slice(-4)).toEqual(["--skill", "/skills", "--verbose", "--x=1"]);
    expect(args).toContain("--tools");
  });

  it("omits optional provider/model/thinking flags when unset", () => {
    const args = buildPiArgs(baseInput({ provider: null, modelId: null, thinking: "" }));
    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--thinking");
  });

  it("produces the same flag sequence for resume and fresh sessions", () => {
    const fresh = buildPiArgs(baseInput({ sessionFile: "/sessions/new.jsonl" }));
    const resumed = buildPiArgs(
      baseInput({ resumeSessionId: "/sessions/s1.jsonl", sessionFile: "/sessions/s1.jsonl" }),
    );
    expect(flagsOf(fresh)).toEqual(flagsOf(resumed));
    expect(resumed).toContain("/sessions/s1.jsonl");
  });
});

describe("sessionCodec", () => {
  const { deserialize, serialize, getDisplayId } = sessionCodec;

  it("returns null for missing or non-object sessionParams", () => {
    expect(deserialize(null)).toBeNull();
    expect(deserialize(undefined)).toBeNull();
    expect(deserialize("s1")).toBeNull();
    expect(deserialize([])).toBeNull();
    expect(deserialize({})).toBeNull();
  });

  it("returns null for malformed sessionParams", () => {
    expect(deserialize({ sessionId: 42 })).toBeNull();
    expect(deserialize({ sessionId: "   " })).toBeNull();
  });

  it("deserializes legacy session_id/session and workdir/folder keys", () => {
    expect(deserialize({ session_id: "s1", workdir: "/w" })).toEqual({ sessionId: "s1", cwd: "/w" });
    expect(deserialize({ session: "s2", folder: "/f" })).toEqual({ sessionId: "s2", cwd: "/f" });
    expect(deserialize({ sessionId: "s3" })).toEqual({ sessionId: "s3" });
  });

  it("serializes and reports display ids with the same legacy fallback", () => {
    expect(serialize(null)).toBeNull();
    expect(serialize({ session: "s", folder: "/f" })).toEqual({ sessionId: "s", cwd: "/f" });
    expect(getDisplayId?.({ session_id: "disp" })).toBe("disp");
    expect(getDisplayId?.(null)).toBeNull();
  });

  it("is the same codec instance exposed on piFlavor", () => {
    expect(sessionCodec).toBe(piFlavor.sessionCodec);
    expect(piFlavor.protocolTransport).toBe("agent_text");
    expect(piFlavor.reservedArgs).toContain("--session");
  });
});
