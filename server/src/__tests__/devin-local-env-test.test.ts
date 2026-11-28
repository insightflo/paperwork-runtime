import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "../adapters/devin-local/test.js";

async function writeFakeDevinCommand(root: string): Promise<string> {
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });

  if (process.platform === "win32") {
    const commandPath = path.join(binDir, "devin.cmd");
    const script = [
      "@echo off",
      "if \"%~1\"==\"--version\" (",
      "  echo Devin CLI 3000.15.14",
      "  exit /b 0",
      ")",
      "if \"%~1\"==\"--help\" (",
      "  echo Usage: devin [options]",
      "  echo   -p, --print [PROMPT]  Print response and exit",
      "  exit /b 0",
      ")",
      "exit /b 0",
      "",
    ].join("\r\n");
    await fs.writeFile(commandPath, script, "utf8");
    return commandPath;
  }

  const commandPath = path.join(binDir, "devin");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    "  echo \"Devin CLI 3000.15.14\"",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"--help\" ]; then",
    "  echo \"Usage: devin [options]\"",
    "  echo \"  -p, --print [PROMPT]  Print response and exit\"",
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("devin_local environment diagnostics", () => {
  it("reports command, version, headless, and model diagnostics for a valid executable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devin-env-valid-"));

    try {
      const cwd = path.join(root, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const command = await writeFakeDevinCommand(root);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "devin_local",
        config: {
          command,
          cwd,
          model: "swe-2-flash-medium",
        },
      });

      expect(result.adapterType).toBe("devin_local");
      expect(["pass", "warn", "fail"]).toContain(result.status);
      expect(result.status).toBe("pass");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "devin_cwd_valid", level: "info" }),
          expect.objectContaining({ code: "devin_command_resolvable", level: "info" }),
          expect.objectContaining({ code: "devin_version_detected", level: "info" }),
          expect.objectContaining({ code: "devin_headless_ready", level: "info" }),
          expect.objectContaining({ code: "devin_model_selected", level: "info" }),
        ]),
      );
      const modelCheck = result.checks.find((check) => check.code === "devin_model_selected");
      expect(modelCheck?.message).toContain("swe-2-flash-medium");
      expect(modelCheck?.message).toContain("262K Free");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured failure without throwing when the command is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devin-env-missing-"));

    try {
      const cwd = path.join(root, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const command = path.join(root, "bin", "missing-devin");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "devin_local",
        config: {
          command,
          cwd,
          model: "swe-2-1-max",
        },
      });

      expect(["pass", "warn", "fail"]).toContain(result.status);
      expect(result.status).toBe("fail");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "devin_cwd_valid", level: "info" }),
          expect.objectContaining({ code: "devin_command_unresolvable", level: "error" }),
          expect.objectContaining({ code: "devin_model_selected", level: "info" }),
        ]),
      );
      expect(result.checks.some((check) => check.code.startsWith("devin_version"))).toBe(false);
      expect(result.checks.some((check) => check.code.startsWith("devin_headless"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("warns when the configured model is not in the known Devin model list", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-devin-env-model-"));

    try {
      const cwd = path.join(root, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const command = await writeFakeDevinCommand(root);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "devin_local",
        config: {
          command,
          cwd,
          model: "enterprise-custom-model",
        },
      });

      expect(result.status).toBe("warn");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "devin_model_selected", level: "info" }),
          expect.objectContaining({ code: "devin_model_unrecognized", level: "warn" }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
