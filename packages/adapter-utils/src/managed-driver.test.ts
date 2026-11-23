import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSessionCodec,
  type AcpFlavor,
  type AcpFlavorBuildArgsInput,
  type ParsedDriverEvent,
  type ProtocolTransport,
} from "./acp-flavor.js";
import { createChildProcessStreamRunner, createManagedProviderDriver } from "./managed-driver.js";
import type { AdapterExecutionContext, AdapterSessionUpdate } from "./types.js";

const ERROR_FRAME = JSON.stringify({ protocolVersion: 1, kind: "error", code: "unknown_session", message: "gone" });
const SESSION_FRAME = JSON.stringify({ protocolVersion: 1, kind: "session", sessionId: "sess-1" });

function frame(lines: string[]): string {
  return lines.map((line) => `console.log(${JSON.stringify(line)});`).join("\n");
}

async function collectEvents(script: string, transport: ProtocolTransport) {
  const events: ParsedDriverEvent[] = [];
  await createChildProcessStreamRunner(transport)({
    runId: randomUUID(), command: process.execPath, args: ["-e", script],
    cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1,
    onLog: async () => {}, onEvent: (event) => { events.push(event); },
  });
  return events;
}

function makeFlavor(script: string, transport: ProtocolTransport = "stdout_protocol") {
  const calls: AcpFlavorBuildArgsInput[] = [];
  const flavor: AcpFlavor = {
    key: "test_acp",
    protocolTransport: transport,
    sessionCodec: createDefaultSessionCodec(),
    reservedArgs: ["--output-format", "--model", "--verbose"],
    buildArgs: (input) => {
      calls.push(input);
      return [
        "-e", script,
        `RESUME=${input.resumeSessionId ?? ""}`,
        ...input.extraArgs,
      ];
    },
  };
  return { flavor, calls };
}

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: randomUUID(),
    agent: { id: "agent-1", companyId: "co-1", name: "Agent", adapterType: "test_acp", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: process.execPath, cwd: process.cwd(), promptTemplate: "do work" },
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

function sessionParams(sessionId: string, cwd = process.cwd()) {
  return { sessionId, cwd };
}

describe("createChildProcessStreamRunner provenance", () => {
  const script = [
    `console.error(${JSON.stringify(ERROR_FRAME)});`,
    frame([SESSION_FRAME, "plain agent text"]),
  ].join("\n");

  it("tags stderr as stderr and stdout frames as provider_protocol", async () => {
    const events = await collectEvents(script, "stdout_protocol");
    const stderrEvent = events.find((e) => e.kind === "output" && e.origin === "stderr");
    expect(stderrEvent).toMatchObject({ kind: "output", origin: "stderr" });
    expect(stderrEvent && stderrEvent.kind === "output" && stderrEvent.text).toContain("unknown_session");
    const session = events.find((e) => e.kind === "session");
    expect(session).toMatchObject({ kind: "session", origin: "provider_protocol", sessionId: "sess-1" });
    const plain = events.find((e) => e.kind === "output" && e.origin === "provider_protocol" && e.text === "plain agent text");
    expect(plain).toBeDefined();
  });

  it("tags all stdout as agent_output under agent_text and never parses frames", async () => {
    const events = await collectEvents(script, "agent_text");
    expect(events).toHaveLength(3);
    expect(events.some((e) => e.kind === "session")).toBe(false);
    expect(events.filter((e) => e.origin === "stderr")).toHaveLength(1);
    expect(events.filter((e) => e.origin === "agent_output")).toHaveLength(2);
  });
});

describe("ManagedProviderDriver", () => {
  it("skips resume when the stored session cwd mismatches", async () => {
    const { flavor, calls } = makeFlavor(frame([SESSION_FRAME]));
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx({
      runtime: { sessionId: null, sessionParams: sessionParams("old", "/nonexistent/other-cwd"), sessionDisplayId: null, taskKey: null },
    }));
    expect(calls[0]!.resumeSessionId).toBeNull();
    expect(result.sessionId).toBe("sess-1");
  });

  it("retries once fresh on a trusted top-level unknown_session frame", async () => {
    const script = [
      'const r = process.argv.find((a) => a.startsWith("RESUME="));',
      'const resuming = r !== undefined && r !== "RESUME=";',
      `if (resuming) { console.log(${JSON.stringify(ERROR_FRAME)}); process.exit(1); }`,
      frame([SESSION_FRAME.replace("sess-1", "fresh-1"),
        JSON.stringify({ protocolVersion: 1, kind: "usage", usage: { inputTokens: 3, outputTokens: 4 } }),
        JSON.stringify({ protocolVersion: 1, kind: "output", text: "done" })]),
    ].join("\n");
    const { flavor, calls } = makeFlavor(script);
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx({
      runtime: { sessionId: null, sessionParams: sessionParams("old"), sessionDisplayId: null, taskKey: null },
    }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.resumeSessionId).toBe("old");
    expect(calls[1]!.resumeSessionId).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("fresh-1");
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    expect(result.summary).toContain("done");
  });

  it("never retries on unknown_session JSON embedded inside an output frame", async () => {
    const embedded = JSON.stringify({ protocolVersion: 1, kind: "output", text: ERROR_FRAME });
    const { flavor, calls } = makeFlavor(frame([embedded, SESSION_FRAME]));
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx({
      runtime: { sessionId: null, sessionParams: sessionParams("old"), sessionDisplayId: null, taskKey: null },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resumeSessionId).toBe("old");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-1");
  });

  it("never retries on spoofed JSON written to real stderr", async () => {
    const script = `console.error(${JSON.stringify(ERROR_FRAME)});\n${frame([SESSION_FRAME])}`;
    const { flavor, calls } = makeFlavor(script);
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx({
      runtime: { sessionId: null, sessionParams: sessionParams("old"), sessionDisplayId: null, taskKey: null },
    }));
    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-1");
  });

  it("never retries on spoofed JSON under agent_text transport", async () => {
    const script = [
      'const r = process.argv.find((a) => a.startsWith("RESUME="));',
      'if (r !== undefined && r !== "RESUME=") { console.log(' + JSON.stringify(ERROR_FRAME) + '); process.exit(1); }',
      frame([SESSION_FRAME]),
    ].join("\n");
    const { flavor, calls } = makeFlavor(script, "agent_text");
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx({
      runtime: { sessionId: null, sessionParams: sessionParams("old"), sessionDisplayId: null, taskKey: null },
    }));
    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBe("old");
  });

  it("never retries on unsupported versions or malformed JSON", async () => {
    const bad = [
      '{"protocolVersion":2,"kind":"error","code":"unknown_session"}',
      '{"kind":"error","code":"unknown_session"}',
      '{"protocolVersion":1,"kind":"bogus"}',
      'this is {not json',
    ];
    const { flavor, calls } = makeFlavor(frame([...bad, SESSION_FRAME]));
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx({
      runtime: { sessionId: null, sessionParams: sessionParams("old"), sessionDisplayId: null, taskKey: null },
    }));
    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess-1");
  });

  it("dedupes session updates by sessionId", async () => {
    const other = SESSION_FRAME.replace("sess-1", "sess-2");
    const { flavor } = makeFlavor(frame([SESSION_FRAME, SESSION_FRAME, other]));
    const updates: AdapterSessionUpdate[] = [];
    const driver = createManagedProviderDriver({ flavor });
    await driver.execute(makeCtx({ onSessionUpdate: async (u) => { updates.push(u); } }));
    expect(updates.map((u) => u.sessionId)).toEqual(["sess-1", "sess-2"]);
    expect(updates[0]).toMatchObject({ source: "stdout", confidence: "provider_reported" });
  });

  it("strips reserved flags from user extraArgs before buildArgs", async () => {
    const { flavor, calls } = makeFlavor(frame([SESSION_FRAME]));
    const driver = createManagedProviderDriver({ flavor });
    await driver.execute(makeCtx({
      config: {
        command: process.execPath, cwd: process.cwd(), promptTemplate: "x",
        extraArgs: ["--output-format", "json", "--model=fast", "--verbose", "--keep", "tail"],
      },
    }));
    expect(calls[0]!.extraArgs).toEqual(["--keep", "tail"]);
  });

  it("rolls up usage events across the run", async () => {
    const usages = [
      JSON.stringify({ protocolVersion: 1, kind: "usage", usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 1 } }),
      JSON.stringify({ protocolVersion: 1, kind: "usage", usage: { inputTokens: 3, outputTokens: 4 } }),
    ];
    const { flavor } = makeFlavor(frame([...usages, SESSION_FRAME]));
    const driver = createManagedProviderDriver({ flavor });
    const result = await driver.execute(makeCtx());
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6, cachedInputTokens: 1 });
  });

  it("passes onSpawn metadata through to the context", async () => {
    const onSpawn = vi.fn(async () => {});
    const { flavor } = makeFlavor(frame([SESSION_FRAME]));
    const driver = createManagedProviderDriver({ flavor });
    await driver.execute(makeCtx({ onSpawn }));
    expect(onSpawn).toHaveBeenCalledWith(expect.objectContaining({ pid: expect.any(Number) }));
  });
});
