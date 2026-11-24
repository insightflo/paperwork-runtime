import { describe, expect, it } from "vitest";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  isHeartbeatEngineShadowEnabled, maybeShadowValidateHeartbeatTransition,
  triggerShadowValidateHeartbeatTransition,
} from "../services/paperwork-engine-heartbeat-shadow.js";

const ON = { PAPERWORK_ENGINE_HEARTBEAT_SHADOW: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;
const RUN_ID = "11111111-1111-1111-1111-111111111111";
const INPUT = { runId: RUN_ID, expectedStatuses: ["queued"], nextStatus: "running", tsApplied: true };
const VALID = { valid: true, sets_started_at: true, sets_finished_at: false };
const ILLEGAL = { valid: false, reason: "illegal_transition", from: "succeeded", to: "running" };

type CallOnly = Pick<PaperworkEngineClient, "call">;

function makeLog() {
  const warns: { o: Record<string, unknown>; m: string }[] = [];
  const debugs: { o: Record<string, unknown>; m: string }[] = [];
  const log = {
    warn: (o: Record<string, unknown>, m: string) => void warns.push({ o, m }),
    debug: (o: Record<string, unknown>, m: string) => void debugs.push({ o, m }),
  };
  return { log, warns, debugs };
}

function stubCall(impl: () => Promise<unknown>) {
  const calls: { method: string; params: unknown }[] = [];
  const client: CallOnly = {
    call: (method: string, params?: unknown) => (calls.push({ method, params }), impl()),
  };
  return { client, calls };
}

describe("paperwork-engine heartbeat transition shadow", () => {
  it("flag gate: only '1' enables; OFF does zero async work and never touches the client", async () => {
    expect(isHeartbeatEngineShadowEnabled(ON)).toBe(true);
    expect(isHeartbeatEngineShadowEnabled(OFF)).toBe(false);
    expect(isHeartbeatEngineShadowEnabled({ PAPERWORK_ENGINE_HEARTBEAT_SHADOW: "true" } as NodeJS.ProcessEnv)).toBe(false);
    let gets = 0;
    const { client, calls } = stubCall(() => Promise.resolve(VALID));
    const deps = { env: OFF, getClient: () => (gets += 1, client) };
    triggerShadowValidateHeartbeatTransition(INPUT, deps);
    await maybeShadowValidateHeartbeatTransition(INPUT, deps);
    expect(gets).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("flag ON + null client: returns silently with no RPC, warn or debug", async () => {
    const { log, warns, debugs } = makeLog();
    const deps = { env: ON, getClient: () => null, log };
    await maybeShadowValidateHeartbeatTransition(INPUT, deps);
    await maybeShadowValidateHeartbeatTransition({ ...INPUT, expectedStatuses: [] }, deps);
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(0);
  });

  it("flag ON + legal match: engine valid -> 0 warns, snake_case RPC params", async () => {
    const { client, calls } = stubCall(() => Promise.resolve(VALID));
    const { log, warns } = makeLog();
    await maybeShadowValidateHeartbeatTransition(INPUT, { env: ON, getClient: () => client, log });
    expect(calls).toEqual([{
      method: "heartbeat.validate_transition",
      params: { expected_statuses: ["queued"], next_status: "running" },
    }]);
    expect(warns).toHaveLength(0);
  });

  it("flag ON + illegal mismatch + tsApplied: warns with runId/from/to", async () => {
    const { client } = stubCall(() => Promise.resolve(ILLEGAL));
    const { log, warns } = makeLog();
    await maybeShadowValidateHeartbeatTransition(
      { runId: RUN_ID, expectedStatuses: ["succeeded"], nextStatus: "running", tsApplied: true },
      { env: ON, getClient: () => client, log });
    expect(warns).toHaveLength(1);
    expect(warns[0].o).toMatchObject({
      runId: RUN_ID, nextStatus: "running", from: "succeeded", to: "running", reason: "illegal_transition",
    });
    expect(warns[0].m).toContain("contract mismatch");
  });

  it("flag ON + illegal mismatch + tsApplied=false: fenced-out write -> 0 warns", async () => {
    const { client } = stubCall(() => Promise.resolve(ILLEGAL));
    const { log, warns } = makeLog();
    await maybeShadowValidateHeartbeatTransition(
      { runId: RUN_ID, expectedStatuses: ["succeeded"], nextStatus: "running", tsApplied: false },
      { env: ON, getClient: () => client, log });
    expect(warns).toHaveLength(0);
  });

  it("flag ON + non-canonical status: debugs and never reaches the RPC", async () => {
    const { client, calls } = stubCall(() => Promise.resolve(VALID));
    const { log, warns, debugs } = makeLog();
    const deps = { env: ON, getClient: () => client, log };
    await maybeShadowValidateHeartbeatTransition(
      { runId: RUN_ID, expectedStatuses: ["bogus"], nextStatus: "running", tsApplied: true }, deps);
    await maybeShadowValidateHeartbeatTransition(
      { runId: RUN_ID, expectedStatuses: ["queued"], nextStatus: "bogus", tsApplied: true }, deps);
    expect(calls).toHaveLength(0);
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(2);
  });

  it("flag ON + RPC throws: fail-open — resolves, debugs classification, 0 warns", async () => {
    const { client } = stubCall(() => Promise.reject(new PaperworkEngineError("rpc_error", "unconfigured", -32002)));
    const { log, warns, debugs } = makeLog();
    await expect(maybeShadowValidateHeartbeatTransition(INPUT, { env: ON, getClient: () => client, log }))
      .resolves.toBeUndefined();
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(1);
    expect(debugs[0].o).toMatchObject({
      runId: RUN_ID, nextStatus: "running",
      classification: { kind: "unconfigured", outcome: "not_committed", retryable: false },
    });
  });

  it("trigger is fire-and-forget: a never-resolving RPC cannot block the caller", async () => {
    const calls: unknown[] = [];
    const client: CallOnly = { call: () => (calls.push(1), new Promise<never>(() => {})) };
    const { log, warns, debugs } = makeLog();
    let reached = false;
    triggerShadowValidateHeartbeatTransition(INPUT, { env: ON, getClient: () => client, log });
    reached = true; // unreachable if the trigger awaited the engine promise
    expect(reached).toBe(true);
    expect(calls).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(0);
  });
});
