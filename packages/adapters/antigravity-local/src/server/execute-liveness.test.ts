import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import { execute, resolveAntigravityFailure } from "./execute.js";
import { startDiagnosticLogActivityMonitor } from "./runtime.js";

describe("antigravity_local liveness and failure detection", () => {
  it("fails closed when stdout is empty on exit zero even if stderr has text", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr:
          'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.',
        latestResponse: "",
      }),
    ).toEqual({
      errorMessage:
        'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.',
      errorCode: "adapter_failed",
    });
  });

  it("still prioritizes quota exhaustion in diagnostic logs when stdout is empty and stderr is non-empty", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "some warning",
        latestResponse: "",
        diagnosticLog: "RESOURCE_EXHAUSTED (code 429): quota reached",
      }),
    ).toEqual({
      errorMessage: "Antigravity provider quota exhausted: RESOURCE_EXHAUSTED (code 429): quota reached",
      errorCode: "provider_quota_exhausted",
    });
  });

  it("emits activity callbacks only while the diagnostic log file grows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-diag-monitor-"));
    const logPath = path.join(dir, "diag.log");
    const observedBytes: number[] = [];
    const stop = startDiagnosticLogActivityMonitor({
      logFilePath: logPath,
      intervalMs: 15,
      onActivity: async (bytes) => {
        observedBytes.push(bytes);
      },
    });
    try {
      await fs.writeFile(logPath, "step1\n", "utf8");
      await new Promise((r) => setTimeout(r, 45));
      await fs.appendFile(logPath, "step2-more-bytes\n", "utf8");
      await new Promise((r) => setTimeout(r, 45));
      const countAfterGrowth = observedBytes.length;
      await new Promise((r) => setTimeout(r, 45));
      expect(observedBytes.length).toBeGreaterThanOrEqual(2);
      expect(observedBytes.length).toBe(countAfterGrowth);
      expect(observedBytes[observedBytes.length - 1]).toBe(Buffer.byteLength("step1\nstep2-more-bytes\n"));
    } finally {
      await stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("registers child process under raw runId so server liveness checks find it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-runid-track-"));
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const command = path.join(binDir, "agy");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      command,
      `#!/usr/bin/env node
console.log("STARTED");
setTimeout(() => { console.log("DONE"); }, 80);
`,
      "utf8",
    );
    await fs.chmod(command, 0o755);

    const runId = `test-run-${Date.now()}`;
    let seenPid: number | undefined;
    let seenPrefixedEntry = false;
    try {
      const result = await execute({
        runId,
        agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "antigravity_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command, cwd },
        context: {},
        onLog: async (_stream, chunk) => {
          if (chunk.includes("STARTED")) {
            seenPid = runningProcesses.get(runId)?.child.pid;
            seenPrefixedEntry = runningProcesses.has(`antigravity-${runId}`);
          }
        },
      });
      expect(result.exitCode).toBe(0);
      expect(seenPid).toBeTypeOf("number");
      expect(seenPrefixedEntry).toBe(false);
      expect(runningProcesses.get(runId)).toBeUndefined();
      expect(runningProcesses.get(`antigravity-${runId}`)).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
