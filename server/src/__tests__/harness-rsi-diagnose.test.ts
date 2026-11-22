import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, workflowDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  diagnoseHarnessTelemetry,
  type HarnessTelemetryInput,
  type HarnessTelemetryRun,
} from "../services/harness-rsi/telemetry-diagnose.js";
import { harnessRsiRoutes } from "../routes/harness-rsi.js";

const MIN = 60_000;
const run = (over: Partial<HarnessTelemetryRun>): HarnessTelemetryRun => ({
  id: randomUUID(), status: "succeeded", durationMs: 3 * MIN, outputTokens: 2_000,
  errorCode: null, error: null, stepTitle: null, adapterType: "process", ...over,
});
const input = (over: Partial<HarnessTelemetryInput>): HarnessTelemetryInput => ({
  runs: [], agents: [], workflows: [], ...over,
});
const serialSteps = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    title: `step-${i + 1}`,
    dependencies: i === 0 ? [] : [`s${i}`],
  }));

describe("diagnoseHarnessTelemetry", () => {
  it("reports zero bottlenecks on a clean healthy baseline", () => {
    const report = diagnoseHarnessTelemetry(input({
      runs: Array.from({ length: 10 }, () => run({})),
    }));
    expect(report.summary.totalRuns).toBe(10);
    expect(report.summary.successRate).toBe(1);
    expect(report.summary.avgDurationMs).toBe(3 * MIN);
    expect(report.summary.p90DurationMs).toBe(3 * MIN);
    expect(report.bottlenecks).toEqual([]);
  });

  it("flags a step averaging >=15m as a tool_guidance bottleneck", () => {
    const report = diagnoseHarnessTelemetry(input({
      runs: [
        run({ stepTitle: "draft-report", durationMs: 20 * MIN }),
        run({ stepTitle: "draft-report", durationMs: 16 * MIN }),
        run({ stepTitle: "lint", durationMs: 2 * MIN }),
      ],
    }));
    const hit = report.bottlenecks.find((b) => b.component === "tool_guidance");
    expect(hit?.metric).toBe("step_avg_duration_ms:draft-report");
    expect(report.summary.slowRuns).toBe(2);
    expect(report.bottlenecks.some((b) => b.metric.includes("lint"))).toBe(false);
  });

  it("flags >=30k output-token runs as adapter_config", () => {
    const report = diagnoseHarnessTelemetry(input({
      runs: [run({ outputTokens: 45_000 }), run({})],
    }));
    expect(report.summary.highTokenRuns).toBe(1);
    const hit = report.bottlenecks.find((b) => b.component === "adapter_config");
    expect(hit?.metric).toBe("high_token_runs");
  });

  it("flags 55P03 / issue_status_blocked runs as guardrails", () => {
    const report = diagnoseHarnessTelemetry(input({
      runs: [
        run({ status: "failed", errorCode: "55P03", error: "lock timeout" }),
        run({ status: "cancelled", errorCode: "issue_status_blocked" }),
        run({ status: "cancelled", errorCode: "issue_status_blocked" }),
        run({}),
      ],
    }));
    expect(report.summary.lockTimeouts).toBe(1);
    expect(report.summary.selfBlockCancels).toBe(2);
    expect(report.bottlenecks.find((b) => b.component === "guardrails")?.severity).toBe("high");
  });

  it("surfaces config-hygiene warnings (max thinking agent, >5-depth workflow)", () => {
    const report = diagnoseHarnessTelemetry(input({
      agents: [{
        id: "a1", role: "engineer", adapterType: "commandcode_local",
        adapterConfig: { thinking: "max" },
      }],
      workflows: [{ id: "w1", name: "chain", steps: serialSteps(6) }],
    }));
    const has = (component: string, code: string) =>
      report.bottlenecks.some((b) => b.component === component && b.metric.includes(code));
    expect(has("adapter_config", "agent_excessive_thinking")).toBe(true);
    expect(has("workflow_dag", "workflow_serial_llm_depth_high")).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping harness-rsi route tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("GET /api/companies/:companyId/harness-rsi/diagnose", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-harness-rsi-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "u1", source: "local_implicit" };
      next();
    });
    app.use("/api", harnessRsiRoutes(db));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 200 with a report from recent telemetry and clamps windowHours", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const now = Date.now();
    await db.insert(companies).values({
      id: companyId,
      name: "RSI Co",
      issuePrefix: `HR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "eng-1",
      role: "engineer",
      adapterType: "commandcode_local",
      adapterConfig: { thinking: "max" },
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "chain",
      status: "active",
      stepsJson: serialSteps(6),
    });
    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(now - 20 * MIN),
        finishedAt: new Date(now),
        usageJson: { outputTokens: 40_000 },
        contextSnapshot: { workflowDefinitionId: workflowId, workflowStepId: "s1" },
        createdAt: new Date(now),
      },
      {
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date(now - 2 * MIN),
        finishedAt: new Date(now),
        usageJson: { outputTokens: 1_000 },
        createdAt: new Date(now),
      },
    ]);

    const res = await request(app).get(`/api/companies/${companyId}/harness-rsi/diagnose`);
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.windowHours).toBe(24);
    expect(res.body.report.summary.totalRuns).toBe(2);
    expect(res.body.report.summary.highTokenRuns).toBe(1);
    expect(res.body.report.summary.slowRuns).toBe(1);
    const components = res.body.report.bottlenecks.map((b: { component: string }) => b.component);
    expect(components).toContain("tool_guidance");
    expect(components).toContain("adapter_config");
    expect(components).toContain("workflow_dag");

    const get = async (q: string) =>
      (await request(app).get(`/api/companies/${companyId}/harness-rsi/diagnose?windowHours=${q}`))
        .body.windowHours;
    expect(await get("9999")).toBe(168);
    expect(await get("0")).toBe(1);
    expect(await get("abc")).toBe(24);
  });
});
