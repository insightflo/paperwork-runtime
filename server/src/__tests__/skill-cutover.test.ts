import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { PaperworkEngineError, type PaperworkEngineClient } from "../services/paperwork-engine-client.js";
import {
  classifySkillRpcError, deleteSkill, getSkillById, getSkillByKey, listSkills, upsertSkill,
  type SkillDeleteParams, type SkillGetByIdParams, type SkillGetByKeyParams,
  type SkillListParams, type SkillRow, type SkillUpsertParams,
} from "../services/paperwork-engine-skill.js";
import {
  SkillCutoverIndeterminateError, deleteSkillWithCutover, getSkillByIdWithCutover,
  getSkillByKeyWithCutover, isSkillEngineCutoverEnabled, listSkillsWithCutover,
  upsertSkillWithCutover, type SkillCutoverCallOpts, type SkillCutoverOperation,
  type SkillCutoverResult,
} from "../services/skill-cutover.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/paperwork-engine-skill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/paperwork-engine-skill.js")>();
  return {
    ...actual,
    listSkills: vi.fn(), getSkillById: vi.fn(), getSkillByKey: vi.fn(),
    upsertSkill: vi.fn(), deleteSkill: vi.fn(),
  };
});

type AnyMock = ReturnType<typeof vi.fn>;
type Invoke = (client: PaperworkEngineClient | null, tsFallback: () => Promise<unknown>,
  opts?: SkillCutoverCallOpts) => Promise<SkillCutoverResult<unknown>>;
interface WriteCase { op: SkillCutoverOperation; params: unknown; result: unknown; mock: AnyMock; invoke: Invoke }
interface ReadCase { op: string; params: unknown; result: unknown; mock: AnyMock; invoke: Invoke }

const NIL = "00000000-0000-0000-0000-000000000000";
const ON = { PAPERWORK_RUST_SKILL_CUTOVER: "1" };
const T0 = "2026-01-01T00:00:00Z";
const SKILL: SkillRow = {
  id: NIL, company_id: NIL, key: "key", slug: "slug", name: "Skill", description: null,
  markdown: "# Skill", source_type: "local_path", source_locator: null, source_ref: null,
  trust_level: "markdown_only", compatibility: "compatible", file_inventory: [], metadata: null,
  created_at: T0, updated_at: T0,
};
const LIST: SkillListParams = { company_id: NIL };
const BY_ID: SkillGetByIdParams = { company_id: NIL, skill_id: NIL };
const BY_KEY: SkillGetByKeyParams = { company_id: NIL, key: "key" };
const UPSERT: SkillUpsertParams = {
  company_id: NIL, key: "key", slug: "slug", name: "Skill", markdown: "# Skill",
  source_type: "local_path", trust_level: "markdown_only", compatibility: "compatible",
  file_inventory: [], metadata: null,
};
const DELETE: SkillDeleteParams = { company_id: NIL, skill_id: NIL };
const UPSERTED = { upserted: true as const, skill: SKILL };
const DELETED_FALSE = { deleted: false as const };
const FOUND = { found: true as const, skill: SKILL };
const client = {} as PaperworkEngineClient;
const warn = logger.warn as unknown as AnyMock;
const rpc = (code: number) => new PaperworkEngineError("rpc_error", `e${code}`, code);

const WRITES: WriteCase[] = [
  { op: "upsert", params: UPSERT, result: UPSERTED, mock: upsertSkill as unknown as AnyMock,
    invoke: (c, f, o) => upsertSkillWithCutover(c, UPSERT, f as never, o) },
  { op: "delete", params: DELETE, result: DELETED_FALSE, mock: deleteSkill as unknown as AnyMock,
    invoke: (c, f, o) => deleteSkillWithCutover(c, DELETE, f as never, o) },
];
const READS: ReadCase[] = [
  { op: "list", params: LIST, result: [SKILL], mock: listSkills as unknown as AnyMock,
    invoke: (c, f, o) => listSkillsWithCutover(c, LIST, f as never, o) },
  { op: "get_by_id", params: BY_ID, result: FOUND, mock: getSkillById as unknown as AnyMock,
    invoke: (c, f, o) => getSkillByIdWithCutover(c, BY_ID, f as never, o) },
  { op: "get_by_key", params: BY_KEY, result: FOUND, mock: getSkillByKey as unknown as AnyMock,
    invoke: (c, f, o) => getSkillByKeyWithCutover(c, BY_KEY, f as never, o) },
];
const upsertMock = upsertSkill as unknown as AnyMock;
const listMock = listSkills as unknown as AnyMock;

beforeEach(() => vi.resetAllMocks());

describe("isSkillEngineCutoverEnabled", () => {
  it("is true only for the literal value '1'", () => {
    expect(isSkillEngineCutoverEnabled(ON)).toBe(true);
    for (const v of ["0", "true", "yes", "", undefined]) {
      expect(isSkillEngineCutoverEnabled({ PAPERWORK_RUST_SKILL_CUTOVER: v })).toBe(false);
    }
    expect(isSkillEngineCutoverEnabled({})).toBe(false);
  });
});

describe("skill RPC classification passthrough", () => {
  it("uses the real shared not_committed/indeterminate tuple table", () => {
    for (const code of [-32001, -32002, -32003, -32004, -32602]) {
      expect(classifySkillRpcError(rpc(code))).toMatchObject({ outcome: "not_committed" });
    }
    for (const error of [rpc(-32005), new PaperworkEngineError("protocol_error", "p"), new RangeError("not sent")]) {
      expect(classifySkillRpcError(error)).toMatchObject({ outcome: "indeterminate", retryable: false });
    }
  });
});

describe("skill write cutover", () => {
  it.each(WRITES)("$op: flag OFF and null client bypass with zero typed-client calls", async (op) => {
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(op.mock).not.toHaveBeenCalled();
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });

  it.each(WRITES)("$op: flag ON passes normal rust results through with write timeout", async (op) => {
    op.mock.mockResolvedValue(op.result);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.result });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(op.mock).toHaveBeenCalledWith(client, op.params, { timeoutMs: 17_000 });
  });

  it.each(WRITES)("$op: not_committed rpc warns and falls back to TS once", async (op) => {
    op.mock.mockRejectedValue(rpc(-32003));
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(tsFallback).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: op.op, kind: "busy" }), expect.any(String));
  });

  it.each([-32001, -32002, -32004, -32602])("upsert not_committed rpc %i falls back to TS", async (code) => {
    upsertMock.mockRejectedValue(rpc(code));
    const tsFallback = vi.fn(async () => UPSERTED);
    await expect(upsertSkillWithCutover(client, UPSERT, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: UPSERTED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });

  it.each(WRITES)("$op: indeterminate rpc -32005 throws and NEVER calls tsFallback", async (op) => {
    op.mock.mockRejectedValue(rpc(-32005));
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .rejects.toMatchObject({
        name: "SkillCutoverIndeterminateError", operation: op.op,
        classification: { outcome: "indeterminate", retryable: false },
      });
    expect(tsFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["client timeout", new PaperworkEngineError("timeout", "t")],
    ["protocol_error", new PaperworkEngineError("protocol_error", "p")],
    ["untyped error", new Error("x")],
    ["pre-send RangeError", new RangeError("not sent")],
  ])("indeterminate failure (%s) throws and never calls tsFallback", async (_label, error) => {
    upsertMock.mockRejectedValue(error);
    const tsFallback = vi.fn();
    await expect(upsertSkillWithCutover(client, UPSERT, tsFallback, { env: ON }))
      .rejects.toBeInstanceOf(SkillCutoverIndeterminateError);
    expect(tsFallback).not.toHaveBeenCalled();
  });

  it("surfaces operation/classification/cause on the thrown error", async () => {
    const error = rpc(-32005);
    upsertMock.mockRejectedValue(error);
    const err = await upsertSkillWithCutover(client, UPSERT, vi.fn(), { env: ON })
      .then(() => { throw new Error("expected cutover error"); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(SkillCutoverIndeterminateError);
    expect(err).toMatchObject({ operation: "upsert", cause: error });
  });

  it("tsFallback rejection propagates unchanged after not_committed", async () => {
    const failure = new Error("ts failed");
    upsertMock.mockRejectedValue(rpc(-32003));
    const tsFallback = vi.fn(async () => { throw failure; });
    await expect(upsertSkillWithCutover(client, UPSERT, tsFallback, { env: ON })).rejects.toBe(failure);
  });

  it.each([[0, 17_000], [10_000, 17_000], [17_000, 17_000], [700_000, 600_000],
    [Number.NaN, 17_000], [Number.POSITIVE_INFINITY, 17_000], [12.7, 17_000]])(
    "writes clamp timeoutMs %s to %s, a valid engine integer", async (ms, want) => {
      upsertMock.mockResolvedValue(UPSERTED);
      await upsertSkillWithCutover(client, UPSERT, vi.fn(), { env: ON, timeoutMs: ms });
      expect(upsertMock).toHaveBeenCalledWith(client, UPSERT, { timeoutMs: want });
    });

  it("a throwing logger.warn does not mask the not_committed TS fallback", async () => {
    warn.mockImplementation(() => { throw new Error("pino boom"); });
    upsertMock.mockRejectedValue(rpc(-32003));
    const tsFallback = vi.fn(async () => UPSERTED);
    await expect(upsertSkillWithCutover(client, UPSERT, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: UPSERTED });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
});

describe("skill read cutover", () => {
  it.each(READS)("$op: flag OFF and null client bypass with zero typed-client calls", async (op) => {
    const tsFallback = vi.fn(async () => op.result);
    await expect(op.invoke(client, tsFallback, { env: {} }))
      .resolves.toEqual({ source: "ts", value: op.result });
    await expect(op.invoke(null, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: op.result });
    expect(op.mock).not.toHaveBeenCalled();
    expect(tsFallback).toHaveBeenCalledTimes(2);
  });

  it.each(READS)("$op: flag ON returns engine rows with the 10s read timeout", async (op) => {
    op.mock.mockResolvedValue(op.result);
    const tsFallback = vi.fn();
    await expect(op.invoke(client, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "rust", value: op.result });
    expect(tsFallback).not.toHaveBeenCalled();
    expect(op.mock).toHaveBeenCalledWith(client, op.params, { timeoutMs: 10_000 });
  });

  it.each(READS)("$op: ANY engine error warns and falls back to TS", async (op) => {
    for (const error of [rpc(-32005), new PaperworkEngineError("timeout", "t"), new Error("x")]) {
      op.mock.mockRejectedValueOnce(error);
      const tsFallback = vi.fn(async () => op.result);
      await expect(op.invoke(client, tsFallback, { env: ON }))
        .resolves.toEqual({ source: "ts", value: op.result });
      expect(tsFallback).toHaveBeenCalledTimes(1);
    }
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: op.op }), expect.any(String));
  });

  it("pre-send RangeError also falls back on reads", async () => {
    listMock.mockRejectedValue(new RangeError("not sent"));
    const tsFallback = vi.fn(async () => [SKILL]);
    await expect(listSkillsWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [SKILL] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });

  it.each([[0, 1], [10_000, 10_000], [17_000, 17_000], [700_000, 600_000],
    [Number.NaN, 10_000], [Number.POSITIVE_INFINITY, 10_000], [12.7, 12]])(
    "reads clamp timeoutMs %s to %s", async (ms, want) => {
      listMock.mockResolvedValue([]);
      await listSkillsWithCutover(client, LIST, vi.fn(), { env: ON, timeoutMs: ms });
      expect(listMock).toHaveBeenCalledWith(client, LIST, { timeoutMs: want });
    });

  it("a throwing logger.warn does not mask the read TS fallback", async () => {
    warn.mockImplementation(() => { throw new Error("pino boom"); });
    listMock.mockRejectedValue(rpc(-32005));
    const tsFallback = vi.fn(async () => [SKILL]);
    await expect(listSkillsWithCutover(client, LIST, tsFallback, { env: ON }))
      .resolves.toEqual({ source: "ts", value: [SKILL] });
    expect(tsFallback).toHaveBeenCalledTimes(1);
  });
});
