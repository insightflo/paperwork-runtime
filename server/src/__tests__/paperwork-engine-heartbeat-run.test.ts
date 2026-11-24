import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  hasUnreapedChild, runHeartbeatAgent,
  type HeartbeatRunAgentParams, type HeartbeatRunAgentResult,
} from "../services/paperwork-engine-heartbeat-run.js";

const BASE: HeartbeatRunAgentParams = {
  adapter: "pi_local", executable: "/bin/sh", cwd: "/tmp", timeout_ms: 5_000,
};
const OK: HeartbeatRunAgentResult = {
  status: "succeeded", exit_code: 0, signal: null, error: null, error_code: null,
  unreaped_pid: null, stdout_excerpt: "out", stderr_excerpt: "",
  stdout_captured_bytes: 3, stderr_captured_bytes: 0,
};

/** Minimal PaperworkEngineClient stub: records calls (incl. callOpts), returns scripted result. */
function stub(result: unknown) {
  const calls: { method: string; params: unknown; callOpts?: { timeoutMs?: number } }[] = [];
  const client = {
    call: async (method: string, params?: unknown, callOpts?: { timeoutMs?: number }) => {
      calls.push({ method, params, callOpts });
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as PaperworkEngineClient;
  return { client, calls };
}
const run = (client: PaperworkEngineClient, p: Partial<HeartbeatRunAgentParams>) =>
  runHeartbeatAgent(client, { ...BASE, ...p });

describe("runHeartbeatAgent pre-send validation (fail-closed)", () => {
  it("rejects bad adapter/executable/args/env/cwd before any call", async () => {
    const s = stub(OK);
    const bad: Partial<HeartbeatRunAgentParams>[] = [
      { adapter: "bogus" as never }, { adapter: "pi" as never },
      { executable: "" }, { executable: "bin/sh" }, { executable: "/bin/sh\0x" },
      { args: ["a\0b"] }, { args: Array(1) }, { args: "x" as never }, { args: [1] as never },
      { env: { "": "v" } }, { env: { "K=V": "v" } }, { env: { "K\0": "v" } },
      { env: { K: "v\0" } }, { env: { K: 1 } as never }, { env: [] as never },
      { cwd: "" }, { cwd: "tmp" }, { cwd: "/tmp\0x" },
    ];
    for (const p of bad) await expect(run(s.client, p)).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });
  it("rejects out-of-range timeout_ms and grace_ms", async () => {
    const s = stub(OK);
    for (const timeout_ms of [0, -1, 3_600_001, Number.NaN, 1.5, "5" as never]) {
      await expect(run(s.client, { timeout_ms: timeout_ms as number })).rejects.toThrow(RangeError);
    }
    for (const grace_ms of [-1, 60_001, 1.5, Number.NaN]) {
      await expect(run(s.client, { grace_ms })).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(0);
  });
});

describe("runHeartbeatAgent wire contract", () => {
  it("sends heartbeat.run_agent with exactly the allowed fields (pi_local)", async () => {
    const s = stub(OK);
    const params = {
      ...BASE, args: ["-c", "exit 0"], env: { A: "1" }, grace_ms: 100, extra: "drop-me",
    } as unknown as HeartbeatRunAgentParams;
    await expect(runHeartbeatAgent(s.client, params)).resolves.toEqual(OK);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].method).toBe("heartbeat.run_agent");
    expect(s.calls[0].params).toEqual({
      adapter: "pi_local", executable: "/bin/sh", args: ["-c", "exit 0"],
      env: { A: "1" }, cwd: "/tmp", timeout_ms: 5_000, grace_ms: 100,
    });
    expect(hasUnreapedChild(OK)).toBe(false);
  });
  it("omits absent optionals on the wire (commandcode_local)", async () => {
    const s = stub(OK);
    await runHeartbeatAgent(s.client, { ...BASE, adapter: "commandcode_local" });
    expect(s.calls[0].params).toEqual({
      adapter: "commandcode_local", executable: "/bin/sh", cwd: "/tmp", timeout_ms: 5_000,
    });
  });
  it("maps non-zero exit, timed_out, and reap handoff results", async () => {
    const failed = { ...OK, status: "failed", exit_code: 9, error: "exited with code 9", error_code: "non_zero_exit" };
    await expect(run(stub(failed).client, {})).resolves.toEqual(failed);
    expect(hasUnreapedChild(failed as HeartbeatRunAgentResult)).toBe(false);
    const timed = { ...OK, status: "timed_out", exit_code: null, error: "process exceeded timeout", error_code: "timed_out" };
    await expect(run(stub(timed).client, {})).resolves.toEqual(timed);
    const handoff = { ...OK, status: "failed", error: "waitpid deadline expired", error_code: "reap_handoff_pending", unreaped_pid: 4242 };
    await expect(run(stub(handoff).client, {})).resolves.toEqual(handoff);
    expect(hasUnreapedChild(handoff as HeartbeatRunAgentResult)).toBe(true);
    // error_code alone also signals handoff ownership (defensive OR).
    expect(hasUnreapedChild({ ...OK, error_code: "reap_handoff_pending" })).toBe(true);
  });
  it("rejects malformed results with protocol_error", async () => {
    const badStatus = { ...OK, status: "bogus" };
    const noStderr = { ...OK } as Record<string, unknown>;
    delete noStderr.stderr_excerpt;
    const bad: unknown[] = [
      null, 42, "x", [], badStatus,
      { ...OK, exit_code: 1.5 }, { ...OK, signal: "SIGKILL" },
      { ...OK, unreaped_pid: 0 }, { ...OK, unreaped_pid: -1 }, { ...OK, unreaped_pid: 1.5 },
      { ...OK, stdout_captured_bytes: -1 }, { ...OK, stderr_captured_bytes: 2 ** 53 },
      { ...OK, stdout_excerpt: 7 }, noStderr, { ...OK, error: 5 }, { ...OK, error_code: [] },
    ];
    for (const result of bad) {
      await expect(run(stub(result).client, {})).rejects.toMatchObject({ code: "protocol_error" });
    }
  });
});

describe("runHeartbeatAgent transport timeout", () => {
  it("derives deadline from timeout_ms + grace_ms + 5s, clamped to client max", async () => {
    const s = stub(OK);
    await run(s.client, {}); // 5000 + default 5000 + 5000
    expect(s.calls[0].callOpts).toEqual({ timeoutMs: 15_000 });
    await run(s.client, { grace_ms: 100 }); // 5000 + 100 + 5000
    expect(s.calls[1].callOpts).toEqual({ timeoutMs: 10_100 });
    await run(s.client, { timeout_ms: 3_600_000, grace_ms: 60_000 }); // clamped
    expect(s.calls[2].callOpts).toEqual({ timeoutMs: 600_000 });
    await run(s.client, { timeout_ms: 1, grace_ms: 0 }); // 1 + 0 + 5000
    expect(s.calls[3].callOpts).toEqual({ timeoutMs: 5_001 });
  });
  it("forwards an explicit callOpts.timeoutMs and validates it", async () => {
    const s = stub(OK);
    await runHeartbeatAgent(s.client, BASE, { timeoutMs: 42 });
    expect(s.calls[0].callOpts).toEqual({ timeoutMs: 42 });
    for (const timeoutMs of [0, -1, 600_001, 1.5, Number.NaN]) {
      await expect(runHeartbeatAgent(s.client, BASE, { timeoutMs })).rejects.toThrow(RangeError);
    }
    expect(s.calls).toHaveLength(1);
  });
  it("propagates PaperworkEngineError from client.call untouched", async () => {
    const err = new PaperworkEngineError("timeout", "call timed out after 1ms");
    await expect(run(stub(err).client, {})).rejects.toBe(err);
    const rpc = new PaperworkEngineError("rpc_error", "invalid_params", -32602);
    await expect(run(stub(rpc).client, {})).rejects.toBe(rpc);
  });
});
