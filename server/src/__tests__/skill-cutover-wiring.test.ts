import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { logger } from "../middleware/logger.js";
import {
  deleteSkillWithCutover, getSkillByIdWithCutover, getSkillByKeyWithCutover,
  listSkillsWithCutover, SkillCutoverIndeterminateError, upsertSkillWithCutover,
} from "../services/skill-cutover.js";
import type { PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import type {
  SkillDeleteResult, SkillGetResult, SkillRow, SkillUpsertResult,
} from "../services/paperwork-engine-skill.js";
import { getSharedPaperworkEngineClient } from "../services/paperwork-engine-runtime.js";
import {
  createSkillCutoverHooks, getSkillCutoverMetrics, resetSkillCutoverMetricsForTests,
  SKILL_WIRED_OPERATIONS, wireDeleteSkillCutover, wireGetSkillByIdCutover,
  wireGetSkillByKeyCutover, wireListSkillsCutover, wireUpsertSkillCutover,
  type SkillCutoverResult, type SkillCutoverTelemetryEvent,
  type SkillCutoverWiringOpts, type SkillWiredOperation,
} from "../services/skill-cutover-wiring.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/paperwork-engine-runtime.js")>()),
  getSharedPaperworkEngineClient: vi.fn(() => null),
}));

// Wave 4 어댑터만 vi.fn 으로 교체해 결과를 스크립트한다. 플래그 판정
// (isSkillEngineCutoverEnabled)·SkillCutoverIndeterminateError 는 실구현을 유지한다.
vi.mock("../services/skill-cutover.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/skill-cutover.js")>();
  return {
    ...real,
    upsertSkillWithCutover: vi.fn(),
    deleteSkillWithCutover: vi.fn(),
    listSkillsWithCutover: vi.fn(),
    getSkillByIdWithCutover: vi.fn(),
    getSkillByKeyWithCutover: vi.fn(),
  };
});

const adapter = {
  upsert: vi.mocked(upsertSkillWithCutover),
  delete: vi.mocked(deleteSkillWithCutover),
  list: vi.mocked(listSkillsWithCutover),
  get_by_id: vi.mocked(getSkillByIdWithCutover),
  get_by_key: vi.mocked(getSkillByKeyWithCutover),
};
const warn = vi.mocked(logger.warn);
const sharedClient = vi.mocked(getSharedPaperworkEngineClient);

const NIL = "00000000-0000-0000-0000-000000000000";
const U1 = "11111111-1111-1111-1111-111111111111";
const ON = { PAPERWORK_RUST_SKILL_CUTOVER: "1" };
const OFF = {};
const T0 = "2026-06-01T00:00:00Z";
const T1 = "2026-07-01T00:00:00Z";
const ROW: SkillRow = {
  id: NIL, company_id: U1, key: "review", slug: "review", name: "Review",
  description: null, markdown: "# review", source_type: "local_path",
  source_locator: null, source_ref: null, trust_level: "markdown_only",
  compatibility: "compatible", file_inventory: [], metadata: null,
  created_at: T0, updated_at: T1,
};
const UPSERT = {
  company_id: U1, key: "review", slug: "review", name: "Review", markdown: "# review",
  source_type: "local_path" as const, trust_level: "markdown_only" as const,
  compatibility: "compatible" as const, file_inventory: [],
};
const DELETE = { company_id: U1, skill_id: NIL };
const LIST = { company_id: U1 };
const GET_ID = { company_id: U1, skill_id: NIL };
const GET_KEY = { company_id: U1, key: "review" };
const UPSERTED: SkillUpsertResult = { upserted: true, skill: ROW };
const DELETED: SkillDeleteResult = { deleted: true, skill: ROW };
const FOUND: SkillGetResult = { found: true, skill: ROW };
const CLIENT = {} as PaperworkEngineClient;

const indeterminate = () => new SkillCutoverIndeterminateError("upsert",
  { kind: "commit_indeterminate", outcome: "indeterminate", retryable: false },
  new Error("rpc_-32005"));
const hostileError = () => Object.defineProperty(new Error("boom"), "stack",
  { get() { throw new Error("stack-getter-boom"); } });

interface OpCase {
  op: SkillWiredOperation; params: unknown; result: unknown; mock: Mock;
  invoke: (tsFallback: () => Promise<unknown>,
    opts?: SkillCutoverWiringOpts) => Promise<SkillCutoverResult<unknown>>;
}
const OPS: OpCase[] = [
  { op: "upsert", params: UPSERT, result: UPSERTED, mock: adapter.upsert,
    invoke: (f, o) => wireUpsertSkillCutover(UPSERT, f as never, o) },
  { op: "delete", params: DELETE, result: DELETED, mock: adapter.delete,
    invoke: (f, o) => wireDeleteSkillCutover(DELETE, f as never, o) },
  { op: "list", params: LIST, result: [ROW], mock: adapter.list,
    invoke: (f, o) => wireListSkillsCutover(LIST, f as never, o) },
  { op: "get_by_id", params: GET_ID, result: FOUND, mock: adapter.get_by_id,
    invoke: (f, o) => wireGetSkillByIdCutover(GET_ID, f as never, o) },
  { op: "get_by_key", params: GET_KEY, result: FOUND, mock: adapter.get_by_key,
    invoke: (f, o) => wireGetSkillByKeyCutover(GET_KEY, f as never, o) },
];

beforeEach(() => {
  resetSkillCutoverMetricsForTests();
  for (const mock of Object.values(adapter)) mock.mockReset();
  sharedClient.mockReset().mockReturnValue(null);
  warn.mockReset();
});

describe("skill-cutover-wiring", () => {
  it("flag OFF (unset/'0'/non-'1') routes all five ops to tsFallback: zero client resolution, zero adapter calls", async () => {
    const getClient = vi.fn(() => CLIENT);
    for (const env of [OFF, { PAPERWORK_RUST_SKILL_CUTOVER: "0" }, { PAPERWORK_RUST_SKILL_CUTOVER: "true" }]) {
      for (const op of OPS) {
        await expect(op.invoke(async () => op.result, { env, getClient }))
          .resolves.toEqual({ source: "ts", value: op.result });
      }
    }
    expect(getClient).not.toHaveBeenCalled();
    expect(sharedClient).not.toHaveBeenCalled();
    for (const op of OPS) expect(op.mock).not.toHaveBeenCalled();
    const m = getSkillCutoverMetrics();
    for (const op of SKILL_WIRED_OPERATIONS) {
      expect(m[op]).toMatchObject({ totalCalls: 3, tsBypass: 3, rustOk: 0, fallback: 0 });
    }
    expect(m.upsert.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("flag ON + null/throwing getClient or null shared client warns and fails safe to tsBypass", async () => {
    const tsFallback = vi.fn(async () => UPSERTED);
    await expect(wireUpsertSkillCutover(UPSERT, tsFallback, { env: ON, getClient: () => null }))
      .resolves.toEqual({ source: "ts", value: UPSERTED });
    await expect(wireUpsertSkillCutover(UPSERT, tsFallback, {
      env: ON, getClient: () => { throw new Error("engine spawn failed"); },
    })).resolves.toEqual({ source: "ts", value: UPSERTED });
    await expect(wireGetSkillByIdCutover(GET_ID, async () => FOUND, { env: ON }))
      .resolves.toEqual({ source: "ts", value: FOUND });
    expect(sharedClient).toHaveBeenCalledTimes(1);
    expect(tsFallback).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(adapter.upsert).not.toHaveBeenCalled();
    expect(getSkillCutoverMetrics().upsert)
      .toMatchObject({ totalCalls: 2, tsBypass: 2, rustOk: 0, fallback: 0 });
    expect(getSkillCutoverMetrics().get_by_id).toMatchObject({ totalCalls: 1, tsBypass: 1 });
  });

  it("flag ON + rust result counts rustOk and routes all five ops to the right adapter with timeoutMs/env", async () => {
    for (const op of OPS) {
      op.mock.mockResolvedValueOnce({ source: "rust", value: op.result });
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(tsFallback, { env: ON, getClient: () => CLIENT, timeoutMs: 1234 }))
        .resolves.toEqual({ source: "rust", value: op.result });
      expect(op.mock).toHaveBeenCalledWith(CLIENT, op.params, tsFallback, { timeoutMs: 1234, env: ON });
      expect(tsFallback).not.toHaveBeenCalled();
    }
    const m = getSkillCutoverMetrics();
    for (const op of OPS) {
      expect(m[op.op]).toMatchObject({ rustOk: 1, tsBypass: 0, fallback: 0, indeterminate: 0 });
    }
  });

  it("flag ON + ts-sourced adapter result counts fallback with source ts", async () => {
    for (const op of OPS) {
      op.mock.mockResolvedValueOnce({ source: "ts", value: op.result });
      await expect(op.invoke(vi.fn(), { env: ON, getClient: () => CLIENT }))
        .resolves.toEqual({ source: "ts", value: op.result });
    }
    const m = getSkillCutoverMetrics();
    for (const op of OPS) expect(m[op.op]).toMatchObject({ fallback: 1, rustOk: 0, tsBypass: 0 });
  });

  it("indeterminate adapter error rethrows, counts indeterminate, and never calls tsFallback", async () => {
    const failure = indeterminate();
    adapter.upsert.mockRejectedValueOnce(failure);
    const tsFallback = vi.fn(async () => UPSERTED);
    const events: SkillCutoverTelemetryEvent[] = [];
    await expect(wireUpsertSkillCutover(UPSERT, tsFallback, {
      env: ON, getClient: () => CLIENT, onEvent: (e) => { events.push(e); },
    })).rejects.toBe(failure);
    expect(tsFallback).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      operation: "upsert", outcome: "indeterminate", source: null, error: failure,
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(getSkillCutoverMetrics().upsert)
      .toMatchObject({ indeterminate: 1, tsBypass: 0, fallback: 0, tsError: 0 });
  });

  it("non-indeterminate adapter throw counts ts_error and rethrows", async () => {
    const failure = new Error("tsFallback failed inside adapter");
    adapter.list.mockRejectedValueOnce(failure);
    const tsFallback = vi.fn(async () => [ROW]);
    await expect(wireListSkillsCutover(LIST, tsFallback, { env: ON, getClient: () => CLIENT }))
      .rejects.toBe(failure);
    expect(getSkillCutoverMetrics().list)
      .toMatchObject({ tsError: 1, rustOk: 0, indeterminate: 0 });
  });

  it("counts tsError and rethrows when tsFallback itself throws on the bypass path", async () => {
    const failure = new Error("db gone");
    const tsFallback = vi.fn(async (): Promise<never> => { throw failure; });
    await expect(wireDeleteSkillCutover(DELETE, tsFallback, { env: OFF })).rejects.toBe(failure);
    expect(getSkillCutoverMetrics().delete)
      .toMatchObject({ totalCalls: 1, tsBypass: 1, tsError: 1 });
  });

  it("hostile getClient/logger errors cannot mask the bypass outcome", async () => {
    warn.mockImplementation(() => { throw hostileError(); });
    const tsFallback = vi.fn(async () => UPSERTED);
    const opts = { env: ON, getClient: () => { throw hostileError(); } };
    await expect(wireUpsertSkillCutover(UPSERT, tsFallback, opts))
      .resolves.toEqual({ source: "ts", value: UPSERTED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(getSkillCutoverMetrics().upsert).toMatchObject({ tsBypass: 1 });
  });

  it("createSkillCutoverHooks binds defaults, merges per-call opts, owns an independent meter", async () => {
    adapter.upsert.mockResolvedValueOnce({ source: "rust", value: UPSERTED });
    adapter.get_by_key.mockResolvedValueOnce({ source: "rust", value: FOUND });
    const events: SkillCutoverTelemetryEvent[] = [];
    const hooks = createSkillCutoverHooks({
      env: ON, getClient: () => CLIENT, timeoutMs: 4321,
      onEvent: (event) => { events.push(event); throw new Error("observer boom"); },
    });

    await expect(hooks.upsertSkill(UPSERT, vi.fn())).resolves.toEqual({ source: "rust", value: UPSERTED });
    await expect(hooks.getSkillByKey(GET_KEY, vi.fn())).resolves.toEqual({ source: "rust", value: FOUND });
    expect(events.map((e) => e.outcome)).toEqual(["rust_ok", "rust_ok"]);
    expect(events.every((e) => e.source === "rust" && e.durationMs >= 0)).toBe(true);
    expect(adapter.upsert)
      .toHaveBeenCalledWith(CLIENT, UPSERT, expect.any(Function), { timeoutMs: 4321, env: ON });

    await expect(hooks.listSkills(LIST, async () => [ROW], { env: OFF }))
      .resolves.toEqual({ source: "ts", value: [ROW] });
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ operation: "list", outcome: "ts_bypass", source: "ts" });

    const m = hooks.getMetrics();
    expect(m.upsert).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.get_by_key).toMatchObject({ rustOk: 1, totalCalls: 1 });
    expect(m.list).toMatchObject({ tsBypass: 1, totalCalls: 1 });
    expect(hooks.snapshot()).toEqual(m);
    expect(getSkillCutoverMetrics().upsert.totalCalls).toBe(0);
  });

  it("isolates async onEvent rejections without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await wireGetSkillByKeyCutover(GET_KEY, async () => FOUND, {
        env: OFF,
        onEvent: (async () => { throw new Error("async observer boom"); }) as unknown as (e: SkillCutoverTelemetryEvent) => void,
      });
      expect(res).toEqual({ source: "ts", value: FOUND });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("getSkillCutoverMetrics returns a deep copy; reset zeroes every counter", async () => {
    await wireGetSkillByIdCutover(GET_ID, async () => FOUND, { env: OFF });
    const snap = getSkillCutoverMetrics();
    Object.assign(snap.get_by_id, { tsBypass: 999, rustOk: 999 });
    Object.assign(snap.list, { totalCalls: 999 });
    const fresh = getSkillCutoverMetrics();
    expect(fresh.get_by_id).toMatchObject({ tsBypass: 1, rustOk: 0, totalCalls: 1 });
    expect(fresh.list.totalCalls).toBe(0);

    resetSkillCutoverMetricsForTests();
    const zeroed = getSkillCutoverMetrics();
    for (const op of SKILL_WIRED_OPERATIONS) {
      expect(zeroed[op]).toMatchObject({
        rustOk: 0, fallback: 0, indeterminate: 0, tsBypass: 0, tsError: 0,
        totalCalls: 0, totalDurationMs: 0,
      });
    }
  });
});
