import { describe, expect, it } from "vitest";
import {
  createSharedTableStore,
  globalSharedTableStore,
  type SharedTableColumn,
} from "../services/agent-shared-tables.js";
import {
  createExternalDeliveryOutbox,
  evaluateRoutineQuietRun,
  type ExternalDeliveryOutbox,
} from "../services/routine-quiet-and-outbox.js";

// [Stage 30 Wave D / Worker 3] 검증 초점: (1) shared table 스키마/타입/회사 격리 규칙의 fail-closed,
// (2) routine_no_update 정적 판정(구조화 신호만, 산문 해석 없음), (3) outbox sending→uncertain
// 크래시 복구 안티-중복 불변식.

const C1 = "company-1";
const C2 = "company-2";
const COLUMNS: SharedTableColumn[] = [
  { name: "title", type: "string", required: true },
  { name: "score", type: "number" },
  { name: "published", type: "boolean" },
  { name: "meta", type: "json" },
];

function makeStore() {
  const store = createSharedTableStore();
  store.createTable(C1, { name: "notes", columns: COLUMNS });
  return store;
}

function makeOutbox(): ExternalDeliveryOutbox {
  return createExternalDeliveryOutbox();
}

function enqueuePending(outbox: ExternalDeliveryOutbox, key = "k1") {
  return outbox.enqueue({ idempotencyKey: key, companyId: C1, channel: "webhook", payload: { hello: 1 } });
}

describe("agent shared tables", () => {
  it("creates tables with generated ids and lists them per company", () => {
    const store = makeStore();
    const defs = store.listTables(C1);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ companyId: C1, name: "notes", columns: COLUMNS });
    expect(typeof defs[0]!.id).toBe("string");
    expect(typeof defs[0]!.createdAt).toBe("string");
    expect(store.listTables(C2)).toEqual([]);
  });
  it("rejects invalid table/column identifiers and duplicate columns", () => {
    const store = createSharedTableStore();
    expect(() => store.createTable(C1, { name: "bad name!", columns: COLUMNS })).toThrow(/identifier/);
    expect(() => store.createTable(C1, { name: "ok", columns: [{ name: "has space", type: "string" }] })).toThrow(/identifier/);
    expect(() => store.createTable(C1, { name: "x".repeat(65), columns: COLUMNS })).toThrow(/identifier/);
    expect(() => store.createTable(C1, { name: "", columns: COLUMNS })).toThrow(/identifier/);
    const dupes: SharedTableColumn[] = [{ name: "a", type: "string" }, { name: "a", type: "number" }];
    expect(() => store.createTable(C1, { name: "t", columns: dupes })).toThrow(/duplicate/i);
  });
  it("enforces table name uniqueness per company but allows the same name in another company", () => {
    const store = makeStore();
    expect(() => store.createTable(C1, { name: "notes", columns: COLUMNS })).toThrow(/already exists/);
    expect(() => store.createTable(C2, { name: "notes", columns: COLUMNS })).not.toThrow();
  });
  it("upserts rows with agent attribution and overwrites an existing key", () => {
    const store = makeStore();
    const row = store.upsertRow(C1, "notes", { key: "n1", values: { title: "hello", meta: { a: [1] } }, agentId: "agent-9" });
    expect(row).toMatchObject({ key: "n1", updatedByAgentId: "agent-9" });
    expect(typeof row.updatedAt).toBe("string");
    store.upsertRow(C1, "notes", { key: "n1", values: { title: "v2" }, agentId: "a2" });
    const rows = store.queryRows(C1, "notes");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values).toEqual({ title: "v2" });
    expect(rows[0]!.updatedByAgentId).toBe("a2");
  });
  it("fails closed on unknown columns, type mismatches, and missing required values", () => {
    const store = makeStore();
    const up = (values: Record<string, unknown>) => store.upsertRow(C1, "notes", { key: "k", values });
    expect(() => up({ title: "t", ghost: 1 })).toThrow(/unknown column/i);
    expect(() => up({ title: "t", score: "10" })).toThrow(/type/);
    expect(() => up({ title: 7 })).toThrow(/type/);
    expect(() => up({ title: "t", published: "yes" })).toThrow(/type/);
    expect(() => up({ title: "t", meta: () => 1 })).toThrow(/type/);
    expect(() => up({ score: 1 })).toThrow(/required/i);
  });
  it("queries with exact-match (scalar and json deep), deterministic key ordering, and limit", () => {
    const store = makeStore();
    for (const [key, score] of [["b", 2], ["a", 1], ["c", 2]] as const) {
      store.upsertRow(C1, "notes", { key, values: { title: `t-${key}`, score } });
    }
    const keys = (opts?: { where?: Record<string, unknown>; limit?: number }) =>
      store.queryRows(C1, "notes", opts).map((r) => r.key);
    expect(keys()).toEqual(["a", "b", "c"]);
    expect(keys({ where: { score: 2 } })).toEqual(["b", "c"]);
    expect(keys({ where: { title: "t-a" } })).toEqual(["a"]);
    expect(keys({ limit: 2 })).toEqual(["a", "b"]);
    expect(() => store.queryRows(C1, "notes", { where: { ghost: 1 } })).toThrow(/unknown column/i);
    store.upsertRow(C1, "notes", { key: "j1", values: { title: "x", meta: { tag: "hot" } } });
    store.upsertRow(C1, "notes", { key: "j2", values: { title: "y", meta: { tag: "cold" } } });
    expect(keys({ where: { meta: { tag: "hot" } } })).toEqual(["j1"]);
  });
  it("enforces company isolation and deleteRow semantics", () => {
    const store = makeStore();
    store.upsertRow(C1, "notes", { key: "n1", values: { title: "secret" } });
    expect(() => store.upsertRow(C2, "notes", { key: "n1", values: { title: "x" } })).toThrow(/not found/i);
    expect(() => store.queryRows(C2, "notes")).toThrow(/not found/i);
    expect(store.deleteRow(C2, "notes", "n1")).toBe(false);
    store.createTable(C2, { name: "notes", columns: COLUMNS });
    expect(store.queryRows(C2, "notes")).toEqual([]);
    expect(store.deleteRow(C1, "notes", "n1")).toBe(true);
    expect(store.deleteRow(C1, "notes", "n1")).toBe(false);
  });
  it("exposes a functional global singleton independent of fresh stores", () => {
    globalSharedTableStore.createTable("company-global", { name: "greetz", columns: [{ name: "v", type: "string" }] });
    globalSharedTableStore.upsertRow("company-global", "greetz", { key: "g1", values: { v: "hi" } });
    expect(globalSharedTableStore.queryRows("company-global", "greetz").map((r) => r.key)).toEqual(["g1"]);
    expect(createSharedTableStore().listTables("company-global")).toEqual([]);
  });
});

describe("evaluateRoutineQuietRun", () => {
  it("is quiet only with an explicit no-update signal and zero changes and zero alerts", () => {
    expect(evaluateRoutineQuietRun({ explicitNoUpdateSignal: true, changedArtifactCount: 0, createdAlertCount: 0 }))
      .toEqual({ quiet: true, suppressExternalNotify: true, suppressDownstreamFlow: true });
  });
  it("is not quiet without the structured signal, with changes/alerts, or on malformed counts", () => {
    const base = { changedArtifactCount: 0, createdAlertCount: 0 };
    const quiet = (input: Parameters<typeof evaluateRoutineQuietRun>[0]) => evaluateRoutineQuietRun(input).quiet;
    expect(quiet(base)).toBe(false);
    expect(quiet({ ...base, explicitNoUpdateSignal: false })).toBe(false);
    expect(quiet({ ...base, explicitNoUpdateSignal: "true" as unknown as boolean })).toBe(false);
    expect(quiet({ explicitNoUpdateSignal: true, changedArtifactCount: 1, createdAlertCount: 0 })).toBe(false);
    expect(quiet({ explicitNoUpdateSignal: true, changedArtifactCount: 0, createdAlertCount: 2 })).toBe(false);
    expect(quiet({ explicitNoUpdateSignal: true, changedArtifactCount: 1.5, createdAlertCount: 0 })).toBe(false);
    expect(quiet({ explicitNoUpdateSignal: true, changedArtifactCount: 0, createdAlertCount: -1 })).toBe(false);
  });
});

describe("external delivery outbox", () => {
  it("enqueues as pending, deduplicates by idempotency key, and rejects empty fields", () => {
    const outbox = makeOutbox();
    const first = enqueuePending(outbox);
    const second = outbox.enqueue({ idempotencyKey: "k1", companyId: C1, channel: "webhook", payload: { hello: 2 } });
    expect(first.status).toBe("pending");
    expect(second.id).toBe(first.id);
    expect(outbox.get(second.id)).toMatchObject({ status: "pending", payload: { hello: 1 } });
    expect(outbox.get("missing")).toBeNull();
    const enq = (input: Record<string, unknown>) => outbox.enqueue(input as Parameters<ExternalDeliveryOutbox["enqueue"]>[0]);
    expect(() => enq({ idempotencyKey: "", companyId: C1, channel: "w" })).toThrow(/idempotency/i);
    expect(() => enq({ idempotencyKey: "k", companyId: "", channel: "w" })).toThrow(/companyId/i);
    expect(() => enq({ idempotencyKey: "k", companyId: C1, channel: "" })).toThrow(/channel/i);
  });
  it("beginSending moves pending to sending, rejects sent/uncertain/double-begin, retries from failed", () => {
    const outbox = makeOutbox();
    const sentRow = enqueuePending(outbox, "sent-row");
    outbox.beginSending(sentRow.id);
    outbox.markSent(sentRow.id);
    expect(() => outbox.beginSending(sentRow.id)).toThrow(/got "sent"/);
    const crashed = enqueuePending(outbox, "crash");
    outbox.beginSending(crashed.id);
    outbox.recoverInterruptedOnBoot();
    expect(() => outbox.beginSending(crashed.id)).toThrow(/got "uncertain"/);
    const active = enqueuePending(outbox, "active");
    outbox.beginSending(active.id);
    expect(() => outbox.beginSending(active.id)).toThrow(/got "sending"/);
    outbox.markFailed(active.id, "boom");
    expect(outbox.beginSending(active.id).status).toBe("sending");
  });
  it("markSent/markFailed move sending rows to terminal states and reject non-sending rows", () => {
    const outbox = makeOutbox();
    const sentRow = enqueuePending(outbox, "sent-row");
    expect(() => outbox.markSent(sentRow.id)).toThrow(/sending/);
    expect(() => outbox.markFailed(sentRow.id, "e")).toThrow(/sending/);
    outbox.beginSending(sentRow.id);
    expect(outbox.markSent(sentRow.id)).toMatchObject({ status: "sent", lastError: null });
    const failedRow = enqueuePending(outbox, "failed-row");
    outbox.beginSending(failedRow.id);
    const failed = outbox.markFailed(failedRow.id, new Error("smtp 550"));
    expect(failed).toMatchObject({ status: "failed", lastError: "smtp 550" });
  });
  it("recovers interrupted sending rows to uncertain on boot — never pending, never retryable", () => {
    const outbox = makeOutbox();
    const crashed = enqueuePending(outbox, "crash");
    outbox.beginSending(crashed.id);
    const untouched = enqueuePending(outbox, "pending-row");
    const failedRow = enqueuePending(outbox, "failed-row");
    outbox.beginSending(failedRow.id);
    outbox.markFailed(failedRow.id, "e");
    expect(outbox.recoverInterruptedOnBoot()).toBe(1);
    expect(outbox.get(crashed.id)).toMatchObject({ status: "uncertain" });
    expect(outbox.get(untouched.id)).toMatchObject({ status: "pending" });
    expect(outbox.get(failedRow.id)).toMatchObject({ status: "failed" });
    expect(outbox.recoverInterruptedOnBoot()).toBe(0);
    expect(() => outbox.beginSending(crashed.id)).toThrow(/uncertain/);
  });
  it("canAutoRetry is true only for failed rows", () => {
    const outbox = makeOutbox();
    const failedRow = enqueuePending(outbox, "f");
    outbox.beginSending(failedRow.id);
    outbox.markFailed(failedRow.id, "e");
    expect(outbox.canAutoRetry(failedRow.id)).toBe(true);
    expect(outbox.canAutoRetry(enqueuePending(outbox, "p").id)).toBe(false);
    const sentRow = enqueuePending(outbox, "s");
    outbox.beginSending(sentRow.id);
    outbox.markSent(sentRow.id);
    expect(outbox.canAutoRetry(sentRow.id)).toBe(false);
    const sendingRow = enqueuePending(outbox, "g");
    outbox.beginSending(sendingRow.id);
    expect(outbox.canAutoRetry(sendingRow.id)).toBe(false);
    const uncertainRow = enqueuePending(outbox, "u");
    outbox.beginSending(uncertainRow.id);
    outbox.recoverInterruptedOnBoot();
    expect(outbox.canAutoRetry(uncertainRow.id)).toBe(false);
    expect(outbox.canAutoRetry("no-such-id")).toBe(false);
  });
});
