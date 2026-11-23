import { describe, expect, it, vi } from "vitest";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  QUOTA_ROUTE_VERDICTS, routeQuotaWithEngine, type QuotaRouteRequest,
} from "../services/quota-router-engine-client.js";

const okResp = () => ({
  selected: { provider: "claude", model: "opus" }, reason: "eligible",
  tried: [{ provider: "claude", model: "opus", reason: "eligible" }],
  earliest_reset_epoch_ms: null,
});
const req = (): QuotaRouteRequest => ({
  primary: { provider: "claude", model: "opus" },
  backup_order: [{ provider: "codex", model: "gpt" }],
  quotas: [{ provider: "claude", model: "opus", observed_at_epoch_ms: 900,
    stale_after_ms: 1000, remaining_pct: 80, hard_limited: true, resets_at_epoch_ms: 5_000 }],
  now_epoch_ms: 1000, min_remaining_pct: 50, allow_unknown_quota: true,
});

function fake(result: unknown = okResp()) {
  const call = vi.fn(async () => result);
  const getClient = vi.fn(() => ({ call }) as unknown as PaperworkEngineClient);
  return { call, getClient, deps: { getClient } };
}
const noInput = { ok: false, kind: "invalid_input" } as const;
const noResp = { ok: false, kind: "invalid_response" } as const;
const noEngine = { ok: false, kind: "engine_unavailable" } as const;

describe("routeQuotaWithEngine", () => {
  it("exports the closed 8-verdict vocabulary matching quota-router", () => {
    expect(QUOTA_ROUTE_VERDICTS).toEqual([
      "unknown_quota", "future_timestamp", "stale", "invalid_remaining_pct",
      "hard_limited", "below_threshold", "eligible", "invalid_threshold",
    ]);
  });

  it("happy path: quota.route gets a copied snapshot, fresh result returned", async () => {
    const resp = okResp();
    const { call, deps } = fake(resp);
    const input = req();
    const out = await routeQuotaWithEngine(input, deps);
    expect(out).toEqual({ ok: true, result: resp });
    expect(call).toHaveBeenCalledTimes(1);
    const [method, params] = call.mock.calls[0] as [string, QuotaRouteRequest];
    expect(method).toBe("quota.route");
    expect(params).toEqual(input);
    expect(params).not.toBe(input);
    expect(params.quotas).not.toBe(input.quotas);
    expect(params.quotas[0]).not.toBe(input.quotas[0]);
    if (out.ok) {
      expect(out.result).not.toBe(resp);
      expect(out.result.tried).not.toBe(resp.tried);
    }
  });

  it("failover + exhausted: tried audit trail and earliest reset passthrough", async () => {
    const failover = {
      selected: { provider: "codex", model: "gpt" }, reason: "eligible",
      tried: [{ provider: "claude", model: "opus", reason: "below_threshold" },
        { provider: "codex", model: "gpt", reason: "eligible" }],
      earliest_reset_epoch_ms: 1_500,
    };
    const exhausted = {
      selected: null, reason: "below_threshold",
      tried: [{ provider: "claude", model: "opus", reason: "below_threshold" }],
      earliest_reset_epoch_ms: 2_000,
    };
    expect(await routeQuotaWithEngine(req(), fake(failover).deps)).toEqual({ ok: true, result: failover });
    expect(await routeQuotaWithEngine(req(), fake(exhausted).deps)).toEqual({ ok: true, result: exhausted });
  });

  it("finite out-of-range min_remaining_pct passes through for Rust invalid_threshold", async () => {
    const resp = { selected: null, reason: "invalid_threshold", tried: [], earliest_reset_epoch_ms: null };
    const { call, deps } = fake(resp);
    const out = await routeQuotaWithEngine({ ...req(), min_remaining_pct: -1 }, deps);
    expect(out).toEqual({ ok: true, result: resp });
    expect((call.mock.calls[0][1] as QuotaRouteRequest).min_remaining_pct).toBe(-1);
  });

  it.each<[string, (r: QuotaRouteRequest) => unknown]>([
    ["null input", () => null],
    ["non-object", () => 7],
    ["array input", () => []],
    ["missing primary", (r) => ({ ...r, primary: undefined })],
    ["empty provider", (r) => ({ ...r, primary: { provider: "", model: "m" } })],
    ["non-string model", (r) => ({ ...r, primary: { provider: "a", model: 5 } })],
    ["backup_order missing", (r) => ({ ...r, backup_order: undefined })],
    ["backup_order >64", (r) => ({ ...r, backup_order: Array.from({ length: 65 }, () => ({ provider: "a", model: "b" })) })],
    ["backup element bad", (r) => ({ ...r, backup_order: [{ provider: "a" }] })],
    ["quotas missing", (r) => ({ ...r, quotas: "x" })],
    ["quotas >256", (r) => ({ ...r, quotas: Array.from({ length: 257 }, () => r.quotas[0]) })],
    ["observed non-integer", (r) => ({ ...r, quotas: [{ ...r.quotas[0], observed_at_epoch_ms: 1.5 }] })],
    ["stale non-integer", (r) => ({ ...r, quotas: [{ ...r.quotas[0], stale_after_ms: "1" }] })],
    ["remaining NaN", (r) => ({ ...r, quotas: [{ ...r.quotas[0], remaining_pct: Number.NaN }] })],
    ["hard_limited non-bool", (r) => ({ ...r, quotas: [{ ...r.quotas[0], hard_limited: "yes" }] })],
    ["reset bad", (r) => ({ ...r, quotas: [{ ...r.quotas[0], resets_at_epoch_ms: 2.5 }] })],
    ["now non-integer", (r) => ({ ...r, now_epoch_ms: "1000" })],
    ["min NaN", (r) => ({ ...r, min_remaining_pct: Number.NaN })],
    ["min Infinity", (r) => ({ ...r, min_remaining_pct: Number.POSITIVE_INFINITY })],
    ["allow non-bool", (r) => ({ ...r, allow_unknown_quota: 1 })],
  ])("invalid input (%s) -> invalid_input, getClient never called", async (_n, make) => {
    const getClient = vi.fn();
    expect(await routeQuotaWithEngine(make(req()), { getClient })).toEqual(noInput);
    expect(getClient).toHaveBeenCalledTimes(0);
  });

  it("unpaired surrogate \"\\uD800\" -> invalid_input, zero getClient/RPC calls", async () => {
    const getClient = vi.fn();
    const input = { ...req(), primary: { provider: "\uD800", model: "m" } };
    expect(await routeQuotaWithEngine(input, { getClient })).toEqual(noInput);
    expect(getClient).toHaveBeenCalledTimes(0);
  });
  it("supplementary-plane boundary: 128 UTF-8 bytes ok, 129 rejected", async () => {
    const { call, deps } = fake();
    const good = { provider: "😀".repeat(32), model: "m" }; // 32*4B = 128B
    expect((await routeQuotaWithEngine({ ...req(), primary: good }, deps)).ok).toBe(true);
    expect((call.mock.calls[0][1] as QuotaRouteRequest).primary).toEqual(good);
    const noCall = vi.fn();
    const bad = { provider: "😀".repeat(32) + "a", model: "m" }; // 129B
    expect(await routeQuotaWithEngine({ ...req(), primary: bad }, { getClient: noCall }))
      .toEqual(noInput);
    expect(noCall).toHaveBeenCalledTimes(0);
  });

  it("NaN-length proxy arrays: invalid_input on input, invalid_response on tried", async () => {
    const nanLen = () => new Proxy([] as unknown[], {
      get: (t, p) => (p === "length" ? Number.NaN : Reflect.get(t, p)),
    });
    const noCall = vi.fn();
    expect(await routeQuotaWithEngine({ ...req(), quotas: nanLen() }, { getClient: noCall }))
      .toEqual(noInput);
    expect(noCall).toHaveBeenCalledTimes(0);
    const { deps } = fake({ ...okResp(), tried: nanLen() });
    expect(await routeQuotaWithEngine(req(), deps)).toEqual(noResp);
  });

  it("sparse/inherited elements: invalid_input input-side, invalid_response tried-side", async () => {
    const noCall = vi.fn();
    expect(await routeQuotaWithEngine({ ...req(), backup_order: new Array(2) }, { getClient: noCall }))
      .toEqual(noInput);
    (Array.prototype as unknown as Record<number, unknown>)[0] = { provider: "a", model: "b" };
    try {
      expect(await routeQuotaWithEngine({ ...req(), quotas: new Array(1) }, { getClient: noCall }))
        .toEqual(noInput);
      const { deps } = fake({ ...okResp(), tried: new Array(1) });
      expect(await routeQuotaWithEngine(req(), deps)).toEqual(noResp);
    } finally { delete (Array.prototype as unknown as Record<number, unknown>)[0]; }
    expect(noCall).toHaveBeenCalledTimes(0);
  });

  it("fluctuating input getter: single read keeps the first validated value", async () => {
    let n = 0;
    const input = { ...req(),
      get primary() { n += 1; return n === 1 ? { provider: "claude", model: "opus" } : 42; } };
    const { call, deps } = fake();
    expect((await routeQuotaWithEngine(input, deps)).ok).toBe(true);
    expect(n).toBe(1);
    expect((call.mock.calls[0][1] as QuotaRouteRequest).primary).toEqual({ provider: "claude", model: "opus" });
  });

  it("mutation of caller input while getClient is pending cannot alter the sent snapshot", async () => {
    let release!: (c: PaperworkEngineClient) => void;
    const getClient = vi.fn(() => new Promise<PaperworkEngineClient>((r) => { release = r; }));
    const call = vi.fn(async () => okResp());
    const input = req();
    const pending = routeQuotaWithEngine(input, { getClient });
    (input as { primary: unknown }).primary = { provider: "evil", model: "x" };
    input.backup_order.length = 0;
    input.quotas[0].provider = "evil";
    release({ call } as unknown as PaperworkEngineClient);
    await pending;
    expect(call.mock.calls[0][1]).toEqual(req());
  });

  it("throwing input getter -> invalid_input, zero getClient/RPC calls", async () => {
    const getClient = vi.fn();
    const input = { ...req(), get quotas(): unknown { throw new Error("boom"); } };
    expect(await routeQuotaWithEngine(input, { getClient })).toEqual(noInput);
    expect(getClient).toHaveBeenCalledTimes(0);
  });
  it("throwing response getter -> invalid_response", async () => {
    const resp = { ...okResp(), get tried(): unknown { throw new Error("boom"); } };
    expect(await routeQuotaWithEngine(req(), fake(resp).deps)).toEqual(noResp);
  });

  it("fluctuating response getter: single read keeps the first validated value", async () => {
    let n = 0;
    const resp = { ...okResp(), get reason() { n += 1; return n === 1 ? "eligible" : "bogus"; } };
    const out = await routeQuotaWithEngine(req(), fake(resp).deps);
    expect(out).toEqual({ ok: true, result: okResp() });
    expect(n).toBe(1);
  });

  it("engine_unavailable: null/throwing getClient, rejecting call (raw text not leaked)", async () => {
    expect(await routeQuotaWithEngine(req(), { getClient: () => null })).toEqual(noEngine);
    expect(await routeQuotaWithEngine(req(), {
      getClient: () => { throw new Error("engine secret"); },
    })).toEqual(noEngine);
    const call = vi.fn(async () => { throw new Error("rpc wire secret"); });
    const getClient = () => ({ call }) as unknown as PaperworkEngineClient;
    const out = await routeQuotaWithEngine(req(), { getClient });
    expect(out).toEqual(noEngine);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it.each<[string, unknown]>([
    ["non-object", null],
    ["array", []],
    ["selected wrong type", { ...okResp(), selected: 7 }],
    ["selected missing", { reason: "eligible", tried: [], earliest_reset_epoch_ms: null }],
    ["reason outside closed set", { ...okResp(), reason: "ok" }],
    ["tried not array", { ...okResp(), tried: {} }],
    ["tried element malformed", { ...okResp(), tried: [{ provider: "a" }] }],
    ["tried verdict outside set", { ...okResp(), tried: [{ provider: "a", model: "b", reason: "n/a" }] }],
    ["reset non-integer", { ...okResp(), earliest_reset_epoch_ms: 1.5 }],
    ["reset missing", { selected: null, reason: "eligible", tried: [] }],
  ])("malformed response (%s) -> invalid_response", async (_n, resp) => {
    expect(await routeQuotaWithEngine(req(), fake(resp).deps)).toEqual(noResp);
  });
});
