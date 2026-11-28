import { describe, expect, it } from "vitest";
import {
  RESERVED_DEVIN_FLAGS,
  sanitizeDevinExtraArgs,
} from "../services/devin-cli-arg-guard.js";

describe("RESERVED_DEVIN_FLAGS", () => {
  it("lists every Devin CLI flag owned by Paperwork", () => {
    expect(RESERVED_DEVIN_FLAGS).toEqual([
      "--respect-workspace-trust",
      "--process-model",
      "-p",
      "--prompt",
      "-r",
      "--resume",
      "--model",
      "--permission-mode",
      "--",
    ]);
  });
});

describe("sanitizeDevinExtraArgs", () => {
  it("strips reserved flags supplied as separate flag/value pairs", () => {
    const result = sanitizeDevinExtraArgs([
      "--process-model",
      "out-of-process",
      "--verbose",
      "--model",
      "swe-2-1-max",
      "--max-turns",
      "12",
    ]);

    expect(result.safeArgs).toEqual(["--verbose", "--max-turns", "12"]);
    expect(result.strippedArgs).toEqual([
      "--process-model",
      "out-of-process",
      "--model",
      "swe-2-1-max",
    ]);
  });

  it("strips reserved flags supplied in equals form", () => {
    const result = sanitizeDevinExtraArgs([
      "--respect-workspace-trust=true",
      "--permission-mode=accept-edits",
      "--verbose",
    ]);

    expect(result.safeArgs).toEqual(["--verbose"]);
    expect(result.strippedArgs).toEqual([
      "--respect-workspace-trust=true",
      "--permission-mode=accept-edits",
    ]);
  });

  it("strips reserved short flags in separate, equals, and compact forms", () => {
    const result = sanitizeDevinExtraArgs([
      "-p",
      "override prompt",
      "--prompt=another prompt",
      "-r=session-equals",
      "-rsession-compact",
      "--resume",
      "session-separate",
    ]);

    expect(result.safeArgs).toEqual([]);
    expect(result.strippedArgs).toEqual([
      "-p",
      "override prompt",
      "--prompt=another prompt",
      "-r=session-equals",
      "-rsession-compact",
      "--resume",
      "session-separate",
    ]);
  });

  it("strips the argument terminator without treating later tokens as trusted", () => {
    const result = sanitizeDevinExtraArgs([
      "--verbose",
      "--",
      "--prompt=override",
      "--max-turns",
      "12",
    ]);

    expect(result.safeArgs).toEqual(["--verbose", "--max-turns", "12"]);
    expect(result.strippedArgs).toEqual(["--", "--prompt=override"]);
  });

  it("preserves benign flags and their values in original order", () => {
    const result = sanitizeDevinExtraArgs(["--verbose", "--max-turns", "12", "--export", "/tmp/run.atif"]);

    expect(result.safeArgs).toEqual(["--verbose", "--max-turns", "12", "--export", "/tmp/run.atif"]);
    expect(result.strippedArgs).toEqual([]);
  });

  it("drops empty, whitespace-only, and NUL-containing tokens", () => {
    const result = sanitizeDevinExtraArgs(["", "   ", "bad\0token", "--verbose", "\t"]);

    expect(result.safeArgs).toEqual(["--verbose"]);
    expect(result.strippedArgs).toEqual([]);
  });

  it("returns empty arrays for empty input", () => {
    expect(sanitizeDevinExtraArgs([])).toEqual({ safeArgs: [], strippedArgs: [] });
  });
});
