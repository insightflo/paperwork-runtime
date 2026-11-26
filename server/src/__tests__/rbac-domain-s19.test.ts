import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";
import { missionRoutes } from "../routes/missions.js";
import { projectRoutes } from "../routes/projects.js";
import { issueRoutes } from "../routes/issues.js";
import { workflowRoutes } from "../routes/workflows.js";
import { worktreeRoutes } from "../routes/worktree.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID_2 = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";

const mockAccessService = vi.hoisted(() => ({
  getMembership: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  markRead: vi.fn(),
  archiveInbox: vi.fn(),
  unarchiveInbox: vi.fn(),
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockMissionService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  readCompanyId: vi.fn(),
}));

const mockRuleStore = vi.hoisted(() => ({
  listByCompany: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

const mockProposalStore = vi.hoisted(() => ({
  listByCompany: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  review: vi.fn(),
}));

const mockWorkflowService = vi.hoisted(() => ({
  listDefinitions: vi.fn(),
  getDefinition: vi.fn(),
  createDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  trigger: vi.fn(),
  resumeRun: vi.fn(),
  cancelRun: vi.fn(),
  syncRunStatusForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockApplyIssueCreatedSideEffects = vi.hoisted(() => vi.fn());
const mockGrantWorkflowToolToAgent = vi.hoisted(() => vi.fn());

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyService: () => mockCompanyService,
  projectService: () => mockProjectService,
  issueService: () => mockIssueService,
  goalService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn(), cancelRun: vi.fn(), getRun: vi.fn() }),
  issueApprovalService: () => ({}),
  executionWorkspaceService: () => ({}),
  workProductService: () => ({}),
  documentService: () => ({}),
  workflowService: mockWorkflowService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/issue-create-side-effects.js", () => ({
  applyIssueCreatedSideEffects: mockApplyIssueCreatedSideEffects,
}));

vi.mock("../services/missions.js", () => ({
  missionService: () => mockMissionService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: vi.fn(), cancelRun: vi.fn(), getRun: vi.fn() }),
}));

vi.mock("../services/worktree/rule-store.js", () => ({
  ruleStore: () => mockRuleStore,
}));

vi.mock("../services/worktree/proposal-store.js", () => ({
  proposalStore: () => mockProposalStore,
}));

vi.mock("../services/workflow/engine.js", () => ({
  workflowService: mockWorkflowService,
}));

vi.mock("../services/workflow/tool-catalog.js", () => ({
  grantWorkflowToolToAgent: mockGrantWorkflowToolToAgent,
  listWorkflowToolCatalog: vi.fn(),
  revokeWorkflowToolFromAgent: vi.fn(),
  syncToolRegistryToolsToCore: vi.fn(),
}));

vi.mock("../services/workflow/workflow-core-client-s8c.js", () => ({
  findWorkflowDefinitionStepWarningsWithNodeFallback: vi.fn().mockResolvedValue([]),
  summarizeDefinitionStepWarningsWithNodeFallback: vi.fn().mockResolvedValue([]),
}));

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const fakeDb = {} as any;
  const fakeStorage = {} as any;
  app.use("/api/companies", companyRoutes(fakeDb));
  app.use("/api", missionRoutes(fakeDb));
  app.use("/api", projectRoutes(fakeDb));
  app.use("/api", issueRoutes(fakeDb, fakeStorage));
  app.use("/api", workflowRoutes(fakeDb));
  app.use("/api", worktreeRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

const actors = {
  localImplicit: {
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: true,
    companyIds: [COMPANY_ID, COMPANY_ID_2],
  },
  admin: {
    type: "board",
    userId: "user-admin",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [COMPANY_ID],
  },
  member: {
    type: "board",
    userId: "user-member",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [COMPANY_ID],
  },
  viewer: {
    type: "board",
    userId: "user-viewer",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [COMPANY_ID],
  },
  agent: {
    type: "agent",
    agentId: AGENT_ID,
    companyId: COMPANY_ID,
    source: "agent_key",
    runId: "run-1",
  },
};

function setupMembershipRoles() {
  const roles: Record<string, string> = {
    "user-admin": "admin",
    "user-member": "member",
    "user-viewer": "viewer",
  };
  mockAccessService.getMembership.mockImplementation(
    async (companyId: string, _principalType: string, principalId: string) => {
      if (companyId !== COMPANY_ID) return null;
      const role = roles[principalId];
      if (!role) return null;
      return { companyId, principalType: "user", principalId, status: "active", membershipRole: role };
    },
  );
  mockAccessService.listUserCompanyAccess.mockImplementation(async (userId: string) => {
    const role = roles[userId];
    if (!role) return [];
    return [{ companyId: COMPANY_ID, principalType: "user", principalId: userId, status: "active", membershipRole: role }];
  });
  mockAccessService.canUser.mockResolvedValue(false);
  mockAccessService.hasPermission.mockResolvedValue(false);
}

describe("Stage 19 Wave 4 — Domain RBAC & myRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMembershipRoles();

    mockCompanyService.list.mockResolvedValue([
      { id: COMPANY_ID, name: "Alpha Co" },
      { id: COMPANY_ID_2, name: "Beta Co" },
    ]);
    mockCompanyService.getById.mockResolvedValue({ id: COMPANY_ID, name: "Alpha Co" });
    mockCompanyService.update.mockResolvedValue({ id: COMPANY_ID, name: "Alpha Co", brandColor: "#abcdef" });
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: COMPANY_ID, role: "ceo" });
    mockMissionService.create.mockResolvedValue({
      id: "mission-1",
      companyId: COMPANY_ID,
      ownerAgentId: AGENT_ID,
      title: "Launch Q4",
      status: "planning",
    });
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: COMPANY_ID,
      name: "Core Platform",
    });
    mockIssueService.create.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      title: "Fix RBAC",
      issueNumber: 1,
      projectId: null,
      projectWorkspaceId: null,
      parentId: null,
      executionWorkspaceId: null,
    });
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      title: "Fix RBAC",
      status: "todo",
    });
    mockIssueService.markRead.mockResolvedValue({
      issueId: ISSUE_ID,
      lastReadAt: new Date("2026-11-26T00:00:00.000Z"),
    });
    mockIssueService.archiveInbox.mockResolvedValue({
      issueId: ISSUE_ID,
      archivedAt: new Date("2026-11-26T00:00:00.000Z"),
    });
    mockWorkflowService.getDefinition.mockResolvedValue({
      id: WORKFLOW_ID,
      companyId: COMPANY_ID,
      name: "Daily Ops",
      steps: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockWorkflowService.createDefinition.mockResolvedValue({
      id: WORKFLOW_ID,
      companyId: COMPANY_ID,
      name: "Daily Ops",
      steps: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockGrantWorkflowToolToAgent.mockResolvedValue({ granted: true });
    mockRuleStore.create.mockResolvedValue({
      id: "rule-1",
      companyId: COMPANY_ID,
      name: "No direct push",
    });
    mockProposalStore.create.mockResolvedValue({
      id: "proposal-1",
      companyId: COMPANY_ID,
      proposedByAgentId: AGENT_ID,
    });
  });

  describe("GET /api/companies & GET /api/companies/:companyId myRole", () => {
    it("returns myRole='owner' for local_implicit and active membershipRole for session users", async () => {
      const localRes = await request(makeApp(actors.localImplicit)).get("/api/companies");
      expect(localRes.status).toBe(200);
      expect(localRes.body).toEqual([
        expect.objectContaining({ id: COMPANY_ID, myRole: "owner" }),
        expect.objectContaining({ id: COMPANY_ID_2, myRole: "owner" }),
      ]);

      const viewerRes = await request(makeApp(actors.viewer)).get("/api/companies");
      expect(viewerRes.status).toBe(200);
      expect(viewerRes.body).toEqual([
        expect.objectContaining({ id: COMPANY_ID, myRole: "viewer" }),
      ]);

      const memberDetail = await request(makeApp(actors.member)).get(`/api/companies/${COMPANY_ID}`);
      expect(memberDetail.status).toBe(200);
      expect(memberDetail.body.myRole).toBe("member");

      const agentDetail = await request(makeApp(actors.agent)).get(`/api/companies/${COMPANY_ID}`);
      expect(agentDetail.status).toBe(200);
      expect(agentDetail.body.myRole).toBe("member");
    });

    it("enforces admin role on PATCH /api/companies/:companyId/branding while preserving CEO agent", async () => {
      const memberRes = await request(makeApp(actors.member))
        .patch(`/api/companies/${COMPANY_ID}/branding`)
        .send({ brandColor: "#abcdef" });
      expect(memberRes.status).toBe(403);

      const adminRes = await request(makeApp(actors.admin))
        .patch(`/api/companies/${COMPANY_ID}/branding`)
        .send({ brandColor: "#abcdef" });
      expect(adminRes.status).toBe(200);

      const ceoRes = await request(makeApp(actors.agent))
        .patch(`/api/companies/${COMPANY_ID}/branding`)
        .send({ brandColor: "#abcdef" });
      expect(ceoRes.status).toBe(200);
    });
  });

  describe("Write RBAC (viewer blocked with 403, member/admin/local_implicit/agent allowed)", () => {
    it("enforces write access on mission creation", async () => {
      const body = { ownerAgentId: AGENT_ID, title: "Launch Q4" };

      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/missions`).send(body)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/missions`).send(body)).status).toBe(201);
      expect((await request(makeApp(actors.admin)).post(`/api/companies/${COMPANY_ID}/missions`).send(body)).status).toBe(201);
      expect((await request(makeApp(actors.localImplicit)).post(`/api/companies/${COMPANY_ID}/missions`).send(body)).status).toBe(201);
      expect((await request(makeApp(actors.agent)).post(`/api/companies/${COMPANY_ID}/missions`).send(body)).status).toBe(201);
    });

    it("enforces write access on project creation", async () => {
      const body = { name: "Core Platform" };

      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/projects`).send(body)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/projects`).send(body)).status).toBe(201);
      expect((await request(makeApp(actors.localImplicit)).post(`/api/companies/${COMPANY_ID}/projects`).send(body)).status).toBe(201);
    });

    it("enforces write access on issue creation while keeping read & inbox-archive open to viewer", async () => {
      const body = { title: "Fix RBAC" };

      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/issues`).send(body)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/issues`).send(body)).status).toBe(201);
      expect((await request(makeApp(actors.localImplicit)).post(`/api/companies/${COMPANY_ID}/issues`).send(body)).status).toBe(201);
      expect((await request(makeApp(actors.agent)).post(`/api/companies/${COMPANY_ID}/issues`).send(body)).status).toBe(201);

      expect((await request(makeApp(actors.viewer)).post(`/api/issues/${ISSUE_ID}/read`).send({})).status).toBe(200);
      expect((await request(makeApp(actors.viewer)).post(`/api/issues/${ISSUE_ID}/inbox-archive`).send({})).status).toBe(200);
    });

    it("enforces write access on workflow creation", async () => {
      const body = { name: "Daily Ops", steps: [] };

      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/workflows`).send(body)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/workflows`).send(body)).status).toBe(201);
    });
  });

  describe("Admin RBAC on workflow webhooks/grants & worktree rules", () => {
    it("blocks member and viewer on workflow webhook and tool grant mutations", async () => {
      expect((await request(makeApp(actors.viewer)).post(`/api/workflows/${WORKFLOW_ID}/webhook`).send({})).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/workflows/${WORKFLOW_ID}/webhook`).send({})).status).toBe(403);
      expect((await request(makeApp(actors.member)).delete(`/api/workflows/${WORKFLOW_ID}/webhook`)).status).toBe(403);

      const grantBody = { agentId: AGENT_ID, toolName: "bash" };
      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/workflows/tools/grants`).send(grantBody)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/workflows/tools/grants`).send(grantBody)).status).toBe(403);
      expect((await request(makeApp(actors.admin)).post(`/api/companies/${COMPANY_ID}/workflows/tools/grants`).send(grantBody)).status).toBe(201);
    });

    it("blocks member and viewer on worktree rule mutations, while allowing member on worktree proposals", async () => {
      const ruleBody = {
        name: "No direct push",
        severity: "MUST",
        action: "block",
        predicate: { kind: "always" },
      };

      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/worktree/rules`).send(ruleBody)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/worktree/rules`).send(ruleBody)).status).toBe(403);
      expect((await request(makeApp(actors.admin)).post(`/api/companies/${COMPANY_ID}/worktree/rules`).send(ruleBody)).status).toBe(201);
      expect((await request(makeApp(actors.localImplicit)).post(`/api/companies/${COMPANY_ID}/worktree/rules`).send(ruleBody)).status).toBe(201);

      const proposalBody = {
        proposedByAgentId: AGENT_ID,
        proposedChange: { action: "warn" },
        rationale: "Reduce noise",
      };
      expect((await request(makeApp(actors.viewer)).post(`/api/companies/${COMPANY_ID}/worktree/proposals`).send(proposalBody)).status).toBe(403);
      expect((await request(makeApp(actors.member)).post(`/api/companies/${COMPANY_ID}/worktree/proposals`).send(proposalBody)).status).toBe(201);
    });
  });
});
