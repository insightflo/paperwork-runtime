import { describe, expect, it } from "vitest";
import {
  devinLocalSessionCodec,
  isDevinLocalUnknownSessionError,
  parseDevinLocalOutput,
} from "../adapters/devin-local/parse.js";

describe("devinLocalSessionCodec contract", () => {
  it("round-trips trimmed session ids and cwd values", () => {
    const serialized = devinLocalSessionCodec.serialize({
      sessionId: "  session-abc  ",
      cwd: "  /tmp/project  ",
      ignored: true,
    });

    expect(serialized).toEqual({ sessionId: "session-abc", cwd: "/tmp/project" });
    expect(devinLocalSessionCodec.deserialize(serialized)).toEqual({
      sessionId: "session-abc",
      cwd: "/tmp/project",
    });
  });

  it("normalizes alias keys during serialization and deserialization", () => {
    expect(
      devinLocalSessionCodec.serialize({
        session_id: "snake-session",
        workdir: "/tmp/snake",
      }),
    ).toEqual({ sessionId: "snake-session", cwd: "/tmp/snake" });
    expect(
      devinLocalSessionCodec.deserialize({
        session: "legacy-session",
        folder: "/tmp/legacy",
      }),
    ).toEqual({ sessionId: "legacy-session", cwd: "/tmp/legacy" });
  });

  it("rejects invalid, null, and empty session params", () => {
    expect(devinLocalSessionCodec.serialize(null)).toBeNull();
    expect(devinLocalSessionCodec.serialize({})).toBeNull();
    expect(devinLocalSessionCodec.serialize({ sessionId: "   " })).toBeNull();
    expect(devinLocalSessionCodec.deserialize(null)).toBeNull();
    expect(devinLocalSessionCodec.deserialize("session-abc")).toBeNull();
    expect(devinLocalSessionCodec.deserialize(["session-abc"])).toBeNull();
    expect(devinLocalSessionCodec.deserialize({ session: 42 })).toBeNull();
  });

  it("extracts display IDs with the same key precedence as serialization", () => {
    expect(devinLocalSessionCodec.getDisplayId?.(null)).toBeNull();
    expect(
      devinLocalSessionCodec.getDisplayId?.({
        sessionId: "primary-session",
        session_id: "secondary-session",
        session: "legacy-session",
      }),
    ).toBe("primary-session");
    expect(devinLocalSessionCodec.getDisplayId?.({ session_id: "  secondary-session  " })).toBe(
      "secondary-session",
    );
    expect(devinLocalSessionCodec.getDisplayId?.({ session: "legacy-session" })).toBe("legacy-session");
    expect(devinLocalSessionCodec.getDisplayId?.({})).toBeNull();
  });
});

describe("isDevinLocalUnknownSessionError contract", () => {
  it("recognizes unknown, expired, and unresumable session diagnostics", () => {
    const diagnostics = [
      "Error: unknown session abc123",
      "Error: session expired",
      "Error: could not resume session",
      "\u001B[31mError: unknown session abc123\u001B[0m",
    ];

    for (const stderr of diagnostics) {
      expect(isDevinLocalUnknownSessionError("", stderr)).toBe(true);
    }
  });

  it("rejects ordinary errors and stdout-only unknown-session prose", () => {
    expect(isDevinLocalUnknownSessionError("", "Error: command failed")).toBe(false);
    expect(isDevinLocalUnknownSessionError("", "Error: session timeout waiting for output")).toBe(false);
    expect(isDevinLocalUnknownSessionError("The answer mentions an unknown session", "")).toBe(false);
  });
});

describe("parseDevinLocalOutput contract", () => {
  it("strips ANSI escape codes before parsing plain-text output", () => {
    const parsed = parseDevinLocalOutput(
      "\u001B[32mdevin session: ansi-session\u001B[0m\n\u001B[36mhello world\u001B[0m\n",
    );

    expect(parsed.sessionId).toBe("ansi-session");
    expect(parsed.summary).toBe("hello world");
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });

  it("accumulates JSON usage blocks including cached input tokens", () => {
    const parsed = parseDevinLocalOutput(
      [
        '{"session_id":"json-session","usage":{"inputTokens":10,"outputTokens":2,"cachedInputTokens":3}}',
        '{"result":{"usage":{"input_tokens":4,"output_tokens":5,"cached_input_tokens":6}}}',
        '{"message":{"usage":{"input":7,"output":8,"cacheRead":9}},"summary":"usage complete"}',
      ].join("\n"),
    );

    expect(parsed.sessionId).toBe("json-session");
    expect(parsed.summary).toBe("usage complete");
    expect(parsed.usage).toEqual({ inputTokens: 21, outputTokens: 15, cachedInputTokens: 18 });
  });

  it("extracts plain-text session lines without adding them to the summary", () => {
    const parsed = parseDevinLocalOutput("session_id=plain-session\nresult text\n[adapter] noise\n");

    expect(parsed.sessionId).toBe("plain-session");
    expect(parsed.summary).toBe("result text");
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });
});
