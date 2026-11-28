import { describe, expect, it } from "vitest";
import { parseDevinStdoutLine } from "../devin-local/parse-stdout";
import { buildTranscript, type RunLogChunk } from "../transcript";

const ts = "2026-11-28T12:00:00.000Z";
const laterTs = "2026-11-28T12:00:01.000Z";

describe("parseDevinStdoutLine edge cases", () => {
  it("strips ANSI CSI sequences from colored plain text lines", () => {
    const line = "\u001b[32mImplemented the requested change.\u001b[0m";

    expect(parseDevinStdoutLine(line, ts)).toEqual([
      { kind: "stdout", ts, text: "Implemented the requested change." },
    ]);
  });

  it("strips ANSI CSI sequences before classifying valid JSON event lines", () => {
    const json = JSON.stringify({ type: "text_delta", delta: "working" });
    const line = `\u001b[36m${json}\u001b[0m`;

    expect(parseDevinStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "working", delta: true },
    ]);
  });

  it("degrades truncated or malformed JSON lines to plain text without throwing", () => {
    const lines = [
      '{"type":"assistant","text":"truncated',
      '{"type":"tool_use"',
      "[not-json",
    ];

    for (const line of lines) {
      expect(() => parseDevinStdoutLine(line, ts)).not.toThrow();
      expect(parseDevinStdoutLine(line, ts)).toEqual([
        { kind: "stdout", ts, text: line },
      ]);
    }
  });

  it("returns no entries for empty or whitespace-only lines", () => {
    expect(parseDevinStdoutLine("", ts)).toEqual([]);
    expect(parseDevinStdoutLine(" \t  ", ts)).toEqual([]);
    expect(parseDevinStdoutLine("\u001b[31m \u001b[0m", ts)).toEqual([]);
  });

  it("parses nested tool_use and tool_result content blocks", () => {
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Checking the workspace." },
          { type: "tool_use", id: "toolu_1", name: "exec", input: { command: "ls" } },
        ],
      },
    });
    const userLine = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "file.ts" }],
            is_error: false,
          },
        ],
      },
    });

    expect(parseDevinStdoutLine(assistantLine, ts)).toEqual([
      { kind: "assistant", ts, text: "Checking the workspace." },
      { kind: "tool_call", ts, name: "exec", input: { command: "ls" }, toolUseId: "toolu_1" },
    ]);
    expect(parseDevinStdoutLine(userLine, ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "toolu_1", toolName: undefined, content: "file.ts", isError: false },
    ]);
  });

  it("parses multi-line stdout through the live transcript builder", () => {
    const firstDelta = JSON.stringify({ type: "text_delta", delta: "Hello" });
    const secondDelta = JSON.stringify({ type: "text_delta", delta: "again" });
    const chunks: RunLogChunk[] = [
      { ts, stream: "stdout", chunk: `${firstDelta}\n\u001b[32mplain line\u001b[0m\n` },
      { ts: laterTs, stream: "stdout", chunk: secondDelta },
    ];

    expect(buildTranscript(chunks, parseDevinStdoutLine)).toEqual([
      { kind: "assistant", ts, text: "Hello", delta: true },
      { kind: "stdout", ts, text: "plain line" },
      { kind: "assistant", ts: laterTs, text: "again", delta: true },
    ]);
  });
});
