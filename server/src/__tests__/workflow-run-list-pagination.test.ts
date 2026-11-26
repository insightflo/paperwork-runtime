import { randomUUID } from "node:crypto";
import express from "express";
import { desc } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { companies, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { listWorkflowRuns } from "../services/workflow/workflow-store.js";
import {
  clampWorkflowRunListLimit,
  clampWorkflowRunListOffset,
  parseWorkflowRunListQuery,
  resolveWorkflowRunListPage,
  WORKFLOW_RUN_LIST_DEFAULT_LIMIT,
  WORKFLOW_RUN_LIST_MAX_LIMIT,
} from "../services/workflow/workflow-run-list-pagination.js";
import { terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

describe("workflow run list pagination clamps", () => {
  it("defaults missing or non-finite limits to 200", () => {
    expect(WORKFLOW_RUN_LIST_DEFAULT_LIMIT).toBe(200);
    expect(clampWorkflowRunListLimit(undefined)).toBe(200);
    expect(clampWorkflowRunListLimit(null)).toBe(200);
    expect(clampWorkflowRunListLimit(Number.NaN)).toBe(200);
    expect(clampWorkflowRunListLimit(Number.POSITIVE_INFINITY)).toBe(200);
  });

  it("caps the limit at 500 and floors at 1 (integer floor)", () => {
    expect(WORKFLOW_RUN_LIST_MAX_LIMIT).toBe(500);
    expect(clampWorkflowRunListLimit(1000)).toBe(500);
    expect(clampWorkflowRunListLimit(501)).toBe(500);
    expect(clampWorkflowRunListLimit(0)).toBe(1);
    expect(clampWorkflowRunListLimit(-5)).toBe(1);
    expect(clampWorkflowRunListLimit(250.9)).toBe(250);
  });

  it("defaults offset to 0, floors negatives to 0 and caps at MAX_SAFE_INTEGER", () => {
    expect(clampWorkflowRunListOffset(undefined)).toBe(0);
    expect(clampWorkflowRunListOffset(null)).toBe(0);
    expect(clampWorkflowRunListOffset(Number.NaN)).toBe(0);
    expect(clampWorkflowRunListOffset(-5)).toBe(0);
    expect(clampWorkflowRunListOffset(3.9)).toBe(3);
    expect(clampWorkflowRunListOffset(1e300)).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(clampWorkflowRunListOffset(1e300))).toBe(true);
  });

  it("resolves a page from a filters object", () => {
    expect(resolveWorkflowRunListPage({})).toEqual({ limit: 200, offset: 0 });
    expect(resolveWorkflowRunListPage({ limit: 50, offset: 10 })).toEqual({ limit: 50, offset: 10 });
    expect(resolveWorkflowRunListPage({ limit: 9999, offset: -1 })).toEqual({ limit: 500, offset: 0 });
  });
});

describe("workflow run list query parser", () => {
  it("returns undefined for missing, blank, or non-string params so the service default applies", () => {
    expect(parseWorkflowRunListQuery({})).toEqual({ limit: undefined, offset: undefined });
    expect(parseWorkflowRunListQuery({ limit: "", offset: "  " })).toEqual({ limit: undefined, offset: undefined });
    expect(parseWorkflowRunListQuery({ limit: ["1", "2"], offset: { a: 1 } })).toEqual({ limit: undefined, offset: undefined });
  });

  it("passes numeric strings through unclamped (clamping is the store's job)", () => {
    expect(parseWorkflowRunListQuery({ limit: "25", offset: "100" })).toEqual({ limit: 25, offset: 100 });
    expect(parseWorkflowRunListQuery({ limit: "0", offset: "-3" })).toEqual({ limit: 0, offset: -3 });
    expect(parseWorkflowRunListQuery({ limit: "1e3" })).toEqual({ limit: 1000, offset: undefined });
  });

  it("rejects non-numeric limit/offset with a 400 HttpError", () => {
    for (const query of [{ limit: "abc" }, { offset: "abc" }, { limit: "Infinity" }, { offset: "12px" }]) {
      let thrown: unknown;
      try {
        parseWorkflowRunListQuery(query);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(400);
    }
  });
});

type Seen = { where: unknown[]; orderBy: unknown[][]; limit: number[]; offset: number[] };

/** Minimal Drizzle-chain double: records LIMIT/OFFSET/order and resolves the given rows. */
function chainDb(rows: unknown[]): { db: Db; seen: Seen } {
  const seen: Seen = { where: [], orderBy: [], limit: [], offset: [] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: (condition: unknown) => { seen.where.push(condition); return chain; },
    orderBy: (...columns: unknown[]) => { seen.orderBy.push(columns); return chain; },
    limit: (value: number) => { seen.limit.push(value); return chain; },
    offset: (value: number) => { seen.offset.push(value); return chain; },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return { db: chain as unknown as Db, seen };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    workflowId: randomUUID(),
    companyId: randomUUID(),
    missionId: null,
    status: "completed",
    originalStatus: null,
    triggeredBy: "board",
    triggerSource: null,
    runDate: null,
    runNumber: null,
    runLabel: null,
    parentIssueId: null,
    parentRunId: null,
    parentStepRunId: null,
    rootRunId: null,
    scheduledSlotId: null,
    legacyPluginRunEntityId: null,
    metadata: {},
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("listWorkflowRuns query shape (mock db)", () => {
  it("emits LIMIT 200 / OFFSET 0 when paging is omitted and orders by createdAt desc, id desc", async () => {
    const row = runRow();
    const { db, seen } = chainDb([row]);

    const runs = await listWorkflowRuns(db, { companyId: "company-1" });

    expect(runs.map((run) => run.id)).toEqual([row.id]);
    expect(seen.limit).toEqual([200]);
    expect(seen.offset).toEqual([0]);
    expect(seen.orderBy).toHaveLength(1);
    expect(seen.orderBy[0]).toEqual([desc(workflowRuns.createdAt), desc(workflowRuns.id)]);
  });

  it("passes clamped limit/offset to the query", async () => {
    const { db, seen } = chainDb([]);
    await listWorkflowRuns(db, { companyId: "company-1", limit: 50, offset: 10 });
    expect(seen.limit).toEqual([50]);
    expect(seen.offset).toEqual([10]);

    const clamped = chainDb([]);
    await listWorkflowRuns(clamped.db, { limit: 10_000, offset: -7 });
    expect(clamped.seen.limit).toEqual([500]);
    expect(clamped.seen.offset).toEqual([0]);
  });

  it("keeps where-condition behaviour (no filters → where(undefined), filters → one combined clause)", async () => {
    const { db, seen } = chainDb([]);
    await listWorkflowRuns(db, {});
    expect(seen.where).toEqual([undefined]);
    const filtered = chainDb([]);
    await listWorkflowRuns(filtered.db, { companyId: "c", workflowId: "w", missionId: "m" });
    expect(filtered.seen.where).toHaveLength(1);
  });
});

describe("listWorkflowRuns SQL LIMIT/OFFSET (PGlite)", () => {
  let db!: Db;
  let close: () => Promise<void> = async () => undefined;
  const companyId = randomUUID();
  const workflowA = randomUUID();
  const workflowB = randomUUID();
  // Fixed, ordered ids so the createdAt tie is broken by id desc deterministically.
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005"];

  beforeAll(async () => {
    ({ db, close } = await terminalDatabase());
    await db.insert(companies).values({ id: companyId, name: "Runs List Co", issuePrefix: "RLC" });
    await db.insert(workflowDefinitions).values([
      { id: workflowA, companyId, name: "A" },
      { id: workflowB, companyId, name: "B" },
    ]);
    const t0 = Date.UTC(2026, 0, 10, 12, 0, 0);
    const at = (minutes: number) => new Date(t0 + minutes * 60_000);
    await db.insert(workflowRuns).values([
      { id: ids[0], workflowId: workflowA, companyId, triggeredBy: "board", createdAt: at(0) },
      { id: ids[1], workflowId: workflowB, companyId, triggeredBy: "board", createdAt: at(1) },
      { id: ids[2], workflowId: workflowA, companyId, triggeredBy: "board", createdAt: at(2) },
      { id: ids[3], workflowId: workflowB, companyId, triggeredBy: "board", createdAt: at(3) },
      // Same createdAt as ids[3] → id desc must put this first.
      { id: ids[4], workflowId: workflowA, companyId, triggeredBy: "board", createdAt: at(3) },
    ]);
  }, 60_000);

  afterAll(async () => { await close(); });

  it("orders by createdAt desc then id desc and returns everything under the default page", async () => {
    const runs = await listWorkflowRuns(db, { companyId });
    expect(runs.map((run) => run.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
  });

  it("applies offset and limit as a window over the ordered rows", async () => {
    const page = await listWorkflowRuns(db, { companyId, offset: 2, limit: 2 });
    expect(page.map((run) => run.id)).toEqual([ids[2], ids[1]]);
    const tail = await listWorkflowRuns(db, { companyId, offset: 4, limit: 100 });
    expect(tail.map((run) => run.id)).toEqual([ids[0]]);
    const pastEnd = await listWorkflowRuns(db, { companyId, offset: 50 });
    expect(pastEnd).toEqual([]);
  });

  it("clamps in SQL: limit<1 → 1 row, limit>500 unaffected for small tables", async () => {
    const one = await listWorkflowRuns(db, { companyId, limit: 0 });
    expect(one.map((run) => run.id)).toEqual([ids[4]]);
    const all = await listWorkflowRuns(db, { companyId, limit: 5_000 });
    expect(all).toHaveLength(5);
  });

  it("combines filters with paging", async () => {
    const runs = await listWorkflowRuns(db, { companyId, workflowId: workflowA, limit: 1, offset: 1 });
    expect(runs.map((run) => run.id)).toEqual([ids[2]]);
    const other = await listWorkflowRuns(db, { companyId: "00000000-0000-4000-8000-00000000ffff" });
    expect(other).toEqual([]);
  });
});

describe("workflow run list routes (bounded query params)", () => {
  let db!: Db;
  let server!: express.Express;
  let close: () => Promise<void> = async () => undefined;
  const companyId = randomUUID();
  const workflowA = randomUUID();
  const workflowB = randomUUID();
  const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003"];

  function app() {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board", userId: "board-user-1", companyIds: [companyId], source: "session", isInstanceAdmin: false,
      };
      next();
    });
    expressApp.use("/api", workflowRoutes(db));
    expressApp.use(errorHandler);
    return expressApp;
  }

  beforeAll(async () => {
    ({ db, close } = await terminalDatabase());
    server = app();
    await db.insert(companies).values({ id: companyId, name: "Routes Co", issuePrefix: "RTC" });
    await db.insert(workflowDefinitions).values([
      { id: workflowA, companyId, name: "A" },
      { id: workflowB, companyId, name: "B" },
    ]);
    const t0 = Date.UTC(2026, 0, 11, 9, 0, 0);
    await db.insert(workflowRuns).values([
      { id: ids[0], workflowId: workflowA, companyId, triggeredBy: "board", createdAt: new Date(t0) },
      { id: ids[1], workflowId: workflowB, companyId, triggeredBy: "board", createdAt: new Date(t0 + 1_000) },
      { id: ids[2], workflowId: workflowA, companyId, triggeredBy: "board", createdAt: new Date(t0 + 2_000) },
    ]);
  }, 60_000);

  afterAll(async () => { await close(); });

  it("GET /companies/:companyId/workflow-runs keeps the array shape and honours limit/offset", async () => {
    const all = await request(server).get(`/api/companies/${companyId}/workflow-runs`);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.map((run: { id: string }) => run.id)).toEqual([ids[2], ids[1], ids[0]]);

    const page = await request(server).get(`/api/companies/${companyId}/workflow-runs?limit=1&offset=1`);
    expect(page.status).toBe(200);
    expect(page.body.map((run: { id: string }) => run.id)).toEqual([ids[1]]);

    const filtered = await request(server).get(`/api/companies/${companyId}/workflow-runs?workflowId=${workflowB}&limit=1`);
    expect(filtered.body.map((run: { id: string }) => run.id)).toEqual([ids[1]]);
  });

  it("GET /companies/:companyId/workflow-runs clamps over/under-range values and treats blank as default", async () => {
    const clamped = await request(server).get(`/api/companies/${companyId}/workflow-runs?limit=9999&offset=-5`);
    expect(clamped.status).toBe(200);
    expect(clamped.body.map((run: { id: string }) => run.id)).toEqual([ids[2], ids[1], ids[0]]);
    const blank = await request(server).get(`/api/companies/${companyId}/workflow-runs?limit=&offset=`);
    expect(blank.status).toBe(200);
    expect(blank.body).toHaveLength(3);
  });

  it("GET /companies/:companyId/workflow-runs returns 400 for non-numeric limit/offset", async () => {
    const badLimit = await request(server).get(`/api/companies/${companyId}/workflow-runs?limit=abc`);
    expect(badLimit.status).toBe(400);
    const badOffset = await request(server).get(`/api/companies/${companyId}/workflow-runs?offset=abc`);
    expect(badOffset.status).toBe(400);
  });

  it("GET /workflows/:workflowId/runs honours limit/offset within the workflow scope", async () => {
    const all = await request(server).get(`/api/workflows/${workflowA}/runs`);
    expect(all.status).toBe(200);
    expect(all.body.map((run: { id: string }) => run.id)).toEqual([ids[2], ids[0]]);

    const page = await request(server).get(`/api/workflows/${workflowA}/runs?limit=1&offset=1`);
    expect(page.status).toBe(200);
    expect(page.body.map((run: { id: string }) => run.id)).toEqual([ids[0]]);

    const bad = await request(server).get(`/api/workflows/${workflowA}/runs?limit=abc`);
    expect(bad.status).toBe(400);

    const missing = await request(server).get(`/api/workflows/${randomUUID()}/runs?limit=5`);
    expect(missing.status).toBe(404);
  });
});
