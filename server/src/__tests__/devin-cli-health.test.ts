import { describe, expect, it } from "vitest";
import { evaluateDevinCliHealth, parseDevinCliVersion } from "../services/devin-cli-health.js";

const FULL_HELP_OUTPUT = `
Usage: devin [options]

Options:
  -p, --prompt <prompt>              Run a headless prompt
  --respect-workspace-trust          Respect workspace trust settings
  --process-model <model>            Select the process model
  -r, --resume <session-id>          Resume an existing session
`;

describe("parseDevinCliVersion", () => {
  it("extracts a v-prefixed version from devin version output", () => {
    expect(parseDevinCliVersion("devin v3000.15.14\n")).toBe("3000.15.14");
  });

  it("extracts a bare version token", () => {
    expect(parseDevinCliVersion("3000.15.14")).toBe("3000.15.14");
  });

  it("returns null for invalid or empty output", () => {
    expect(parseDevinCliVersion("devin version unknown")).toBeNull();
    expect(parseDevinCliVersion("")).toBeNull();
  });
});

describe("evaluateDevinCliHealth", () => {
  it("reports a ready CLI when installed and all required flags are present", () => {
    const report = evaluateDevinCliHealth({
      versionOutput: "devin v3000.15.14",
      helpOutput: FULL_HELP_OUTPUT,
      exitCode: 0,
    });

    expect(report).toEqual({
      installed: true,
      version: "3000.15.14",
      supportsHeadlessPrompt: true,
      supportsWorkspaceTrustFlag: true,
      supportsInProcessModel: true,
      supportsSessionResume: true,
      readyForPaperwork: true,
      missingFlags: [],
    });
  });

  it("accepts long prompt and resume flags as support for the required capabilities", () => {
    const report = evaluateDevinCliHealth({
      versionOutput: "3000.15.14",
      helpOutput: `
        --prompt <prompt>
        --respect-workspace-trust
        --process-model <model>
        --resume <session-id>
      `,
      exitCode: 0,
    });

    expect(report.readyForPaperwork).toBe(true);
    expect(report.missingFlags).toEqual([]);
  });

  it("lists exact missing flags for a partially supported CLI", () => {
    const report = evaluateDevinCliHealth({
      versionOutput: "devin v3000.15.14",
      helpOutput: `
        -p, --prompt <prompt>
        --process-model <model>
      `,
      exitCode: 0,
    });

    expect(report.installed).toBe(true);
    expect(report.supportsHeadlessPrompt).toBe(true);
    expect(report.supportsWorkspaceTrustFlag).toBe(false);
    expect(report.supportsInProcessModel).toBe(true);
    expect(report.supportsSessionResume).toBe(false);
    expect(report.readyForPaperwork).toBe(false);
    expect(report.missingFlags).toEqual(["--respect-workspace-trust", "-r"]);
  });

  it("reports an uninstalled CLI when the exit code is non-zero", () => {
    const report = evaluateDevinCliHealth({
      versionOutput: "devin v3000.15.14",
      helpOutput: "",
      exitCode: 1,
    });

    expect(report.installed).toBe(false);
    expect(report.version).toBe("3000.15.14");
    expect(report.readyForPaperwork).toBe(false);
    expect(report.missingFlags).toEqual([
      "-p",
      "--respect-workspace-trust",
      "--process-model",
      "-r",
    ]);
  });

  it("reports an uninstalled CLI when no version can be parsed", () => {
    const report = evaluateDevinCliHealth({
      versionOutput: "not a devin version",
      helpOutput: FULL_HELP_OUTPUT,
      exitCode: 0,
    });

    expect(report.installed).toBe(false);
    expect(report.version).toBeNull();
    expect(report.readyForPaperwork).toBe(false);
    expect(report.missingFlags).toEqual([]);
  });
});
