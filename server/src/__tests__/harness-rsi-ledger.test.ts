import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, harnessRsiLedger } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { harnessRsiRoutes } from "../routes/harness-rsi.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(
    `Skipping harness-rsi ledger route tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeDb("harness-rsi stage 4 ledger routes", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: express.Express;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const decisionBody = (over: Record<string, unknown> = {}) => ({
    variant: "v1-prompt", component: "skills", decision: "approved",
    decidedBy: "board", hypothesis: "shorten serial depth",
    diffRef: "diff://a1", baselineJson: { score: 0.8, cost: 10 }, ...over,
  });
  const postDecision = (b: Record<string, unknown>, co = companyId) =>
    request(app).post(`/api/companies/${co}/harness-rsi/proposals/decision`).send(b);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-harness-rsi-l4-");
    db = createDb(tempDb.connectionString);
    for (const id of [companyId, otherCompanyId]) {
      await db.insert(companies).values({
        id, name: "RSI L4",
        issuePrefix: `HL${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
    }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const kind = req.get("x-test-actor") ?? "board";
      (req as any).actor =
        kind === "none" ? { type: "none" }
        : kind === "agent-other" ? { type: "agent", companyId: randomUUID(), agentId: "a9" }
        : { type: "board", userId: "u1", source: "local_implicit" };
      next();
    });
    app.use("/api", harnessRsiRoutes(db));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("POST /proposals/decision persists approved/rejected/deferred rows (201)", async () => {
    for (const decision of ["approved", "rejected", "deferred"]) {
      const res = await postDecision(decisionBody({ decision, variant: `v-${decision}` }));
      expect(res.status).toBe(201);
      expect(res.body.entry.decision).toBe(decision);
      expect(res.body.entry.companyId).toBe(companyId);
      expect(res.body.entry.verdict).toBeNull();
      expect(res.body.entry.evaluatedAt).toBeNull();
    }
    // omitted baselineJson is captured from the live 24h diagnosis summary
    const auto = await postDecision(decisionBody({ variant: "v-auto", baselineJson: undefined }));
    expect(auto.status).toBe(201);
    expect(auto.body.entry.baselineJson).toEqual({ score: 1, cost: 0 });
  });

  it("rejects invalid decisions and empty required fields (400)", async () => {
    expect((await postDecision(decisionBody({ decision: "maybe" }))).status).toBe(400);
    expect((await postDecision(decisionBody({ variant: "  " }))).status).toBe(400);
    expect((await postDecision(decisionBody({ component: 3 }))).status).toBe(400);
    expect((await postDecision(decisionBody({ decidedBy: "" }))).status).toBe(400);
    expect((await postDecision({ variant: "v", component: "skills", decision: "approved" })).status).toBe(400);
  });

  it("enforces the critic-override guard on critic-failed approvals", async () => {
    const failed = decisionBody({ criticPassed: false });
    expect((await postDecision(failed)).status).toBe(400);
    expect((await postDecision({ ...failed, overrideReason: "short" })).status).toBe(400);
    const ok = await postDecision({
      ...failed, variant: "v-override", overrideReason: "manual review accepted the risk",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.entry.decision).toBe("approved");
    expect(ok.body.entry.overrideReason).toBe("manual review accepted the risk");
    // non-approved decisions never require an override reason
    const rej = await postDecision({ ...failed, decision: "rejected", variant: "v-rej" });
    expect(rej.status).toBe(201);
  });

  it("GET /ledger returns newest-first rows scoped to the company", async () => {
    const now = Date.now();
    await db.insert(harnessRsiLedger).values([
      { companyId, variant: "seed-old", component: "memory", decision: "approved",
        decidedBy: "board", createdAt: new Date(now - 60_000) },
      { companyId, variant: "seed-new", component: "memory", decision: "deferred",
        decidedBy: "board", createdAt: new Date(now) },
      { companyId: otherCompanyId, variant: "v-foreign", component: "memory",
        decision: "approved", decidedBy: "board" },
    ]);
    const res = await request(app).get(`/api/companies/${companyId}/harness-rsi/ledger`);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.entries[0].variant).toBe("seed-new");
    const variants = res.body.entries.map((e: { variant: string }) => e.variant);
    expect(variants).toContain("v-approved");
    expect(variants).not.toContain("v-foreign");
    expect(
      res.body.entries.every((e: { companyId: string }) => e.companyId === companyId),
    ).toBe(true);
    const lim = await request(app).get(`/api/companies/${companyId}/harness-rsi/ledger?limit=1`);
    expect(lim.body.entries).toHaveLength(1);
  });

  it("GET /proposals feeds evaluated ledger rows into history (pruneSet)", async () => {
    await db.insert(harnessRsiLedger).values({
      companyId, round: 3, variant: "v-pruned", component: "plugins",
      decision: "approved", decidedBy: "board",
      deltaScore: -0.2, deltaCost: 0.1, accepted: false, verdict: "rejected",
      evaluatedAt: new Date(),
    });
    const res = await request(app).get(
      `/api/companies/${companyId}/harness-rsi/proposals?round=3&totalRounds=6`,
    );
    expect(res.status).toBe(200);
    // evaluated row with non-positive recent yield -> tried + pruned
    expect(res.body.result.prunedComponents).toContain("plugins");
    // pending decisions (skills/memory rows above) are not tried history
    expect(res.body.result.prunedComponents).not.toContain("skills");
    expect(res.body.result.prunedComponents).not.toContain("memory");
  });

  it("POST /ledger/:entryId/evaluate fills verdict/deltaScore/deltaCost only", async () => {
    const created = await postDecision(decisionBody({
      variant: "v-eval", component: "system_prompt",
      baselineJson: { score: 0.5, cost: 10 },
    }));
    expect(created.status).toBe(201);
    const res = await request(app).post(
      `/api/companies/${companyId}/harness-rsi/ledger/${created.body.entry.id}/evaluate`,
    );
    expect(res.status).toBe(200);
    const { entry, selection } = res.body;
    // empty telemetry -> successRate 1, cost 0 -> clear improvement within bound
    expect(entry.verdict).toBe("winner");
    expect(entry.accepted).toBe(true);
    expect(entry.deltaScore).toBeCloseTo(0.5);
    expect(entry.deltaCost).toBeCloseTo(-1);
    expect(entry.evaluatedAt).toBeTruthy();
    expect(selection.winner?.id).toBe("v-eval");
    // decision fields are untouched by evaluation
    expect(entry.variant).toBe("v-eval");
    expect(entry.decision).toBe("approved");
    expect(entry.decidedBy).toBe("board");
  });

  it("scopes evaluate by company (404 on a foreign entry)", async () => {
    const foreign = await postDecision(decisionBody({ variant: "v-foe" }), otherCompanyId);
    expect(foreign.status).toBe(201);
    const res = await request(app).post(
      `/api/companies/${companyId}/harness-rsi/ledger/${foreign.body.entry.id}/evaluate`,
    );
    expect(res.status).toBe(404);
  });

  it("enforces auth on all ledger routes (401/403)", async () => {
    const ledger = `/api/companies/${companyId}/harness-rsi/ledger`;
    const decision = `/api/companies/${companyId}/harness-rsi/proposals/decision`;
    const evaluate = `${ledger}/${randomUUID()}/evaluate`;
    expect((await request(app).get(ledger).set("x-test-actor", "none")).status).toBe(401);
    expect((await request(app).get(ledger).set("x-test-actor", "agent-other")).status).toBe(403);
    expect((await request(app).post(decision).set("x-test-actor", "none").send(decisionBody())).status).toBe(401);
    expect((await request(app).post(decision).set("x-test-actor", "agent-other").send(decisionBody())).status).toBe(403);
    expect((await request(app).post(evaluate).set("x-test-actor", "none")).status).toBe(401);
    expect((await request(app).post(evaluate).set("x-test-actor", "agent-other")).status).toBe(403);
  });
});
