import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

async function writeFakeAgy(binDir: string): Promise<string> {
  const commandPath = path.join(binDir, "agy");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.AGY_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(process.argv.slice(2)), "utf8");
}
const mode = process.env.AGY_TEST_MODE || "pass";
if (mode === "fail_output") {
  console.log("UNEXPECTED_OUTPUT");
  process.exit(0);
}
if (mode === "fail_exit") {
  console.error("permission denied");
  process.exit(1);
}
console.log("AGY_SMOKE_OK");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function runEnvTest(
  configOverrides: Record<string, unknown>,
  mode = "pass",
): Promise<{
  result: Awaited<ReturnType<typeof testEnvironment>>;
  argv: string[];
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-env-"));
  const binDir = path.join(root, "bin");
  const cwd = path.join(root, "workspace");
  const capturePath = path.join(root, "capture.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const command = await writeFakeAgy(binDir);
  const existingEnv =
    typeof configOverrides.env === "object" && configOverrides.env !== null && !Array.isArray(configOverrides.env)
      ? (configOverrides.env as Record<string, unknown>)
      : {};
  try {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "antigravity_local",
      config: {
        command,
        cwd,
        ...configOverrides,
        env: {
          ...existingEnv,
          AGY_TEST_MODE: mode,
          AGY_TEST_CAPTURE_PATH: capturePath,
        },
      },
    });
    const argv = JSON.parse(await fs.readFile(capturePath, "utf8")) as string[];
    return { result, argv };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("antigravity_local environment diagnostics", () => {
  it("passes --dangerously-skip-permissions when dangerouslySkipPermissions is enabled", async () => {
    const { result, argv } = await runEnvTest({ dangerouslySkipPermissions: true });
    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "antigravity_hello_probe_passed")).toBe(true);
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--print-timeout");
    expect(argv[argv.indexOf("--print-timeout") + 1]).toBe("180s");
  });

  it("prefers dangerouslySkipPermissions=false over legacy bypassPermissions=true", async () => {
    const { result, argv } = await runEnvTest({
      dangerouslySkipPermissions: false,
      bypassPermissions: true,
    });
    expect(result.status).toBe("pass");
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  it("supports legacy bypassPermissions=true when dangerouslySkipPermissions is unset", async () => {
    const { result, argv } = await runEnvTest({ bypassPermissions: true });
    expect(result.status).toBe("pass");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  it("honors printTimeoutSec and extraArgs --print-timeout overrides without duplicating flags", async () => {
    const withSec = await runEnvTest({ printTimeoutSec: 300 });
    expect(withSec.argv[withSec.argv.indexOf("--print-timeout") + 1]).toBe("300s");

    const withExtra = await runEnvTest({ extraArgs: ["--print-timeout", "45s"] });
    const flagCount = withExtra.argv.filter((arg) => arg === "--print-timeout").length;
    expect(flagCount).toBe(1);
    expect(withExtra.argv[withExtra.argv.indexOf("--print-timeout") + 1]).toBe("45s");
  });

  it("warns when hello probe returns unexpected output or nonzero exit", async () => {
    const badOut = await runEnvTest({}, "fail_output");
    expect(badOut.result.status).toBe("warn");
    expect(badOut.result.checks.some((check) => check.code === "antigravity_hello_probe_failed")).toBe(true);

    const badExit = await runEnvTest({}, "fail_exit");
    expect(badExit.result.status).toBe("warn");
    expect(badExit.result.checks.some((check) => check.code === "antigravity_hello_probe_failed")).toBe(true);
  });
});
