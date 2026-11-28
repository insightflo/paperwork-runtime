import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

type FakeMode = "settle" | "late-settle" | "no-settled" | "reject" | "noop";
type Capture = { argv: string[]; stdin: string; prompt: { type: string; id?: string; message?: string };
  promptCount: number; eof: boolean; events: string[]; stdinEndedWhenSettled?: boolean };

async function writeFakePiCommand(commandPath: string, mode: FakeMode): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--list-models')) { console.log('provider  model'); console.log('openai    gpt-4.1-mini'); process.exit(0); }
let input = '', started = false, eof = false, events = [];
const capturePath = process.env.ADAPTER_TEST_CAPTURE_PATH;
const launchPath = process.env.ADAPTER_TEST_LAUNCH_PATH;
function capture(extra = {}) {
  if (capturePath && !fs.existsSync(capturePath)) {
    const lines = input.split('\\n').filter(Boolean), prompt = JSON.parse(lines[0]);
    fs.writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), stdin: input, prompt,
      promptCount: lines.filter(line => JSON.parse(line).type === 'prompt').length, eof, events, ...extra }));
  }
}
function startAfterCompletePrompt() {
  const newline = input.indexOf('\\n');
  if (started || newline < 0) return;
  started = true;
  const prompt = JSON.parse(input.slice(0, newline));
  if (launchPath) fs.writeFileSync(launchPath, String(Number(fs.existsSync(launchPath) ? fs.readFileSync(launchPath, 'utf8') : '0') + 1));
  if (${JSON.stringify(mode)} === 'noop') { capture({ eof: false }); process.exit(0); }
  process.stdout.write(JSON.stringify({ type: 'response', id: prompt.id, command: 'prompt', success: ${mode === "reject" ? "false" : "true"}, error: { message: 'prompt rejected by fixture' } }) + '\\n');
  if (${JSON.stringify(mode)} === 'reject') return;
  setTimeout(() => {
    events.push('turn_end', 'agent_end');
    for (const event of events.slice(-2)) process.stdout.write(JSON.stringify({ type: event, willRetry: false,
      ...(event === 'turn_end' ? { message: { role: 'assistant', content: 'hello', usage: { output: 1 } } } : {}) }) + '\\n');
    if (${JSON.stringify(mode)} === 'settle') settle();
    if (${JSON.stringify(mode)} === 'late-settle') setTimeout(() => { events.push('continuation'); settle(); }, 1750);
    if (${JSON.stringify(mode)} === 'no-settled') setTimeout(() => capture({ eof: false }), 80);
  }, 30);
  function settle() {
    if (events.includes('agent_settled')) return;
    const stillOpen = !eof;
    events.push('agent_settled');
    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
    capture({ stdinEndedWhenSettled: !stillOpen });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; startAfterCompletePrompt(); });
process.stdin.on('end', () => { eof = true; capture({ eof: true }); process.exit(0); });
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type ExecuteCtx = Parameters<typeof execute>[0];
function buildCtx(opts: { command: string; cwd: string; capturePath: string; launchPath: string; timeoutSec?: number;
  onMeta?: ExecuteCtx["onMeta"] }): ExecuteCtx {
  return {
    runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Pi Coder", adapterType: "pi_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: opts.command, cwd: opts.cwd, env: { ADAPTER_TEST_CAPTURE_PATH: opts.capturePath, ADAPTER_TEST_LAUNCH_PATH: opts.launchPath },
      promptTemplate: "Follow the paperclip heartbeat.", provider: "openai", model: "openai/gpt-4.1-mini",
      ...(opts.timeoutSec === undefined ? {} : { timeoutSec: opts.timeoutSec }) },
    context: {
      paperclipStepInputManifest: { version: 1, taskKey: "issue:123", issueId: "issue-1", projectId: null,
        allowedContextKeys: ["issueId", "paperclipSessionHandoff"], guardrails: { broadScanAllowed: false },
        inputs: { workspace: { available: true, source: "project_primary", workspaceId: "ws-1", projectId: null },
          workspaceHints: { available: false, count: 0 }, runtimeServiceIntents: { available: false, count: 0 },
          runtimeServices: { available: false, count: 0 }, primaryUrl: null,
          sessionHandoff: { available: true, previousSessionId: "sess-1", rotationReason: "budget" } } },
      paperclipSessionHandoff: { version: 1, previousSessionId: "sess-1", previousRunId: "run-prev", issueId: "issue-1",
        rotationReason: "budget", lastRunSummaryText: "Last run summarized the issue state" },
      paperclipSessionHandoffMarkdown: "# raw handoff markdown should not appear",
    },
    authToken: undefined, onLog: async () => {}, onMeta: opts.onMeta ?? (async () => {}),
  };
}

async function prepare(mode: FakeMode, timeoutSec?: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
  const cwd = path.join(root, "workspace"), command = path.join(root, "pi"), capturePath = path.join(root, "capture.json");
  const launchPath = path.join(root, "launch-count");
  await fs.mkdir(cwd, { recursive: true }); await writeFakePiCommand(command, mode);
  return { root, capturePath, launchPath, ctx: buildCtx({ command, cwd, capturePath, launchPath, timeoutSec }) };
}

describe("pi execute", () => {
  it("delivers one framed prompt matching onMeta and waits for authoritative settle", async () => {
    let invocationPrompt = "";
    const { root, ctx, capturePath } = await prepare("settle");
    ctx.onMeta = async meta => { invocationPrompt = meta.prompt ?? ""; };
    try {
      const result = await execute(ctx), capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      expect(result.exitCode).toBe(0); expect(capture.prompt).toMatchObject({ type: "prompt", id: expect.any(String), message: invocationPrompt });
      expect(capture.stdin.endsWith("\n")).toBe(true); expect(capture.promptCount).toBe(1);
      expect(capture.argv).not.toContain(invocationPrompt); expect(capture.stdinEndedWhenSettled).toBe(false);
      expect(capture.events).toContain("agent_settled");
      expect(capture.prompt.message).toContain("Paperclip runtime brief:");
      expect(capture.prompt.message).toContain("Previous session: sess-1");
      expect(capture.prompt.message).not.toContain("# raw handoff markdown should not appear");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps stdin open through continuation after agent_end for more than 1.5 seconds", async () => {
    const { root, ctx, capturePath } = await prepare("late-settle");
    try {
      const result = await execute(ctx), capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      expect(result.exitCode).toBe(0); expect(capture.events).toContain("continuation");
      expect(capture.events).toContain("agent_settled"); expect(capture.stdinEndedWhenSettled).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("times out without EOF when an older Pi omits agent_settled", async () => {
    const { root, ctx, capturePath } = await prepare("no-settled", 2);
    try {
      const result = await execute(ctx), capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      // Deliberately fail boundedly: agent_end alone does not prove the RPC session is done.
      expect(result.timedOut).toBe(true); expect(capture.eof).toBe(false);
      expect(capture.events).toContain("agent_end"); expect(capture.events).not.toContain("agent_settled");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("surfaces a matching structured prompt rejection instead of waiting for EOF", async () => {
    const { root, ctx } = await prepare("reject", 2);
    try {
      const result = await execute(ctx);
      expect(result.exitCode).toBe(1); expect(result.errorMessage).toContain("prompt rejected by fixture");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("marks an output-free exit as pi_noop_stdin_eof without replaying or losing raw/session data", async () => {
    const { root, ctx, capturePath, launchPath } = await prepare("noop");
    try {
      const result = await execute(ctx), capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as Capture;
      expect(result.exitCode).toBe(1); expect(result.errorCode).toBe("pi_noop_stdin_eof");
      expect(result.errorMessage).toContain("without any assistant output");
      expect(result.resultJson).toMatchObject({ stdout: "", stderr: "" });
      expect(result.sessionId).toEqual(expect.any(String)); expect(capture.promptCount).toBe(1);
      expect(await fs.readFile(launchPath, "utf8")).toBe("1");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
