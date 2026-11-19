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

  it("distinguishes MODEL_CAPACITY_EXHAUSTED overload from spent plan quota on exit zero", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "\n\u26A0 No capacity available for model gemini-4-argon-medium (MODEL_CAPACITY_EXHAUSTED)",
        stderr: "",
        latestResponse: "\u26A0 No capacity available for model gemini-4-argon-medium (MODEL_CAPACITY_EXHAUSTED)",
      }),
    ).toEqual({
      errorMessage:
        "Antigravity model temporarily overloaded: No capacity available for model gemini-4-argon-medium (MODEL_CAPACITY_EXHAUSTED)",
      errorCode: "provider_overloaded",
    });

    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "\u26A0 Usage Limit Reached\n\nResets in 3h12m.",
        stderr: "",
        latestResponse: "Resets in 3h12m.",
      }),
    ).toEqual({
      errorMessage: "Antigravity provider quota exhausted: Usage Limit Reached Resets in 3h12m.",
      errorCode: "provider_quota_exhausted",
    });
  });

  it("detects inline exit-zero CLI warning, auth verification, session loss, MCP load, and invalid output failures", () => {
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "\n\u26A0 Agent Platform API has not been used in project 12345 before or it is disabled.",
        stderr: "",
        latestResponse: "\u26A0 Agent Platform API has not been used in project 12345 before or it is disabled.",
      }),
    ).toEqual({
      errorMessage: "Agent Platform API has not been used in project 12345 before or it is disabled.",
      errorCode: "adapter_failed",
    });

    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "\u26A0\uFE0F Verification Required\nPlease verify your account in your browser to continue.",
        stderr: "",
        latestResponse: "\u26A0\uFE0F Verification Required\nPlease verify your account in your browser to continue.",
      }),
    ).toEqual({
      errorMessage:
        "Antigravity account verification or authentication required: Verification Required Please verify your account in your browser to continue.",
      errorCode: "antigravity_auth_required",
    });

    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "Agent connection was lost and could not be re-established: websocket closed (1006)",
        stderr: "",
        latestResponse: "Agent connection was lost and could not be re-established: websocket closed (1006)",
      }),
    ).toEqual({
      errorMessage: "Agent connection was lost and could not be re-established: websocket closed (1006)",
      errorCode: "antigravity_session_lost",
    });

    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "\u26A0 The MCP server 'filesystem' failed to initialize: spawn npx ENOENT. Fix the MCP server.",
        stderr: "",
        latestResponse: "\u26A0 The MCP server 'filesystem' failed to initialize: spawn npx ENOENT. Fix the MCP server.",
      }),
    ).toEqual({
      errorMessage: "Antigravity MCP server 'filesystem' failed to initialize: spawn npx ENOENT. Fix the MCP server.",
      errorCode: "antigravity_mcp_load_failed",
    });

    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: "\u26A0 Model produced invalid output.",
        stderr: "",
        latestResponse: "\u26A0 Model produced invalid output.",
      }),
    ).toEqual({
      errorMessage: "Antigravity model produced invalid empty step output: Model produced invalid output.",
      errorCode: "antigravity_invalid_model_output",
    });
  });

  it("rejects answers that consist solely of unexecuted raw text tool calls", () => {
    const rawNs = ["default", "api"].join("_");
    const rawCallText = `${["call", rawNs, "run_command"].join(":")}{"CommandLine":"ls"}`;
    expect(
      resolveAntigravityFailure({
        exitCode: 0,
        timedOut: false,
        stdout: rawCallText,
        stderr: "",
        latestResponse: rawCallText,
      }),
    ).toEqual({
      errorMessage: "Antigravity model emitted an unexecuted text tool call instead of running the tool",
      errorCode: "antigravity_unexecuted_tool_call",
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
