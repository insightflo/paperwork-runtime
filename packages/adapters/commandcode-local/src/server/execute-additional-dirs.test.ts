import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";
import { SETTINGS_LOCAL_RELATIVE_PATH } from "./settings.js";
import { buildCtx, resultFrame, writeFakeCmd, type CapturePayload } from "./execute-fixtures.js";

/**
 * Wiring coverage for execute.ts -> settings.ts. The merge/write rules
 * themselves are covered in settings.test.ts; these tests only prove that a
 * headless run grants the configured directories before the child starts, and
 * that every skip path leaves the workspace and the run untouched.
 */

const OK_FRAME = { subtype: "success", finalText: "done", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };

type Fixture = {
  root: string;
  workspace: string;
  commandPath: string;
  capturePath: string;
  settingsPath: string;
  logs: string[];
};

async function withFixture(prefix: string, fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fn({
      root,
      workspace,
      commandPath: path.join(root, "cmd"),
      capturePath: path.join(root, "capture.json"),
      settingsPath: path.join(workspace, SETTINGS_LOCAL_RELATIVE_PATH),
      logs: [],
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function ctxFor(fx: Fixture, config: Record<string, unknown>, runtime?: Record<string, unknown>) {
  const ctx = {
    ...buildCtx(config, {
      command: fx.commandPath,
      cwd: fx.workspace,
      capture: fx.capturePath,
      runtime,
    }),
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      fx.logs.push(`${stream}:${chunk}`);
    },
  };
  return ctx;
}

/** Fake `cmd` that reports the project-local settings as seen at spawn time. */
async function writeSettingsReportingCmd(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const capturePath = process.env.ADAPTER_TEST_CAPTURE_PATH;
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify({ argv }), 'utf8');
const settingsPath = path.join(process.cwd(), ${JSON.stringify(SETTINGS_LOCAL_RELATIVE_PATH)});
const settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : 'MISSING';
console.log(JSON.stringify({ type: 'result', subtype: 'success', finalText: settings, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("commandcode execute — additionalDirectories wiring", () => {
  it("grants configured directories in settings.local.json before the headless run starts", async () => {
    await withFixture("cmd-exec-adddir-", async (fx) => {
      await writeSettingsReportingCmd(fx.commandPath);
      const result = await execute(
        ctxFor(fx, { additionalDirectories: ["/srv/shared/refs", "/srv/shared/refs", "  "] }),
      );
      expect(result.errorMessage).toBeNull();
      // The child observed the granted list at spawn time, i.e. the write preceded the spawn.
      expect(JSON.parse(result.summary ?? "{}")).toEqual({
        permissions: { additionalDirectories: ["/srv/shared/refs"] },
      });
      expect(await fs.readFile(fx.settingsPath, "utf8")).toBe(
        `${JSON.stringify({ permissions: { additionalDirectories: ["/srv/shared/refs"] } }, null, 2)}\n`,
      );
      // -p mode ignores --add-dir, so the adapter must not rely on the flag.
      const argv = (JSON.parse(await fs.readFile(fx.capturePath, "utf8")) as CapturePayload).argv;
      expect(argv).not.toContain("--add-dir");
      expect(fx.logs.join("")).toContain("Granted Command Code additionalDirectories");
    });
  });

  it("resolves relative entries against the workspace cwd", async () => {
    await withFixture("cmd-exec-adddir-rel-", async (fx) => {
      await writeFakeCmd(fx.commandPath, { lines: [resultFrame(OK_FRAME)] });
      await execute(ctxFor(fx, { additionalDirectories: ["../shared", 7, null, ""] }));
      expect(JSON.parse(await fs.readFile(fx.settingsPath, "utf8"))).toEqual({
        permissions: { additionalDirectories: [path.resolve(fx.workspace, "../shared")] },
      });
    });
  });

  it("does nothing when additionalDirectories is absent, empty, or not a string array", async () => {
    await withFixture("cmd-exec-adddir-none-", async (fx) => {
      await writeFakeCmd(fx.commandPath, { lines: [resultFrame(OK_FRAME)] });
      for (const config of [{}, { additionalDirectories: [] }, { additionalDirectories: "/srv/shared" }]) {
        const result = await execute(ctxFor(fx, config));
        expect(result.errorMessage).toBeNull();
        await expect(fs.stat(path.join(fx.workspace, ".commandcode"))).rejects.toThrow();
      }
      expect(fx.logs.filter((line) => line.includes("additionalDirectories"))).toEqual([]);
    });
  });

  it("merges into an existing settings file and keeps operator-authored keys", async () => {
    await withFixture("cmd-exec-adddir-merge-", async (fx) => {
      await writeFakeCmd(fx.commandPath, { lines: [resultFrame(OK_FRAME)] });
      await fs.mkdir(path.dirname(fx.settingsPath), { recursive: true });
      await fs.writeFile(
        fx.settingsPath,
        JSON.stringify({ theme: "dark", permissions: { deny: ["shell(rm)"], additionalDirectories: ["/a"] } }),
        "utf8",
      );
      await execute(ctxFor(fx, { additionalDirectories: ["/b"] }));
      expect(JSON.parse(await fs.readFile(fx.settingsPath, "utf8"))).toEqual({
        theme: "dark",
        permissions: { deny: ["shell(rm)"], additionalDirectories: ["/a", "/b"] },
      });
    });
  });

  it("does not rewrite the file when every directory is already granted", async () => {
    await withFixture("cmd-exec-adddir-noop-", async (fx) => {
      await writeFakeCmd(fx.commandPath, { lines: [resultFrame(OK_FRAME)] });
      await fs.mkdir(path.dirname(fx.settingsPath), { recursive: true });
      const original = '{"permissions":{"additionalDirectories":["/a"]}}\n';
      await fs.writeFile(fx.settingsPath, original, "utf8");
      const past = new Date("2020-01-01T00:00:00Z");
      await fs.utimes(fx.settingsPath, past, past);
      const before = await fs.stat(fx.settingsPath);

      await execute(ctxFor(fx, { additionalDirectories: ["/a"] }));

      expect(await fs.readFile(fx.settingsPath, "utf8")).toBe(original);
      const after = await fs.stat(fx.settingsPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(fx.logs.filter((line) => line.includes("additionalDirectories"))).toEqual([]);
    });
  });

  it("leaves an unparseable settings file untouched, warns, and still runs the command", async () => {
    await withFixture("cmd-exec-adddir-invalid-", async (fx) => {
      await writeFakeCmd(fx.commandPath, { lines: [resultFrame(OK_FRAME)] });
      await fs.mkdir(path.dirname(fx.settingsPath), { recursive: true });
      await fs.writeFile(fx.settingsPath, "{ not json", "utf8");

      const result = await execute(ctxFor(fx, { additionalDirectories: ["/a"] }));

      expect(result.errorMessage).toBeNull();
      expect(await fs.readFile(fx.settingsPath, "utf8")).toBe("{ not json");
      const warnings = fx.logs.filter((line) => line.startsWith("stderr:") && line.includes("additionalDirectories"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not read existing settings file");
    });
  });
});
