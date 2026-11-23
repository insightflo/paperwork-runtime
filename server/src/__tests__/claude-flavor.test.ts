import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripReservedDriverArgs } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const child = vi.hoisted(() => ({ queue: [] as RunProcessResult[], args: [] as string[][] }));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
      child.args.push([...args]);
      const next = child.queue.shift();
      if (!next) throw new Error("test queue exhausted");
      return next;
    }),
  };
});

import { execute } from "../../../packages/adapters/claude-local/src/server/execute.js";
import { claudeFlavor } from "../../../packages/adapters/claude-local/src/server/claude-flavor.js";

function proc(events: Record<string, unknown>[], exitCode = 0): RunProcessResult {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    stderr: "",
    pid: 4242,
    startedAt: "2026-11-23T00:00:00.000Z",
  };
}

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" });
const ok = (sessionId: string) => ({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  result: "done",
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
  total_cost_usd: 0.01,
});
const overloaded = (sessionId: string) => ({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  is_error: true,
  api_error_status: 529,
  result: "API Error: 529 overloaded",
});
const unknownSession = (sessionId: string) => ({
  type: "result",
  subtype: "error_during_execution",
  session_id: sessionId,
  is_error: true,
  result: `No conversation found with session ID ${sessionId}`,
});

function executeClaude(runtimeSessionId: string | null, config: Record<string, unknown> = {}) {
  return execute({
    runId: "claude-flavor-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: runtimeSessionId,
      sessionParams: runtimeSessionId ? { sessionId: runtimeSessionId, cwd: os.tmpdir() } : null,
      sessionDisplayId: runtimeSessionId,
      taskKey: null,
    },
    config: {
      command: process.execPath,
      cwd: os.tmpdir(),
      promptTemplate: "Continue.",
      overloadBackoffMs: 0,
      maxOverloadRetries: 0,
      ...config,
    },
    context: {},
    onLog: async () => {},
  });
}

describe("claudeFlavor argv parity", () => {
  beforeEach(() => {
    child.queue = [];
    child.args = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("declares the agent_text transport and reserved driver flags", () => {
    expect(claudeFlavor.protocolTransport).toBe("agent_text");
    expect(claudeFlavor.supportsSessionResume).toBe(true);
    expect(claudeFlavor.reservedArgs).toEqual(expect.arrayContaining(["--resume", "--model", "--disallowedTools"]));
    expect(stripReservedDriverArgs(["--model", "x", "--foo", "--resume=s"], claudeFlavor.reservedArgs ?? [])).toEqual(["--foo"]);
  });

  it("builds the same argv execute() passes to the child process", async () => {
    child.queue.push(proc([init("s-1"), ok("s-1")]));
    const config = {
      model: "claude-test-model",
      effort: "high",
      maxTurnsPerRun: 7,
      chrome: true,
      extraArgs: ["--custom-flag", "custom-value"],
    };
    await executeClaude(null, config);

    const executeArgs = child.args[0]!;
    const skillsDir = executeArgs[executeArgs.indexOf("--add-dir") + 1]!;
    const flavorArgs = claudeFlavor.buildArgs({
      command: process.execPath,
      prompt: "",
      resumeSessionId: null,
      model: "claude-test-model",
      effort: "high",
      maxTurns: 7,
      extraArgs: ["--custom-flag", "custom-value"],
      config: { ...config, skillsDir },
    });
    expect(flavorArgs).toEqual(executeArgs);
    expect(flavorArgs).toContain("--dangerously-skip-permissions");
    expect(claudeFlavor.reservedArgs).toContain("--model");
  });
});

describe("execute retry regression", () => {
  beforeEach(() => {
    child.queue = [];
    child.args = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("retries a 529 overload with the same session argv", async () => {
    child.queue.push(
      proc([init("s-resume"), overloaded("s-resume")]),
      proc([init("s-resume"), ok("s-resume")]),
    );
    const result = await executeClaude("s-resume", { maxOverloadRetries: 1 });

    expect(child.args).toHaveLength(2);
    expect(child.args[0]).toContain("--resume");
    expect(child.args[1]).toEqual(child.args[0]);
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("s-resume");
  });

  it("retries an unknown-session failure with a fresh session", async () => {
    child.queue.push(
      proc([init("stale-1"), unknownSession("stale-1")], 1),
      proc([init("s-fresh"), ok("s-fresh")]),
    );
    const result = await executeClaude("stale-1");

    expect(child.args).toHaveLength(2);
    expect(child.args[0]).toContain("--resume");
    expect(child.args[1]).not.toContain("--resume");
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("s-fresh");
    expect(result.clearSession).toBeFalsy();
  });
});
