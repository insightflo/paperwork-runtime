// [stage26 s26-w4] step-run decision overlay 시험.
//   - 순수 단위(stub db): 빈 입력 0쿼리 빠른 경로, 미매치 passthrough(키 부재+원본 보존), 최신 결정 선택.
//   - embedded pg: issue_id 정확 매치 / sourceContext.workflowRunId 매치 / resolved 결정 / companyId 격리.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, issues, operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attachStepRunHumanWaitDecisions } from "../services/workflow/step-run-decision-overlay.js";
import type { OperatorDecisionOverlayRow } from "../services/workflow/step-run-decision-overlay.js";

const T0 = new Date("2026-12-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const decisionDefinition = {
  options: [{ id: "approve", label: "Approve", description: null, facts: [], evidenceRefs: [] }],
  actions: [],
  selection: { min: 1, max: 1 },
  comment: { mode: "disabled" as const, label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
};

describe("attachStepRunHumanWaitDecisions (unit, stub db)", () => {
  const stepRun = { id: "s1", workflowRunId: "run-1", issueId: null, status: "running" };

  it("returns [] without touching the db for empty input", async () => {
    const calls = { queries: 0 };
    const db = {
      select: () => { calls.queries += 1; throw new Error("must not query"); },
    } as unknown as Db;
    expect(await attachStepRunHumanWaitDecisions(db, randomUUID(), [])).toEqual([]);
    expect(calls.queries).toBe(0);
  });

  it("passes step runs through untouched when no decision matches", async () => {
    const rows: OperatorDecisionOverlayRow[] = [];
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) }) } as unknown as Db;
    const [result] = await attachStepRunHumanWaitDecisions(db, randomUUID(), [stepRun]);
    expect(result).toEqual(stepRun);
    expect("humanWaitDecision" in result).toBe(false);
  });

  it("prefers the newest decision row (first in the newest-first result)", async () => {
    const rows: OperatorDecisionOverlayRow[] = [
      { decisionId: "d-new", issueId: null, workflowRunId: "run-1", status: "resolved", createdAt: at(1_000), resolvedAt: at(2_000) },
      { decisionId: "d-old", issueId: null, workflowRunId: "run-1", status: "pending", createdAt: at(0), resolvedAt: null },
    ];
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) }) } as unknown as Db;
    const [result] = await attachStepRunHumanWaitDecisions(db, randomUUID(), [stepRun]);
    expect(result.humanWaitDecision).toEqual({
      decisionId: "d-new", status: "resolved", pausedAt: at(1_000).toISOString(), resolvedAt: at(2_000).toISOString(),
    });
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip decision overlay db tests: ${support.reason ?? "unsupported"}`);

describeDb("attachStepRunHumanWaitDecisions (embedded pg)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-step-run-decision-overlay-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedCompany(companyId: string, runId: string) {
    await db.insert(companies).values({ id: companyId, name: `Overlay ${companyId.slice(0, 6)}`, issuePrefix: randomUUID() });
    const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Overlay flow", stepsJson: [] }).returning();
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: definition.id, triggeredBy: "manual" }).returning();
  }

  async function insertDecision(input: {
    companyId: string; issueId?: string | null; workflowRunId?: string | null;
    createdAt: Date; status?: string; resolvedAt?: Date | null;
  }) {
    const resolved = input.status === "resolved";
    const [row] = await db.insert(operatorDecisions).values({
      companyId: input.companyId,
      requestKey: randomUUID(),
      requestHash: randomUUID(),
      interactionType: "single_select",
      title: "Human wait gate",
      description: "",
      sourceType: "workflow_step_human_wait",
      sourceId: input.workflowRunId ?? randomUUID(),
      sourceContext: { missionId: null, workflowId: null, workflowRunId: input.workflowRunId ?? null, artifactRefs: [] },
      issueId: input.issueId ?? null,
      status: input.status ?? "pending",
      resolvedAt: input.resolvedAt ?? null,
      createdAt: input.createdAt,
      resolvedByUserId: resolved ? "operator-1" : null,
      result: resolved ? { actionId: "approve", outcome: "approve", selectedOptionIds: ["approve"], comment: null } : null,
      definition: decisionDefinition,
    }).returning();
    return row;
  }

  it("enriches step runs by issueId and sourceContext run, keeps no-match passthrough, and isolates companies", async () => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    const runId = randomUUID(), foreignRunId = randomUUID();
    await seedCompany(companyId, runId);
    await seedCompany(foreignCompanyId, foreignRunId);
    const [issue] = await db.insert(issues).values({ companyId, title: "Gate step" }).returning();
    const [stepByIssue] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "produce", issueId: issue.id, status: "running" }).returning();
    const [stepByRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "review", status: "running" }).returning();
    const [foreignStep] = await db.insert(workflowStepRuns).values({ workflowRunId: foreignRunId, stepId: "deploy", status: "running" }).returning();

    const ownIssueResolved = await insertDecision({ companyId, issueId: issue.id, createdAt: at(4_000), status: "resolved", resolvedAt: at(5_000) });
    const ownRunPending = await insertDecision({ companyId, workflowRunId: runId, createdAt: at(1_000) });
    // 타사 결정이 A사 runId 문자열을 sourceContext 로 갖고 있어도 companyId 스코프로 유출되지 않는다.
    const foreignDecision = await insertDecision({ companyId: foreignCompanyId, workflowRunId: runId, createdAt: at(9_000) });

    const [enrichedByIssue, enrichedByRun, foreignResult] = await attachStepRunHumanWaitDecisions(db, companyId, [
      { ...stepByIssue }, { ...stepByRun }, { ...foreignStep },
    ]);
    // 같은 issueId 의 여러 결정 중 최신(resolved)이 이긴다.
    expect(enrichedByIssue.humanWaitDecision).toEqual({
      decisionId: ownIssueResolved.id, status: "resolved", pausedAt: at(4_000).toISOString(), resolvedAt: at(5_000).toISOString(),
    });
    // run 매치는 자사 pending 결정이며, 더 최신인 타사 결정(at(9_000))은 격리돼 유출되지 않는다.
    expect(enrichedByRun.humanWaitDecision).toEqual({
      decisionId: ownRunPending.id, status: "pending", pausedAt: at(1_000).toISOString(), resolvedAt: null,
    });
    expect(enrichedByRun.humanWaitDecision?.decisionId).not.toBe(foreignDecision.id);
    expect("humanWaitDecision" in foreignResult).toBe(false);

    // 외사 스코프 호출: 자사 run B 에 매치할 결정이 없으므로 passthrough.
    const [foreignAgain] = await attachStepRunHumanWaitDecisions(db, foreignCompanyId, [{ ...foreignStep }]);
    expect("humanWaitDecision" in foreignAgain).toBe(false);
    expect(foreignAgain.workflowRunId).toBe(foreignRunId);
    expect(stepByIssue.status).toBe("running");
  });

  it("returns [] for empty input", async () => {
    expect(await attachStepRunHumanWaitDecisions(db, randomUUID(), [])).toEqual([]);
  });
});
