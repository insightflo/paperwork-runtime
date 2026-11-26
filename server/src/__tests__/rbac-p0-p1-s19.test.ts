import express from "express";
import type { Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { assertCompanyWriteAccess } from "../routes/authz.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { costRoutes } from "../routes/costs.js";
import { channelConfigRoutes } from "../routes/channel-config.js";
import { schedulerRoutes } from "../routes/scheduler.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const KEY_A = "44444444-4444-4444-8444-444444444444";
const RUN_A = "55555555-5555-4555-8555-555555555555";
const APPROVAL_A = "66666666-6666-4666-8666-666666666666";
const SCHEDULE_A = "77777777-7777-4777-8777-777777777777";

const mockAccessService = vi.hoisted(() => ({
  getMembership: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  update: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  pauseAgent: vi.fn(),
  resumeAgent: vi.fn(),
  resumeQueuedRuns: vi.fn(),
  terminateAgent: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  wakeup: vi.fn(),
  invoke: vi.fn(),
  cancelBudgetScopeWork: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
}));

const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockScheduleStore = vi.hoisted(() => ({
  listSchedules: vi.fn(),
  createSchedule: vi.fn(),
  getScheduleById: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  getSchedulerState: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  approvalService: () => mockApprovalService,
  budgetService: () => mockBudgetService,
  companyService: () => mockCompanyService,
  companySkillService: () => ({}),
  costService: () => mockCostService,
  financeService: () => mockFinanceService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  mergeAgentConfig: () => ({}),
  secretService: () => mockSecretService,
  splitAgentLevelKeys: () => ({ agentConfig: {} }),
  syncInstructionsBundleConfigFromFilePath: (_a: unknown, c: unknown) => c,
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/card-summaries.js", () => ({
  cardSummaryService: () => ({
    getRow: vi.fn().mockResolvedValue(null),
    getRows: vi.fn().mockResolvedValue(new Map()),
    ensureSummary: vi.fn().mockResolvedValue(null),
    retranslate: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock("../services/scheduler/index.js", () => ({
  scheduleStore: mockScheduleStore,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function makeChannelDbStub() {
  const row = {
    id: "chan-1",
    companyId: COMPANY_A,
    kind: "telegram",
    enabled: true,
    configJson: { botUsername: "test_bot", botTokenSecretId: "sec-1" },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([row]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>, db: unknown = makeChannelDbStub()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use("/api", approvalRoutes(db as any));
  app.use("/api", costRoutes(db as any));
  app.use("/api", channelConfigRoutes(db as any));
  app.use("/api", schedulerRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function boardActor(userId: string, companyIds: string[] = [COMPANY_A]) {
  return {
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds,
  };
}

function mockRole(role: "owner" | "admin" | "member" | "viewer" | null) {
  mockAccessService.getMembership.mockResolvedValue(
    role ? { status: "active", membershipRole: role } : null,
  );
  mockAccessService.canUser.mockResolvedValue(false);
}

describe("Stage 19 RBAC: assertCompanyWriteAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows local_implicit board actors", async () => {
    const req = { actor: { type: "board", source: "local_implicit" } } as Request;
    await expect(assertCompanyWriteAccess(mockAccessService, req, COMPANY_A)).resolves.toBeUndefined();
    expect(mockAccessService.getMembership).not.toHaveBeenCalled();
  });

  it("allows isInstanceAdmin board actors", async () => {
    const req = {
      actor: { type: "board", source: "session", userId: "admin-1", isInstanceAdmin: true },
    } as Request;
    await expect(assertCompanyWriteAccess(mockAccessService, req, COMPANY_A)).resolves.toBeUndefined();
    expect(mockAccessService.getMembership).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "member"] as const)("allows %s membership role", async (role) => {
    mockRole(role);
    const req = { actor: boardActor("user-1") } as unknown as Request;
    await expect(assertCompanyWriteAccess(mockAccessService, req, COMPANY_A)).resolves.toBeUndefined();
  });

  it("allows same-company agent actors", async () => {
    const req = {
      actor: { type: "agent", companyId: COMPANY_A, agentId: AGENT_A },
    } as Request;
    await expect(assertCompanyWriteAccess(mockAccessService, req, COMPANY_A)).resolves.toBeUndefined();
    expect(mockAccessService.getMembership).not.toHaveBeenCalled();
  });

  it("rejects viewer role with 403 Viewer role is read-only", async () => {
    mockRole("viewer");
    const req = { actor: boardActor("viewer-1") } as unknown as Request;
    await expect(assertCompanyWriteAccess(mockAccessService, req, COMPANY_A)).rejects.toMatchObject({
      status: 403,
      message: "Viewer role is read-only",
    });
    try {
      await assertCompanyWriteAccess(mockAccessService, req, COMPANY_A);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
    }
  });
});

describe("Stage 19 P0: agents.ts IDOR & RBAC guards", () => {
  const agentRow = {
    id: AGENT_A,
    companyId: COMPANY_A,
    name: "Worker",
    role: "engineer",
    status: "idle",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(agentRow);
    mockAgentService.listKeys.mockResolvedValue([{ id: KEY_A, name: "k1" }]);
    mockAgentService.createApiKey.mockResolvedValue({ id: KEY_A, name: "k1", token: "tok" });
    mockAgentService.revokeKey.mockResolvedValue({ id: KEY_A });
    mockAgentService.remove.mockResolvedValue(agentRow);
    mockHeartbeatService.pauseAgent.mockResolvedValue({ ...agentRow, status: "paused" });
    mockHeartbeatService.resumeAgent.mockResolvedValue({ ...agentRow, status: "idle" });
    mockHeartbeatService.resumeQueuedRuns.mockResolvedValue(undefined);
    mockHeartbeatService.terminateAgent.mockResolvedValue({ ...agentRow, status: "terminated" });
    mockHeartbeatService.getRun.mockResolvedValue({ id: RUN_A, companyId: COMPANY_A, agentId: AGENT_A });
    mockHeartbeatService.cancelRun.mockResolvedValue({ id: RUN_A, companyId: COMPANY_A, agentId: AGENT_A, status: "cancelled" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects cross-company board actor with 403 on P0 agent routes", async () => {
    mockRole("owner");
    const crossCompany = createApp(boardActor("other-owner", [COMPANY_B]));

    expect((await request(crossCompany).post(`/api/agents/${AGENT_A}/keys`).send({ name: "stolen" })).status).toBe(403);
    expect((await request(crossCompany).get(`/api/agents/${AGENT_A}/keys`)).status).toBe(403);
    expect((await request(crossCompany).delete(`/api/agents/${AGENT_A}/keys/${KEY_A}`)).status).toBe(403);
    expect((await request(crossCompany).post(`/api/agents/${AGENT_A}/pause`)).status).toBe(403);
    expect((await request(crossCompany).post(`/api/agents/${AGENT_A}/resume`)).status).toBe(403);
    expect((await request(crossCompany).post(`/api/agents/${AGENT_A}/terminate`)).status).toBe(403);
    expect((await request(crossCompany).delete(`/api/agents/${AGENT_A}`)).status).toBe(403);
    expect((await request(crossCompany).post(`/api/heartbeat-runs/${RUN_A}/cancel`)).status).toBe(403);

    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
    expect(mockAgentService.listKeys).not.toHaveBeenCalled();
    expect(mockHeartbeatService.pauseAgent).not.toHaveBeenCalled();
    expect(mockAgentService.remove).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("rejects same-company viewer with 403 on P0 mutating agent routes, allows GET keys", async () => {
    mockRole("viewer");
    const viewerApp = createApp(boardActor("viewer-1", [COMPANY_A]));

    expect((await request(viewerApp).post(`/api/agents/${AGENT_A}/keys`).send({ name: "k" })).status).toBe(403);
    expect((await request(viewerApp).post(`/api/agents/${AGENT_A}/pause`)).status).toBe(403);
    expect((await request(viewerApp).delete(`/api/agents/${AGENT_A}`)).status).toBe(403);
    expect((await request(viewerApp).post(`/api/heartbeat-runs/${RUN_A}/cancel`)).status).toBe(403);
    expect((await request(viewerApp).get(`/api/agents/${AGENT_A}/keys`)).status).toBe(200);
  });

  it("allows same-company admin/owner on P0 agent routes", async () => {
    for (const role of ["admin", "owner"] as const) {
      mockRole(role);
      const app = createApp(boardActor(`${role}-1`, [COMPANY_A]));

      expect((await request(app).post(`/api/agents/${AGENT_A}/keys`).send({ name: "k" })).status).toBe(201);
      expect((await request(app).post(`/api/agents/${AGENT_A}/pause`)).status).toBe(200);
      expect((await request(app).delete(`/api/agents/${AGENT_A}`)).status).toBe(200);
      expect((await request(app).get(`/api/agents/${AGENT_A}/keys`)).status).toBe(200);
    }
  });
});

describe("Stage 19 P1: approvals, costs, channel-config, scheduler RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.getById.mockResolvedValue({
      id: APPROVAL_A,
      companyId: COMPANY_A,
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
      requestedByPluginId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: APPROVAL_A,
        companyId: COMPANY_A,
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
        requestedByPluginId: null,
      },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockBudgetService.upsertPolicy.mockResolvedValue({ id: "pol-1" });
    mockScheduleStore.createSchedule.mockResolvedValue({
      id: SCHEDULE_A,
      companyId: COMPANY_A,
      agentId: AGENT_A,
      cronExpression: "0 * * * *",
      missionId: null,
    });
    mockScheduleStore.getScheduleById.mockResolvedValue({
      id: SCHEDULE_A,
      companyId: COMPANY_A,
      agentId: AGENT_A,
      cronExpression: "0 * * * *",
    });
    mockScheduleStore.deleteSchedule.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it.each(["viewer", "member"] as const)(
    "rejects %s with 403 on approval resolve, budget policy, channel config/test, and schedule create",
    async (role) => {
      mockRole(role);
      const app = createApp(boardActor(`${role}-1`, [COMPANY_A]));

      expect((await request(app).post(`/api/approvals/${APPROVAL_A}/approve`).send({})).status).toBe(403);
      expect(
        (
          await request(app)
            .post(`/api/companies/${COMPANY_A}/budgets/policies`)
            .send({ scopeType: "company", scopeId: COMPANY_A, amount: 5000, windowKind: "calendar_month_utc" })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .put(`/api/companies/${COMPANY_A}/channel/config`)
            .send({ botUsername: "test_bot", botTokenSecretId: "sec-1", enabled: true })
        ).status,
      ).toBe(403);
      expect((await request(app).post(`/api/companies/${COMPANY_A}/channel/test`)).status).toBe(403);
      expect(
        (
          await request(app)
            .post(`/api/companies/${COMPANY_A}/schedules`)
            .send({ agentId: AGENT_A, cronExpression: "0 * * * *" })
        ).status,
      ).toBe(403);
    },
  );

  it.each(["admin", "owner"] as const)(
    "allows %s on approval resolve, budget policy, channel config/test, and schedule create",
    async (role) => {
      mockRole(role);
      const app = createApp(boardActor(`${role}-1`, [COMPANY_A]));

      expect((await request(app).post(`/api/approvals/${APPROVAL_A}/approve`).send({})).status).toBe(200);
      expect(
        (
          await request(app)
            .post(`/api/companies/${COMPANY_A}/budgets/policies`)
            .send({ scopeType: "company", scopeId: COMPANY_A, amount: 5000, windowKind: "calendar_month_utc" })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app)
            .put(`/api/companies/${COMPANY_A}/channel/config`)
            .send({ botUsername: "test_bot", botTokenSecretId: "sec-1", enabled: true })
        ).status,
      ).toBe(200);
      expect((await request(app).post(`/api/companies/${COMPANY_A}/channel/test`)).status).toBe(200);
      expect(
        (
          await request(app)
            .post(`/api/companies/${COMPANY_A}/schedules`)
            .send({ agentId: AGENT_A, cronExpression: "0 * * * *" })
        ).status,
      ).toBe(201);
    },
  );

  it("preserves same-company agent access for schedule creation", async () => {
    const agentApp = createApp({ type: "agent", companyId: COMPANY_A, agentId: AGENT_A, runId: null });
    const res = await request(agentApp)
      .post(`/api/companies/${COMPANY_A}/schedules`)
      .send({ agentId: AGENT_A, cronExpression: "0 * * * *" });
    expect(res.status).toBe(201);
  });
});
