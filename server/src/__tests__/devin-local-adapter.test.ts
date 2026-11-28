import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { getServerAdapter } from "../adapters/registry.js";
import { devinLocalAdapter } from "../adapters/devin-local/index.js";
import { DEVIN_LOCAL_MODELS } from "../adapters/devin-local/models.js";
import {
  buildDevinLocalArgs,
  devinLocalSessionCodec,
  isDevinLocalUnknownSessionError,
  parseDevinLocalOutput,
} from "../adapters/devin-local/parse.js";

describe("devin_local adapter models", () => {
  it("exposes the static Devin model choices", () => {
    expect(DEVIN_LOCAL_MODELS).toHaveLength(7);
    const ids = DEVIN_LOCAL_MODELS.map((model) => model.id);
    expect(ids).toContain("swe-2-flash-medium");
    expect(ids).toContain("swe-2-flash-high");
    expect(ids).toContain("swe-2-1-max");
  });

  it("registers devin_local as a shared adapter type", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("devin_local");
  });
});

describe("buildDevinLocalArgs", () => {
  it("builds a fresh non-interactive print-mode invocation", () => {
    expect(
      buildDevinLocalArgs({
        model: "swe-2-flash-medium",
        permissionMode: "dangerous",
        extraArgs: ["--sandbox"],
        prompt: "fix the failing tests",
      }),
    ).toEqual([
      "--model",
      "swe-2-flash-medium",
      "--process-model",
      "in-process",
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      "--sandbox",
      "-p",
      "fix the failing tests",
    ]);
  });

  it("places the resume flag before extra args and the print prompt", () => {
    expect(
      buildDevinLocalArgs({
        model: "swe-2-1-max",
        permissionMode: "accept-edits",
        sessionId: "session-123",
        extraArgs: ["--export", "/tmp/run.atif"],
        prompt: "continue",
      }),
    ).toEqual([
      "--model",
      "swe-2-1-max",
      "--process-model",
      "in-process",
      "--permission-mode",
      "accept-edits",
      "--respect-workspace-trust",
      "false",
      "-r",
      "session-123",
      "--export",
      "/tmp/run.atif",
      "-p",
      "continue",
    ]);
  });

  it("strips separate-form reserved flag overrides while preserving benign args", () => {
    expect(
      buildDevinLocalArgs({
        model: "swe-2-1-max",
        permissionMode: "dangerous",
        extraArgs: [
          "--verbose",
          "--respect-workspace-trust",
          "true",
          "--process-model",
          "out-of-process",
          "-p",
          "evil prompt",
          "-r",
          "evil-session",
          "--prompt",
          "evil prompt 2",
          "--resume",
          "evil-session-2",
          "--model",
          "evil-model",
          "--permission-mode",
          "never",
          "--max-turns",
          "10",
        ],
        prompt: "run the task",
      }),
    ).toEqual([
      "--model",
      "swe-2-1-max",
      "--process-model",
      "in-process",
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      "--verbose",
      "--max-turns",
      "10",
      "-p",
      "run the task",
    ]);
  });

  it("strips equals-form reserved flag overrides and the argument terminator", () => {
    expect(
      buildDevinLocalArgs({
        model: "swe-2-1-max",
        permissionMode: "dangerous",
        extraArgs: [
          "--process-model=out-of-process",
          "--respect-workspace-trust=true",
          "-p=evil prompt",
          "-r=evil-session",
          "--prompt=evil prompt",
          "--resume=evil-session",
          "--model=evil-model",
          "--permission-mode=never",
          "--",
          "--verbose",
        ],
        prompt: "run the task",
      }),
    ).toEqual([
      "--model",
      "swe-2-1-max",
      "--process-model",
      "in-process",
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      "--verbose",
      "-p",
      "run the task",
    ]);
  });

  it("drops empty, whitespace-only, and NUL-containing tokens", () => {
    expect(
      buildDevinLocalArgs({
        model: "swe-2-1-max",
        permissionMode: "dangerous",
        extraArgs: ["", "   ", "--verbose", "bad\0token", "--max-turns", "10", "\t"],
        prompt: "run the task",
      }),
    ).toEqual([
      "--model",
      "swe-2-1-max",
      "--process-model",
      "in-process",
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      "--verbose",
      "--max-turns",
      "10",
      "-p",
      "run the task",
    ]);
  });
});

describe("devinLocalSessionCodec", () => {
  it("round-trips sessionId and cwd", () => {
    const serialized = devinLocalSessionCodec.serialize({ sessionId: "session-1", cwd: "/tmp/work" });
    expect(serialized).toEqual({ sessionId: "session-1", cwd: "/tmp/work" });
    expect(devinLocalSessionCodec.deserialize(serialized)).toEqual({ sessionId: "session-1", cwd: "/tmp/work" });
    expect(devinLocalSessionCodec.getDisplayId?.(serialized)).toBe("session-1");
  });

  it("normalizes legacy session and folder keys", () => {
    expect(devinLocalSessionCodec.deserialize({ session: "legacy-1", folder: "/tmp/legacy" })).toEqual({
      sessionId: "legacy-1",
      cwd: "/tmp/legacy",
    });
    expect(devinLocalSessionCodec.serialize({ session_id: "legacy-2", workdir: "/tmp/legacy-2" })).toEqual({
      sessionId: "legacy-2",
      cwd: "/tmp/legacy-2",
    });
  });
});

describe("parseDevinLocalOutput", () => {
  it("uses trimmed plain-text output as the summary and returns zero usage by default", () => {
    const parsed = parseDevinLocalOutput("\nfinal answer\nsecond line\n");
    expect(parsed.summary).toBe("final answer\nsecond line");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });

  it("extracts the final text, session id, and usage from JSON output", () => {
    const parsed = parseDevinLocalOutput(
      '{"type":"result","session_id":"session-json","summary":"done","usage":{"inputTokens":10,"outputTokens":4,"cachedInputTokens":2}}\n',
    );
    expect(parsed.summary).toBe("done");
    expect(parsed.sessionId).toBe("session-json");
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 });
  });

  it("extracts a session id from a machine session line without adding it to the summary", () => {
    const parsed = parseDevinLocalOutput("Devin session: session-line\nanswer text\n");
    expect(parsed.sessionId).toBe("session-line");
    expect(parsed.summary).toBe("answer text");
  });

  it("detects unknown-session diagnostics on stderr without treating stdout prose as authority", () => {
    expect(isDevinLocalUnknownSessionError("", "Error: unknown session\n")).toBe(true);
    expect(isDevinLocalUnknownSessionError("The agent mentions an unknown session in its answer", "")).toBe(false);
  });
});

describe("devin_local registry", () => {
  it("returns the devinLocalAdapter from getServerAdapter", () => {
    expect(getServerAdapter("devin_local")).toBe(devinLocalAdapter);
  });
});
