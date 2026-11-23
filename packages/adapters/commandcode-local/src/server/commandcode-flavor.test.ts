import { describe, expect, it } from "vitest";
import { stripReservedDriverArgs, type AcpFlavorBuildArgsInput } from "@paperclipai/adapter-utils";
import { buildCommandCodeArgs, commandcodeFlavor } from "./commandcode-flavor.js";
import { sessionCodec } from "./index.js";

const baseInput: AcpFlavorBuildArgsInput = {
  command: "cmd",
  prompt: "continue the heartbeat",
  resumeSessionId: null,
  model: "moonshotai/kimi-k2.5",
  effort: "high",
  maxTurns: 12,
  extraArgs: ["--verbose"],
  config: {},
};

describe("buildCommandCodeArgs", () => {
  it("produces the same argv as the previous inline execute builder", () => {
    expect(buildCommandCodeArgs(baseInput)).toEqual([
      "--skip-onboarding",
      "--permission-mode",
      "auto-accept",
      "--trust",
      "--output-format",
      "json",
      "--no-auto-update",
      "--model",
      "moonshotai/kimi-k2.5",
      "--effort",
      "high",
      "--max-turns",
      "12",
      "--verbose",
      "-p",
      "continue the heartbeat",
    ]);
  });

  it("emits --yolo and drops --permission-mode when dangerouslySkipPermissions is set", () => {
    const args = buildCommandCodeArgs({ ...baseInput, config: { dangerouslySkipPermissions: true } });
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--permission-mode");
  });

  it("keeps fresh and resume argv identical apart from the leading --resume pair", () => {
    const fresh = buildCommandCodeArgs(baseInput);
    const resumed = buildCommandCodeArgs({ ...baseInput, resumeSessionId: "sess-9" });
    expect(resumed.slice(0, 2)).toEqual(["--resume", "sess-9"]);
    expect(resumed.slice(2)).toEqual(fresh);
  });
});

describe("commandcodeFlavor", () => {
  it("declares the agent_text transport with session resume support", () => {
    expect(commandcodeFlavor.protocolTransport).toBe("agent_text");
    expect(commandcodeFlavor.supportsSessionResume).toBe(true);
  });

  it("reserves every flag the extraArgs sanitizer protects", () => {
    const expected = [
      "--output-format", "--model", "-m", "--effort", "--max-turns", "--resume", "-r",
      "--session", "--permission-mode", "--config", "-p", "--print", "--", "--trust",
      "-t", "--skip-onboarding", "--no-auto-update", "--continue", "-c", "--no-session",
      "--yolo", "--auto-accept", "--dangerously-skip-permissions", "--plan", "--fork-session",
    ];
    const reserved = new Set(commandcodeFlavor.reservedArgs ?? []);
    expect(reserved.size).toBe(expected.length);
    for (const flag of expected) expect(reserved.has(flag)).toBe(true);
    expect(stripReservedDriverArgs(["--resume", "evil", "--ok"], commandcodeFlavor.reservedArgs ?? [])).toEqual(["--ok"]);
  });
});

describe("sessionCodec", () => {
  it("is re-exported from the adapter server module as the flavor codec", () => {
    expect(sessionCodec).toBe(commandcodeFlavor.sessionCodec);
  });

  it("returns null for missing or malformed sessionParams", () => {
    for (const raw of [null, undefined, "sess", 7, ["sess"], {}, { sessionId: "  " }]) {
      expect(commandcodeFlavor.sessionCodec.deserialize(raw)).toBeNull();
    }
  });

  it("deserializes canonical and legacy key variants", () => {
    const codec = commandcodeFlavor.sessionCodec;
    expect(codec.deserialize({ sessionId: "a", cwd: "/w" })).toEqual({ sessionId: "a", cwd: "/w" });
    expect(codec.deserialize({ session_id: "b", workdir: "/w" })).toEqual({ sessionId: "b", cwd: "/w" });
    expect(codec.deserialize({ session: "c", folder: "/f" })).toEqual({ sessionId: "c", cwd: "/f" });
    expect(codec.deserialize({ sessionId: "d" })).toEqual({ sessionId: "d" });
  });
});
