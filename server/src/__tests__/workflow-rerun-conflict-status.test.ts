import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const STEP_RUN_ID = "99999999-9999-4999-8999-999999999999";
const STEP_ID = "publish-result";

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  logActivity: vi.fn(),
  retryIssueLessToolWorkflowStep: vi.fn(),
}));

vi.mock("../services/workflow/engine.js", () => ({
  workflowService: {
    cancelRun: vi.fn(),
    createDefinition: vi.fn(),
    deleteDefinition: vi.fn(),
    getDefinition: vi.fn(),
    getRun: mocks.getRun,
    listDefinitions: vi.fn(),
    listRuns: vi.fn(),
    listStepRuns: vi.fn(),
    resumeRun: vi.fn(),
    syncRunStatusForIssue: vi.fn(),
    trigger: vi.fn(),
    updateDefinition: vi.fn(),
  },
}));

vi.mock("../services/workflow/dag-engine.js", async (original) => ({
  ...await original<typeof import("../services/workflow/dag-engine.js")>(),
  retryIssueLessToolWorkflowStep: mocks.retryIssueLessToolWorkflowStep,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

function stepRun() {
  return {
    id: STEP_RUN_ID,
    workflowRunId: RUN_ID,
    stepId: STEP_ID,
    issueId: null,
    status: "failed",
  };
}

function dbWithStepRun() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [stepRun()]),
        })),
      })),
    })),
  };
}

function createApp(db: unknown = dbWithStepRun()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: [COMPANY_ID],
      source: "authenticated",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", workflowRoutes(db as never));
  app.use(errorHandler);
  return app;
}

function postRerun() {
  return request(createApp()).post(`/api/workflow-step-runs/${STEP_RUN_ID}/rerun`).send({});
}

describe("workflow step rerun conflict status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRun.mockResolvedValue({
      id: RUN_ID,
      workflowId: WORKFLOW_ID,
      companyId: COMPANY_ID,
      status: "failed",
    });
  });

  it("maps workproduct selector conflicts to a deterministic 409 with diagnostic details", async () => {
    const diagnostic = {
      outcome: "skipped-in-transaction",
      producerStepId: "write-report",
      productId: "77777777-7777-4777-8777-777777777777",
    };
    mocks.retryIssueLessToolWorkflowStep.mockRejectedValue(
      Object.assign(new Error("workproduct_selector_stale_producer"), { diagnostic }),
    );

    const res = await postRerun();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "workproduct_selector_stale_producer",
      details: {
        code: "workproduct_selector_stale_producer",
        diagnostic,
      },
    });
    expect(mocks.retryIssueLessToolWorkflowStep).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      stepId: STEP_ID,
    });
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("maps QA artifact consumer receipt conflicts to 409", async () => {
    mocks.retryIssueLessToolWorkflowStep.mockRejectedValue(
      new Error("qa_artifact_consumer_receipt_required"),
    );

    const res = await postRerun();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "qa_artifact_consumer_receipt_required",
      details: { code: "qa_artifact_consumer_receipt_required" },
    });
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("keeps unexpected internal errors as 500", async () => {
    mocks.retryIssueLessToolWorkflowStep.mockRejectedValue(new Error("db connection lost"));

    const res = await postRerun();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});
