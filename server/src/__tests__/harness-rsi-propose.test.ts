import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { editBudget, type RrsiCandidate } from "../services/harness-rsi/rrsi-selection.js";
import type { EditHistoryRecord } from "../services/harness-rsi/rrsi-history.js";
import type { HarnessBottleneck, HarnessDiagnosisReport } from "../services/harness-rsi/telemetry-diagnose.js";
import {
  evaluateProposalCandidate,
  proposeHarnessCandidates,
} from "../services/harness-rsi/proposal-loop.js";
import { harnessRsiRoutes } from "../routes/harness-rsi.js";
import { errorHandler } from "../middleware/error-handler.js";

const bn = (over: Partial<HarnessBottleneck>): HarnessBottleneck => ({
  component: "tool_guidance", severity: "medium", metric: "m",
  hypothesis: "serial LLM work sets a high latency floor",
  recommendedAction: "split the step and parallelize", ...over,
});
const report = (bottlenecks: HarnessBottleneck[]): HarnessDiagnosisReport => ({
  summary: { totalRuns: 1, successRate: 1, avgDurationMs: 1, p90DurationMs: 1,
    selfBlockCancels: 0, lockTimeouts: 0, highTokenRuns: 0, slowRuns: 0 },
  bottlenecks,
});
const rec = (over: Partial<EditHistoryRecord>): EditHistoryRecord => ({
  round: 1, variant: "v", component: "skills", hypothesis: "h", diffRef: "d",
  deltaScore: 0, deltaCost: 0, accepted: false, verdict: "rejected", ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => bn({ metric: `m${i}` }));

describe("proposeHarnessCandidates", () => {
  it("caps proposals at the annealed edit budget, then maxCandidates", () => {
    const r1 = proposeHarnessCandidates({ report: report(many(5)), round: 1, totalRounds: 6 });
    expect(r1.budget).toBe(editBudget(1, 6, 1, 3));
    expect(r1.proposals.length).toBe(editBudget(1, 6, 1, 3));
    const last = proposeHarnessCandidates({ report: report(many(5)), round: 6, totalRounds: 6 });
    expect(last.proposals.length).toBe(1); // t = T -> bMin
    const capped = proposeHarnessCandidates({
      report: report(many(5)), round: 1, totalRounds: 6, maxCandidates: 2,
    });
    expect(capped.budget).toBe(2);
    expect(capped.proposals.length).toBe(2);
  });

  it("suppresses pruneSet components but keeps high severity", () => {
    const history = [
      rec({ component: "skills", round: 3, deltaScore: -0.2 }),
      rec({ component: "memory", round: 3, deltaScore: 0.5, accepted: true, verdict: "winner" }),
    ];
    const out = proposeHarnessCandidates({
      report: report([
        bn({ component: "skills", severity: "medium", metric: "pruned-med" }),
        bn({ component: "skills", severity: "high", metric: "pruned-high" }),
        bn({ component: "memory", severity: "low", metric: "kept" }),
      ]),
      history, round: 3, totalRounds: 6, maxCandidates: 10,
    });
    expect(out.prunedComponents).toContain("skills");
    const metrics = out.proposals.map((p) => p.targetMetric);
    expect(metrics).not.toContain("pruned-med");
    expect(metrics).toContain("pruned-high");
    expect(metrics).toContain("kept");
  });

  it("flags secrets and tenant-specific content via the stateless critic", () => {
    const out = proposeHarnessCandidates({
      report: report([bn({
        component: "adapter_config", severity: "high", metric: "leak",
        hypothesis: 'hardcode api_key: "sk-abcdefghijklmnop1234" for this company',
        recommendedAction: "deploy it to /srv/papercompany/runtime",
      })]),
    });
    const codes = out.proposals[0]!.critic.objections.map((o) => o.code);
    expect(out.proposals[0]!.critic.pass).toBe(false);
    expect(codes).toContain("hardcoded-secret");
    expect(codes).toContain("tenant-hardcoding");
    const clean = proposeHarnessCandidates({ report: report([bn({})]) });
    expect(clean.proposals[0]!.critic.pass).toBe(true);
  });

  it("pins requiresApproval=true and autoApply=false on every proposal", () => {
    const out = proposeHarnessCandidates({ report: report(many(3)) });
    expect(out.proposals.length).toBeGreaterThan(0);
    for (const p of out.proposals) {
      expect(p.requiresApproval).toBe(true);
      expect(p.autoApply).toBe(false);
      expect(p.id).toContain("rrsi-");
    }
  });
});

describe("evaluateProposalCandidate", () => {
  const baseline = { score: 0.8, cost: 10 };
  const cand = (over: Partial<RrsiCandidate>): RrsiCandidate => ({
    id: "c1", score: 0.95, cost: 10.5, components: ["skills"], ...over,
  });

  it("accepts a clear improvement within the cost bound and emits a ledger entry", () => {
    const { selection, ledgerEntry } = evaluateProposalCandidate({
      baseline, candidate: cand({}), meta: { round: 4, hypothesis: "h", diffRef: "d1" },
    });
    expect(selection.winner?.id).toBe("c1");
    expect(ledgerEntry).toMatchObject({ round: 4, component: "skills", accepted: true, verdict: "winner" });
    expect(ledgerEntry.deltaScore).toBeCloseTo(0.15);
  });

  it("rejects a candidate under the noise floor and records the rejection", () => {
    const { selection, ledgerEntry } = evaluateProposalCandidate({
      baseline, candidate: cand({ id: "weak", score: 0.7 }),
    });
    expect(selection.winner).toBeNull();
    expect(selection.decisions[0]?.reason).toContain("below-noise-floor");
    expect(ledgerEntry.accepted).toBe(false);
    expect(ledgerEntry.verdict).toBe("rejected");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping harness-rsi stage-3 route tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("harness-rsi stage 3 routes", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: express.Express;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-harness-rsi-p3-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId, name: "RSI P3",
      issuePrefix: `HP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: randomUUID(), companyId, name: "eng-1", role: "engineer",
      adapterType: "commandcode_local", adapterConfig: { thinking: "max" },
    });
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

  it("GET /proposals returns approval-gated results and honors round/window params", async () => {
    const res = await request(app).get(`/api/companies/${companyId}/harness-rsi/proposals`);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.windowHours).toBe(24);
    expect(res.body.result.round).toBe(1);
    expect(res.body.result.budget).toBe(editBudget(1, 6, 1, 3));
    expect(res.body.result.proposals.length).toBeGreaterThan(0);
    const props = res.body.result.proposals as Array<{ requiresApproval: boolean; autoApply: boolean }>;
    expect(props.every((p) => p.requiresApproval && p.autoApply === false)).toBe(true);
    const late = await request(app).get(
      `/api/companies/${companyId}/harness-rsi/proposals?round=6&totalRounds=6&windowHours=48`,
    );
    expect(late.body.windowHours).toBe(48);
    expect(late.body.result.budget).toBe(1);
  });

  it("GET /proposals enforces company access (401/403)", async () => {
    const url = `/api/companies/${companyId}/harness-rsi/proposals`;
    expect((await request(app).get(url).set("x-test-actor", "none")).status).toBe(401);
    expect((await request(app).get(url).set("x-test-actor", "agent-other")).status).toBe(403);
  });

  it("POST /screen validates diffText and runs the critic statelessly", async () => {
    const url = `/api/companies/${companyId}/harness-rsi/screen`;
    expect((await request(app).post(url).send({})).status).toBe(400);
    expect((await request(app).post(url).send({ diffText: 42 })).status).toBe(400);

    const clean = await request(app).post(url).send({ diffText: "+const x = 1\n" });
    expect(clean.status).toBe(200);
    expect(clean.body.critic.pass).toBe(true);
    expect(clean.body.selection).toBeNull();

    const leaky = await request(app).post(url).send({
      diffText: '+const k = "sk-abcdefghijklmnop1234"\n',
      baseline: { score: 0.8, cost: 10 },
      candidate: { id: "c1", score: 0.9, cost: 10, components: ["skills"] },
    });
    expect(leaky.body.critic.pass).toBe(false);
    expect(leaky.body.critic.objections[0].code).toBe("hardcoded-secret");
    expect(leaky.body.selection.winner?.id).toBe("c1");

    // Malformed optional selection inputs return 400 (never 500)
    expect((await request(app).post(url).send({ diffText: "+ok", baseline: { score: 0.8, cost: 10 }, candidate: { id: "c1", score: 0.9, cost: 10 } })).status).toBe(400);
    expect((await request(app).post(url).send({ diffText: "+ok", baseline: { score: 0.8, cost: 10 }, candidate: "bad" })).status).toBe(400);
    expect((await request(app).post(url).send({ diffText: "+ok", baseline: { score: 0.8, cost: 10 }, candidate: { id: "c1", score: 0.9, cost: 10, components: ["skills"] }, policy: { config: { guards: "bad" } } })).status).toBe(400);
  });

  it("POST /screen enforces company access (401/403)", async () => {
    const url = `/api/companies/${companyId}/harness-rsi/screen`;
    const body = { diffText: "+ok" };
    expect((await request(app).post(url).set("x-test-actor", "none").send(body)).status).toBe(401);
    expect((await request(app).post(url).set("x-test-actor", "agent-other").send(body)).status).toBe(403);
  });
});
