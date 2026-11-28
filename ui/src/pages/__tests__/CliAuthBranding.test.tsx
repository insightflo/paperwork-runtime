import { describe, expect, it } from "vitest";
import { displayCliCommand } from "../CliAuth";

describe("displayCliCommand", () => {
  it("normalizes the paperclipai binary to paperwork", () => {
    expect(displayCliCommand("paperclipai auth login")).toBe("paperwork auth login");
  });

  it("normalizes the legacy paperclip binary to paperwork", () => {
    expect(displayCliCommand("paperclip auth login")).toBe("paperwork auth login");
  });

  it("preserves commands that do not start with a legacy binary", () => {
    expect(displayCliCommand("paperwork auth login")).toBe("paperwork auth login");
    expect(displayCliCommand("npm exec paperclipai auth login")).toBe("npm exec paperclipai auth login");
  });

  it("handles missing commands", () => {
    expect(displayCliCommand(null)).toBe("");
    expect(displayCliCommand(undefined)).toBe("");
  });
});
