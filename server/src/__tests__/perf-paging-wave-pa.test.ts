import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityService } from "../services/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { missionRoutes } from "../routes/missions.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockMissionService = vi.hoisted(() => ({
  readCompanyId: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    finalizeLinkedRunsForIssueStatus: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
  workflowService: { syncRunStatusForIssue: vi.fn(async () => undefined) },
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

vi.mock("../services/missions.js", () => ({
  missionService: () => mockMissionService,
}));

vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return { ...actual, issueService: () => mockIssueService };
});

function createApp(router: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", router as any);
  app.use(errorHandler);
  return app;
}

function makeSelectChain() {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  chain.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
  return chain;
}

describe("perf paging wave PA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockMissionService.readCompanyId.mockResolvedValue("company-1");
  });

  it("clamps issue list limit to 200 and forwards zero offset and missionId", async () => {
    const res = await request(createApp(issueRoutes({} as any, {} as any))).get(
      "/api/companies/company-1/issues?limit=500&offset=0&missionId=mission-1",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ limit: 200, offset: 0, missionId: "mission-1" }),
    );
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("uses zero as the default issue list offset", async () => {
    const res = await request(createApp(issueRoutes({} as any, {} as any))).get(
      "/api/companies/company-1/issues?offset=not-a-number",
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ offset: 0 }),
    );
  });

  it("pushes missionId, limit, and offset into the mission issues list query", async () => {
    mockIssueService.list.mockResolvedValue([{ id: "issue-1" }]);

    const res = await request(createApp(missionRoutes({} as any))).get(
      "/api/missions/mission-1/issues?limit=500&offset=3",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "issue-1" }]);
    expect(mockMissionService.readCompanyId).toHaveBeenCalledWith("mission-1");
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ missionId: "mission-1", view: "full", limit: 200, offset: 3 }),
    );
  });

  it("forwards run pagination from the issue runs endpoint", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const chain = makeSelectChain();
    const db = { select: vi.fn(() => chain) };
    mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-1" });

    const res = await request(createApp(issueRoutes(db as any, {} as any))).get(
      `/api/issues/${issueId}/runs?limit=500&offset=3`,
    );

    expect(res.status).toBe(200);
    expect(chain.limit).toHaveBeenCalledWith(100);
    expect(chain.offset).toHaveBeenCalledWith(3);
  });

  it("defaults runsForIssue to limit 20 and offset 0", async () => {
    const chain = makeSelectChain();
    const db = { select: vi.fn(() => chain) };

    await activityService(db as any).runsForIssue("company-1", "issue-1");

    expect(chain.limit).toHaveBeenCalledWith(20);
    expect(chain.offset).toHaveBeenCalledWith(0);
  });

  it("clamps explicit runsForIssue limit to 100 and preserves offset", async () => {
    const chain = makeSelectChain();
    const db = { select: vi.fn(() => chain) };

    await activityService(db as any).runsForIssue("company-1", "issue-1", { limit: 500, offset: 7 });

    expect(chain.limit).toHaveBeenCalledWith(100);
    expect(chain.offset).toHaveBeenCalledWith(7);
  });
});
