import { describe, expect, it } from "vitest";
import { PaperworkEngineError } from "../services/paperwork-engine-client.js";
import {
  hasEngineCapability, probePaperworkEngineHealth,
  type PaperworkEngineHealthClient, type PaperworkEngineHealthProbe,
} from "../services/paperwork-engine-health.js";

/** Mirrors crates/paperwork-engine/src/lib.rs CAPABILITIES — the exact wire list. */
const CAPS = [
  "engine.health", "redactor.redact_text", "provider.check_blocklist",
  "provider.auth_probe_all", "provider.auth_plan_login", "quota.route",
  "heartbeat.validate_transition", "heartbeat.claim_wakeup",
  "heartbeat.transition_run_fenced", "heartbeat.list_stale_runs", "heartbeat.run_agent",
];
const HEALTHY_WIRE = { ok: true, engine: "paperwork-engine", protocol_version: 1, capabilities: CAPS };

/** Stub engine-health client: records callOpts, resolves/rejects the script. */
function stubHealth(script: () => Promise<unknown>) {
  const calls: ({ timeoutMs?: number } | undefined)[] = [];
  const client: PaperworkEngineHealthClient = {
    health: async (callOpts) => (calls.push(callOpts), script()),
  };
  return { client, calls };
}
const okStub = () => stubHealth(() => Promise.resolve(HEALTHY_WIRE));
const badStub = (wire: unknown) => stubHealth(() => Promise.resolve(wire));
const rejectStub = (e: unknown) => stubHealth(() => Promise.reject(e));

describe("probePaperworkEngineHealth", () => {
  it("returns the typed healthy result with the exact capabilities echoed", async () => {
    const { client, calls } = okStub();
    const probe = await probePaperworkEngineHealth({ engineClient: client });
    expect(probe.status).toBe("healthy");
    if (probe.status !== "healthy") return;
    expect(probe.engine).toBe("paperwork-engine");
    expect(probe.protocolVersion).toBe(1);
    expect(probe.capabilities).toEqual(CAPS);
    expect(probe.capabilities).not.toBe(CAPS); // defensive copy, not wire alias
    expect(Number.isInteger(probe.probedAt)).toBe(true);
    expect(probe.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(Number.isInteger(calls[0]?.timeoutMs)).toBe(true);
    expect(calls[0]?.timeoutMs).toBe(10_000); // default ~10s read timeout
  });

  it("degrades to protocol_error for every malformed wire shape, never throws", async () => {
    const malformed: unknown[] = [
      { ...HEALTHY_WIRE, engine: "other-engine" },
      { ...HEALTHY_WIRE, protocol_version: 2 },
      { ...HEALTHY_WIRE, capabilities: "engine.health" },
      { ...HEALTHY_WIRE, capabilities: ["engine.health", 7] },
      { ...HEALTHY_WIRE, ok: false },
      { ...HEALTHY_WIRE, ok: "yes" },
      null, [], "healthy",
    ];
    for (const wire of malformed) {
      const { client } = badStub(wire);
      const probe = await probePaperworkEngineHealth({ engineClient: client });
      expect(probe.status).toBe("degraded");
      if (probe.status !== "degraded") continue;
      expect(probe.reason).toBe("protocol_error");
      expect(probe.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("classifies PaperworkEngineError timeout as degraded/timeout", async () => {
    const { client } = rejectStub(new PaperworkEngineError("timeout", "call timed out after 10ms"));
    const probe = await probePaperworkEngineHealth({ engineClient: client });
    expect(probe).toMatchObject({ status: "degraded", reason: "timeout", errorKind: "timeout" });
  });

  it("classifies other PaperworkEngineError kinds as degraded/transport_error", async () => {
    for (const code of ["process_exited", "queue_full", "closed", "bin_not_configured"] as const) {
      const { client } = rejectStub(new PaperworkEngineError(code, `boom: ${code}`));
      const probe = await probePaperworkEngineHealth({ engineClient: client });
      expect(probe.status).toBe("degraded");
      if (probe.status !== "degraded") continue;
      expect(probe.reason).toBe("transport_error");
      expect(probe.errorKind).toBe(code);
      expect(probe.message).toBe(`boom: ${code}`);
    }
  });

  it("classifies engine protocol_error and rpc_error with errorKind/errorCode preserved", async () => {
    const { client } = rejectStub(new PaperworkEngineError("protocol_error", "bad envelope"));
    const probe = await probePaperworkEngineHealth({ engineClient: client });
    expect(probe).toMatchObject({ status: "degraded", reason: "protocol_error", errorKind: "protocol_error" });
    const rpc = rejectStub(new PaperworkEngineError("rpc_error", "invalid_params", -32602));
    const probe2 = await probePaperworkEngineHealth({ engineClient: rpc.client });
    expect(probe2).toMatchObject({
      status: "degraded", reason: "transport_error", errorKind: "rpc_error", errorCode: -32602,
    });
  });

  it("classifies a plain Error rejection as degraded/unknown, never throws", async () => {
    const { client } = rejectStub(new Error("socket exploded"));
    const probe = await probePaperworkEngineHealth({ engineClient: client });
    expect(probe.status).toBe("degraded");
    if (probe.status !== "degraded") return;
    expect(probe.reason).toBe("unknown");
    expect(probe.message).toBe("socket exploded");
    expect(probe.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns unavailable for a null client and for a throwing resolver", async () => {
    const probeNull = await probePaperworkEngineHealth({ engineClient: null });
    expect(probeNull.status).toBe("unavailable");
    expect(Number.isInteger(probeNull.probedAt)).toBe(true);
    const probeThrow = await probePaperworkEngineHealth({
      engineClient: () => {
        throw new Error("resolver exploded");
      },
    });
    expect(probeThrow.status).toBe("unavailable");
    const probeNullResolver = await probePaperworkEngineHealth({ engineClient: () => null });
    expect(probeNullResolver.status).toBe("unavailable");
  });

  it("clamps timeoutMs to a finite integer in [1, 600_000] forwarded to health()", async () => {
    const cases: [number | undefined, number][] = [
      [5.7, 5], [-3, 1], [0, 1], [10 ** 9, 600_000], [Number.NaN, 10_000],
      [Number.POSITIVE_INFINITY, 10_000], [42_000, 42_000],
    ];
    for (const [input, expected] of cases) {
      const { client, calls } = okStub();
      await probePaperworkEngineHealth({ engineClient: client, timeoutMs: input });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timeoutMs).toBe(expected);
      expect(Number.isInteger(calls[0]?.timeoutMs)).toBe(true);
    }
  });

  it("probes independently: a later probe does not reuse an earlier result", async () => {
    const first = await probePaperworkEngineHealth({ engineClient: okStub().client });
    const second = await probePaperworkEngineHealth({
      engineClient: rejectStub(new Error("down")).client,
    });
    expect(first.status).toBe("healthy");
    expect(second.status).toBe("degraded");
    const third = await probePaperworkEngineHealth({ engineClient: okStub().client });
    expect(third.status).toBe("healthy");
  });
});

describe("hasEngineCapability", () => {
  it("returns true for a listed method and false for unlisted methods", async () => {
    const { client } = okStub();
    const probe = await probePaperworkEngineHealth({ engineClient: client });
    expect(hasEngineCapability(probe, "redactor.redact_text")).toBe(true);
    expect(hasEngineCapability(probe, "engine.health")).toBe(true);
    expect(hasEngineCapability(probe, "heartbeat.run_agent")).toBe(true);
    expect(hasEngineCapability(probe, "workflow.sync")).toBe(false);
    expect(hasEngineCapability(probe, "redactor.redact_text ")).toBe(false); // exact match only
    expect(hasEngineCapability(probe, "")).toBe(false);
  });

  it("returns false for any non-healthy probe, absent capabilities, or non-string method", async () => {
    const degraded: PaperworkEngineHealthProbe = {
      status: "degraded", reason: "timeout", probedAt: 1, durationMs: 1,
    };
    const unavailable: PaperworkEngineHealthProbe = { status: "unavailable", probedAt: 1 };
    expect(hasEngineCapability(degraded, "engine.health")).toBe(false);
    expect(hasEngineCapability(unavailable, "engine.health")).toBe(false);
    const noCaps = { status: "healthy", engine: "paperwork-engine", protocolVersion: 1, probedAt: 1, durationMs: 1 } as unknown as PaperworkEngineHealthProbe;
    expect(hasEngineCapability(noCaps, "engine.health")).toBe(false);
    const { client } = okStub();
    const probe = await probePaperworkEngineHealth({ engineClient: client });
    for (const bad of [undefined, null, 7, {}, ["engine.health"]]) {
      expect(hasEngineCapability(probe, bad)).toBe(false);
    }
  });
});
