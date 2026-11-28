import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { lintWorkflowDefinitionSelectors } from "../services/workflow/workflow-definition-selector-lint.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";

const mockWorkflowService = vi.hoisted(() => ({
  createDefinition: vi.fn(),
  getDefinition: vi.fn(),
  updateDefinition: vi.fn(),
}));

vi.mock("../services/workflow/engine.js", () => ({ workflowService: mockWorkflowService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../services/issues.js", () => ({ issueService: { getById: vi.fn(), update: vi.fn() } }));
// s8c 정의 경고 기계는 본 스위트 소유가 아니다 — 라우트 렌더링만 격리하기 위해 고정한다.
vi.mock("../services/workflow/workflow-core-client-s8c.js", () => ({
  findWorkflowDefinitionStepWarningsWithNodeFallback: vi.fn(async () => []),
  summarizeDefinitionStepWarningsWithNodeFallback: vi.fn(async () => []),
}));

const boardActor = {
  type: "board",
  userId: "board-user-1",
  companyIds: [COMPANY_ID],
  source: "authenticated",
  isInstanceAdmin: true,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = boardActor;
    next();
  });
  app.use("/api", workflowRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function definition(steps: unknown) {
  return {
    id: WORKFLOW_ID,
    companyId: COMPANY_ID,
    name: "Selector lint fixture",
    status: "active",
    steps,
    createdAt: new Date("2026-06-11T00:00:00.000Z"),
    updatedAt: new Date("2026-06-11T01:00:00.000Z"),
  };
}

// 셀렉터 타입 미스매치 + 정의에 없는 step 참조를 한 번에 걸리는 fixture.
const lintSteps = [
  { id: "fetch-report", title: "Fetch report", dependencies: [] },
  {
    id: "summarize",
    title: "Summarize",
    dependencies: ["fetch-report"],
    toolArgs: {
      inputPath: "{$steps.fetch-report.workProductPath}",
      siblingDir: "{$steps.ghost-step.siblingAssetsDir}",
    },
    workProductSelectors: { "fetch-report": { type: "artifact", title: "content.json" } },
  },
];

const summarizeHint = { stepId: "summarize", referencedStepId: "fetch-report", code: "selector_type_mismatch_hint" };
const ghostMissing = { stepId: "summarize", referencedStepId: "ghost-step", code: "missing_upstream_step" };

describe("lintWorkflowDefinitionSelectors (pure helper)", () => {
  it("returns [] for non-array or empty steps input", () => {
    expect(lintWorkflowDefinitionSelectors(undefined)).toEqual([]);
    expect(lintWorkflowDefinitionSelectors(null)).toEqual([]);
    expect(lintWorkflowDefinitionSelectors("nope")).toEqual([]);
    expect(lintWorkflowDefinitionSelectors([])).toEqual([]);
  });

  it("flags a workProductPath reference to a step that does not exist", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "a", toolArgs: { path: "{$steps.missing-step.workProductPath}" } },
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ stepId: "a", referencedStepId: "missing-step", code: "missing_upstream_step" }),
    ]);
  });

  it("flags missing_dependency and missing_work_product_selector as independent findings", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "producer", dependencies: [] },
      { id: "middle", dependencies: ["producer"] },
      { id: "consumer", dependencies: [], toolArgs: { path: "{$steps.producer.workProductPath}" } },
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ stepId: "consumer", referencedStepId: "producer", code: "missing_dependency" }),
      expect.objectContaining({ stepId: "consumer", referencedStepId: "producer", code: "missing_work_product_selector" }),
    ]);
  });

  it("accepts direct and transitive dependency closure without warnings", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "producer", dependencies: [] },
      { id: "middle", dependencies: ["producer"] },
      {
        id: "consumer",
        dependencies: ["middle"],
        toolArgs: { list: ["{$steps.producer.workProductPath}", "{$steps.middle.siblingAssetsDir}"] },
        workProductSelectors: { producer: { type: "document", title: "content.json" } },
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("flags missing_work_product_selector only for workProductPath references without a selector", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "producer", dependencies: [] },
      {
        id: "consumer",
        dependencies: ["producer"],
        toolArgs: { path: "{$steps.producer.workProductPath}", dir: "{$steps.producer.siblingAssetsDir}" },
      },
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ stepId: "consumer", referencedStepId: "producer", code: "missing_work_product_selector" }),
    ]);
  });

  it("hints selector_type_mismatch only for content.json selectors that are not type document", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "producer", dependencies: [] },
      {
        id: "good", dependencies: ["producer"], toolArgs: "{$steps.producer.workProductPath}",
        workProductSelectors: { producer: { type: "document", title: "content.json" } },
      },
      {
        id: "bad", dependencies: ["producer"], toolArgs: "{$steps.producer.workProductPath}",
        workProductSelectors: { producer: { type: "artifact", title: "content.json" } },
      },
      {
        id: "other-title", dependencies: ["producer"], toolArgs: "{$steps.producer.workProductPath}",
        workProductSelectors: { producer: { type: "artifact", title: "report.html" } },
      },
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ stepId: "bad", referencedStepId: "producer", code: "selector_type_mismatch_hint" }),
    ]);
  });

  it("scans nested toolArgs recursively and dedupes repeated references", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "a", dependencies: [] },
      {
        id: "b",
        dependencies: ["a"],
        toolArgs: { deep: { list: ["{$steps.a.workProductPath}", { inner: "{$steps.a.siblingAssetsDir}" }] } },
      },
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ stepId: "b", referencedStepId: "a", code: "missing_work_product_selector" }),
    ]);
  });

  it("is deterministic and never throws on malformed steps", () => {
    const malformed = [
      null,
      42,
      { toolArgs: "{$steps.x.workProductPath}" },
      { id: "b", dependencies: "oops", toolArgs: { nested: ["{$steps.ghost.siblingAssetsDir}"] } },
      { id: "a" },
    ];
    const first = lintWorkflowDefinitionSelectors(malformed);
    const second = lintWorkflowDefinitionSelectors(malformed);
    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({ stepId: "b", referencedStepId: "ghost", code: "missing_upstream_step" }),
    ]);
  });

  it("orders warnings by step order then first reference appearance", () => {
    const warnings = lintWorkflowDefinitionSelectors([
      { id: "late", dependencies: [], toolArgs: "{$steps.ghost.siblingAssetsDir} {$steps.early.siblingAssetsDir}" },
      { id: "early", dependencies: [] },
    ]);
    expect(warnings.map((w) => [w.stepId, w.referencedStepId, w.code])).toEqual([
      ["late", "ghost", "missing_upstream_step"],
      ["late", "early", "missing_dependency"],
    ]);
  });
});

describe("workflow definition routes: selectorLintWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST create includes selectorLintWarnings when saved steps violate selector rules", async () => {
    mockWorkflowService.createDefinition.mockResolvedValue(definition(lintSteps));
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/workflows`)
      .send({ name: "Selector lint fixture", steps: lintSteps });

    expect(res.status).toBe(201);
    expect(res.body.selectorLintWarnings).toEqual([
      expect.objectContaining(summarizeHint),
      expect.objectContaining(ghostMissing),
    ]);
    expect(res.body.warnings).toEqual([]);
  });

  it("POST create omits selectorLintWarnings entirely when there are no warnings", async () => {
    mockWorkflowService.createDefinition.mockResolvedValue(definition([{ id: "solo", dependencies: [] }]));
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/workflows`)
      .send({ name: "Clean", steps: [{ id: "solo", dependencies: [] }] });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("selectorLintWarnings");
    expect(res.body.warnings).toEqual([]);
  });

  it("PATCH with steps includes selectorLintWarnings; PATCH without steps omits the field", async () => {
    mockWorkflowService.getDefinition.mockResolvedValue(definition([]));
    mockWorkflowService.updateDefinition.mockResolvedValue(definition(lintSteps));
    const patched = await request(createApp())
      .patch(`/api/workflows/${WORKFLOW_ID}`)
      .send({ steps: lintSteps });

    expect(patched.status).toBe(200);
    expect(patched.body.selectorLintWarnings).toEqual([
      expect.objectContaining(summarizeHint),
      expect.objectContaining(ghostMissing),
    ]);

    mockWorkflowService.updateDefinition.mockResolvedValue(definition([{ id: "solo", dependencies: [] }]));
    const renamed = await request(createApp())
      .patch(`/api/workflows/${WORKFLOW_ID}`)
      .send({ name: "Renamed only" });

    expect(renamed.status).toBe(200);
    expect(renamed.body).not.toHaveProperty("selectorLintWarnings");
  });
});
