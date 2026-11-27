import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { knowledgeBasesRoutes } from "../routes/knowledge-bases.js";
import { knowledgePatternsRoutes } from "../routes/knowledge-patterns.js";
import { qualityRsiRoutes } from "../routes/quality-rsi.js";
import { qualityActionsRoutes } from "../routes/quality-actions.js";
import { strategyPlaybookRoutes } from "../routes/strategy-playbook.js";
import { harnessRsiRoutes } from "../routes/harness-rsi.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const KB_ID = "22222222-2222-4222-8222-222222222222";
const NODE_ID = "33333333-3333-4333-8333-333333333333";
const MISSION_ID = "44444444-4444-4444-8444-444444444444";
const PATTERN_ID = "55555555-5555-4555-8555-555555555555";
const ACTION_ID = "66666666-6666-4666-8666-666666666666";
const DECISION_ID = "77777777-7777-4777-8777-777777777777";
const POLICY_ID = "88888888-8888-4888-8888-888888888888";
const PLAYBOOK_ID = "99999999-9999-4999-8999-999999999999";
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const mockAccessService = vi.hoisted(() => ({
  getMembership: vi.fn(),
  canUser: vi.fn(),
}));

const mockKbNodes = vi.hoisted(() => ({
  searchKbNodes: vi.fn(),
  buildAgentKbTocContext: vi.fn(),
  readKbNode: vi.fn(),
  upsertKbNode: vi.fn(),
}));

const mockKbAutoCompile = vi.hoisted(() => ({
  compileCompletedMissionToKb: vi.fn(),
  runCompanyKbLint: vi.fn(),
}));

const mockKbTreeAdmin = vi.hoisted(() => ({
  listCompanyKbTree: vi.fn(),
  setKbNodeCertified: vi.fn(),
}));

const mockKnowledgePatternsSvc = vi.hoisted(() => ({
  search: vi.fn(),
  findSimilar: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  curateAudience: vi.fn(),
}));

const mockRetirePattern = vi.hoisted(() => vi.fn());

const mockQualityRsi = vi.hoisted(() => ({
  getQualityRsiOverview: vi.fn(),
  syncQualityRsi: vi.fn(),
  promoteQualityPatternToCanon: vi.fn(),
}));

const mockQualityDecisions = vi.hoisted(() => ({
  createQualityDecisionCard: vi.fn(),
  resolveQualityDecision: vi.fn(),
}));

const mockDeliverQualityIntent = vi.hoisted(() => vi.fn());

const mockStrategyPlaybookStore = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  transition: vi.fn(),
}));

const mockHarnessDiagnosis = vi.hoisted(() => ({
  loadCompanyHarnessDiagnosis: vi.fn(),
}));

const mockHarnessLedger = vi.hoisted(() => ({
  listCompanyLedger: vi.fn(),
  recordProposalDecision: vi.fn(),
  evaluateLedgerEntry: vi.fn(),
  toEditHistoryRecords: vi.fn(),
}));

const mockExecutionWorkspaceSvc = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationSvc = vi.hoisted(() => ({
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/knowledge/kb-nodes.js", () => ({
  searchKbNodes: mockKbNodes.searchKbNodes,
  buildAgentKbTocContext: mockKbNodes.buildAgentKbTocContext,
  readKbNode: mockKbNodes.readKbNode,
  upsertKbNode: mockKbNodes.upsertKbNode,
}));

vi.mock("../services/knowledge/kb-auto-compile.js", () => ({
  compileCompletedMissionToKb: mockKbAutoCompile.compileCompletedMissionToKb,
  runCompanyKbLint: mockKbAutoCompile.runCompanyKbLint,
}));

vi.mock("../services/knowledge/kb-tree-admin.js", () => ({
  listCompanyKbTree: mockKbTreeAdmin.listCompanyKbTree,
  setKbNodeCertified: mockKbTreeAdmin.setKbNodeCertified,
}));

vi.mock("../services/knowledge-patterns.js", () => ({
  knowledgePatternsService: () => mockKnowledgePatternsSvc,
}));

vi.mock("../services/knowledge-pattern-lifecycle.js", () => ({
  retire: mockRetirePattern,
}));

vi.mock("../services/quality-rsi.js", () => ({
  getQualityRsiOverview: mockQualityRsi.getQualityRsiOverview,
  syncQualityRsi: mockQualityRsi.syncQualityRsi,
  promoteQualityPatternToCanon: mockQualityRsi.promoteQualityPatternToCanon,
}));

vi.mock("../services/quality/decisions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/quality/decisions.js")>();
  return {
    ...actual,
    createQualityDecisionCard: mockQualityDecisions.createQualityDecisionCard,
    resolveQualityDecision: mockQualityDecisions.resolveQualityDecision,
  };
});

vi.mock("../services/quality/native-delivery.js", () => ({
  deliverQualityIntent: mockDeliverQualityIntent,
}));

vi.mock("../services/strategy-playbook.js", () => ({
  strategyPlaybookStore: () => mockStrategyPlaybookStore,
}));

vi.mock("../services/harness-rsi/telemetry-diagnose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/harness-rsi/telemetry-diagnose.js")>();
  return {
    ...actual,
    loadCompanyHarnessDiagnosis: mockHarnessDiagnosis.loadCompanyHarnessDiagnosis,
  };
});

vi.mock("../services/harness-rsi/ledger-store.js", () => ({
  listCompanyLedger: mockHarnessLedger.listCompanyLedger,
  recordProposalDecision: mockHarnessLedger.recordProposalDecision,
  evaluateLedgerEntry: mockHarnessLedger.evaluateLedgerEntry,
  toEditHistoryRecords: mockHarnessLedger.toEditHistoryRecords,
}));

vi.mock("../services/index.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceSvc,
  workspaceOperationService: () => mockWorkspaceOperationSvc,
  logActivity: mockLogActivity,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type Actor = Record<string, unknown>;

function boardUser(userId: string, opts: { source?: string; isInstanceAdmin?: boolean } = {}): Actor {
  return {
    type: "board",
    userId,
    companyIds: [COMPANY_ID],
    source: opts.source ?? "session",
    isInstanceAdmin: opts.isInstanceAdmin ?? false,
  };
}

function agentActor(): Actor {
  return {
    type: "agent",
    agentId: AGENT_ID,
    companyId: COMPANY_ID,
    runId: null,
  };
}

function setMembershipRole(role: "owner" | "admin" | "member" | "viewer" | null) {
  mockAccessService.getMembership.mockResolvedValue(
    role ? { status: "active", membershipRole: role } : null,
  );
  mockAccessService.canUser.mockResolvedValue(false);
}

function makeFakeDb() {
  const chain: any = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve([{ result: { outcome: "hold" } }])),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
  };
  return chain;
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const fakeDb = makeFakeDb();
  app.use("/api", knowledgeBasesRoutes(fakeDb));
  app.use("/api", knowledgePatternsRoutes(fakeDb));
  app.use("/api", qualityRsiRoutes(fakeDb));
  app.use("/api", qualityActionsRoutes(fakeDb));
  app.use("/api", strategyPlaybookRoutes(fakeDb));
  app.use("/api", harnessRsiRoutes(fakeDb));
  app.use("/api", executionWorkspaceRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

const samplePattern = {
  id: PATTERN_ID,
  companyId: COMPANY_ID,
  kind: "constraint",
  title: "Test Pattern",
  summary: "Summary",
  status: "active",
  audience: "ops",
};

const samplePlaybookEntry = {
  id: PLAYBOOK_ID,
  companyId: COMPANY_ID,
  channel: "knowledge",
  triggerType: "topic_surge",
  conditionJson: { window: "1h" },
  actionType: "boost_schedule",
  actionJson: { slots: 1 },
  status: "proposed",
};

const sampleWorkspace = {
  id: WORKSPACE_ID,
  companyId: COMPANY_ID,
  projectId: null,
  projectWorkspaceId: null,
  sourceIssueId: null,
  status: "active",
  cwd: "/tmp/ws",
};

describe("Stage 21 Wave 5 final secondary routes RBAC enforcement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogActivity.mockResolvedValue(undefined);

    mockKbNodes.searchKbNodes.mockResolvedValue([]);
    mockKbNodes.buildAgentKbTocContext.mockResolvedValue({ entries: [], estimatedTokens: 0 });
    mockKbNodes.readKbNode.mockResolvedValue({ id: NODE_ID, title: "Node" });
    mockKbNodes.upsertKbNode.mockResolvedValue({ created: true, node: { id: NODE_ID, slug: "s", title: "T" } });
    mockKbAutoCompile.runCompanyKbLint.mockResolvedValue({ checked: 0, stale: [], retired: 0 });
    mockKbAutoCompile.compileCompletedMissionToKb.mockResolvedValue({ created: true, nodeId: NODE_ID });
    mockKbTreeAdmin.listCompanyKbTree.mockResolvedValue({ bases: [] });
    mockKbTreeAdmin.setKbNodeCertified.mockResolvedValue({ id: NODE_ID, certified: true });

    mockKnowledgePatternsSvc.search.mockResolvedValue([samplePattern]);
    mockKnowledgePatternsSvc.findSimilar.mockResolvedValue([]);
    mockKnowledgePatternsSvc.create.mockResolvedValue(samplePattern);
    mockKnowledgePatternsSvc.approve.mockResolvedValue({ ...samplePattern, status: "active" });
    mockKnowledgePatternsSvc.curateAudience.mockResolvedValue({ ...samplePattern, audience: "agent" });
    mockRetirePattern.mockResolvedValue({ ...samplePattern, status: "retired" });

    mockQualityRsi.getQualityRsiOverview.mockResolvedValue({ totals: {} });
    mockQualityRsi.syncQualityRsi.mockResolvedValue({ synced: 1 });
    mockQualityRsi.promoteQualityPatternToCanon.mockResolvedValue({ alreadyCanon: false, signature: "quality-rsi:test" });

    mockQualityDecisions.createQualityDecisionCard.mockResolvedValue({
      operatorDecisionId: DECISION_ID,
      replayed: false,
    });
    mockQualityDecisions.resolveQualityDecision.mockResolvedValue({
      actionId: ACTION_ID,
      replayed: false,
    });
    mockDeliverQualityIntent.mockResolvedValue({ status: "skipped", receiptId: null });

    mockStrategyPlaybookStore.list.mockResolvedValue([samplePlaybookEntry]);
    mockStrategyPlaybookStore.create.mockResolvedValue(samplePlaybookEntry);
    mockStrategyPlaybookStore.getById.mockResolvedValue(samplePlaybookEntry);
    mockStrategyPlaybookStore.transition.mockResolvedValue({ ...samplePlaybookEntry, status: "active" });

    mockHarnessDiagnosis.loadCompanyHarnessDiagnosis.mockResolvedValue({
      summary: {
        totalRuns: 0,
        successRate: 1,
        avgDurationMs: 1000,
        failureModes: [],
      },
      buckets: [],
    });
    mockHarnessLedger.listCompanyLedger.mockResolvedValue([]);
    mockHarnessLedger.toEditHistoryRecords.mockReturnValue([]);
    mockHarnessLedger.recordProposalDecision.mockResolvedValue({ id: ENTRY_ID, decision: "approved" });
    mockHarnessLedger.evaluateLedgerEntry.mockResolvedValue({
      entry: { id: ENTRY_ID },
      selection: { action: "keep" },
    });

    mockExecutionWorkspaceSvc.list.mockResolvedValue([sampleWorkspace]);
    mockExecutionWorkspaceSvc.getById.mockResolvedValue(sampleWorkspace);
    mockExecutionWorkspaceSvc.update.mockResolvedValue({ ...sampleWorkspace, name: "Updated" });
  });

  describe("knowledge-bases routes", () => {
    it("allows viewer to read KB routes but blocks viewer on all mutations", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/knowledge-bases/search?q=test`)).status).toBe(200);
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/knowledge-bases/tree`)).status).toBe(200);
      expect((await request(viewerApp).patch(`/api/companies/${COMPANY_ID}/knowledge-bases/nodes/${NODE_ID}/certified`).send({ certified: true })).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-bases/lint`).send({})).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-bases/compile-mission/${MISSION_ID}`).send({})).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-bases/${KB_ID}/nodes`).send({ slug: "a", title: "A" })).status).toBe(403);
    });

    it("allows member, admin, and local_implicit on KB mutations", async () => {
      const scenarios: Array<{ role: "member" | "admin" | null; actor: Actor }> = [
        { role: "member", actor: boardUser("member-1") },
        { role: "admin", actor: boardUser("admin-1") },
        { role: null, actor: boardUser("local-board", { source: "local_implicit" }) },
      ];
      for (const { role, actor } of scenarios) {
        setMembershipRole(role);
        const app = createApp(actor);
        expect((await request(app).patch(`/api/companies/${COMPANY_ID}/knowledge-bases/nodes/${NODE_ID}/certified`).send({ certified: true })).status).toBe(200);
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/knowledge-bases/lint`).send({})).status).toBe(200);
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/knowledge-bases/compile-mission/${MISSION_ID}`).send({})).status).toBe(201);
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/knowledge-bases/${KB_ID}/nodes`).send({ slug: "a", title: "A" })).status).toBe(201);
      }
    });
  });

  describe("knowledge-patterns routes", () => {
    const createBody = { kind: "constraint", title: "Rule", summary: "Summary" };

    it("blocks viewer on all knowledge-pattern mutations while allowing GET", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/knowledge-patterns`)).status).toBe(200);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns`).send(createBody)).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/approve`).send({})).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/retire`).send({ reason: "obsolete" })).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/audience`).send({ audience: "agent" })).status).toBe(403);
    });

    it("allows member on create/audience, blocks member on approve/retire, allows admin/local_implicit/isInstanceAdmin and agent create", async () => {
      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns`).send(createBody)).status).toBe(201);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/audience`).send({ audience: "agent" })).status).toBe(200);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/approve`).send({})).status).toBe(403);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/retire`).send({ reason: "obsolete" })).status).toBe(403);

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/approve`).send({})).status).toBe(200);
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/retire`).send({ reason: "obsolete" })).status).toBe(200);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/approve`).send({})).status).toBe(200);
      const instAdminApp = createApp(boardUser("inst-admin", { isInstanceAdmin: true }));
      expect((await request(instAdminApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns/${PATTERN_ID}/retire`).send({ reason: "obsolete" })).status).toBe(200);

      const agentApp = createApp(agentActor());
      expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/knowledge-patterns`).send(createBody)).status).toBe(201);
    });
  });

  describe("quality-rsi routes", () => {
    it("blocks viewer on sync and promote-canon, blocks member on promote-canon, allows admin/local_implicit", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/quality/rsi-overview`)).status).toBe(200);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/quality/rsi-sync`).send({})).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/quality/rsi-promote-canon`).send({ signature: "quality-rsi:test" })).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/quality/rsi-sync`).send({})).status).toBe(200);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/quality/rsi-promote-canon`).send({ signature: "quality-rsi:test" })).status).toBe(403);

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/quality/rsi-promote-canon`).send({ signature: "quality-rsi:test" })).status).toBe(201);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).post(`/api/companies/${COMPANY_ID}/quality/rsi-promote-canon`).send({ signature: "quality-rsi:test" })).status).toBe(201);
    });
  });

  describe("quality-actions routes", () => {
    const resolveBody = {
      schemaVersion: 1,
      operatorDecisionId: DECISION_ID,
      selectedOptionId: "proceed",
      effectHash: "a".repeat(64),
      targetHash: "b".repeat(64),
      snapshotHash: "c".repeat(64),
      evidenceRevision: "rev:1:abc",
      policyVersionId: POLICY_ID,
      scopeVersion: 1,
    };

    it("blocks viewer on decision-card and resolve, allows member, admin, and local_implicit", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/quality-actions/${ACTION_ID}/decision-card`).send({})).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/quality-actions/${ACTION_ID}/resolve`).send(resolveBody)).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/quality-actions/${ACTION_ID}/decision-card`).send({})).status).toBe(201);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/quality-actions/${ACTION_ID}/resolve`).send(resolveBody)).status).toBe(200);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).post(`/api/companies/${COMPANY_ID}/quality-actions/${ACTION_ID}/decision-card`).send({})).status).toBe(201);
    });
  });

  describe("strategy-playbook routes", () => {
    const proposalBody = {
      channel: "knowledge",
      triggerType: "topic_surge",
      conditionJson: { window: "1h" },
      actionType: "boost_schedule",
      actionJson: { slots: 1 },
      evidenceRefs: ["issue://1"],
    };

    it("blocks viewer on POST/PATCH, allows member & agent on POST only, allows admin/local_implicit/isInstanceAdmin on PATCH", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/strategy-playbook`)).status).toBe(200);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/strategy-playbook`).send(proposalBody)).status).toBe(403);
      expect((await request(viewerApp).patch(`/api/strategy-playbook/${PLAYBOOK_ID}`).send({ status: "active" })).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/strategy-playbook`).send(proposalBody)).status).toBe(201);
      expect((await request(memberApp).patch(`/api/strategy-playbook/${PLAYBOOK_ID}`).send({ status: "active" })).status).toBe(403);

      const agentApp = createApp(agentActor());
      expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/strategy-playbook`).send(proposalBody)).status).toBe(201);
      expect((await request(agentApp).patch(`/api/strategy-playbook/${PLAYBOOK_ID}`).send({ status: "active" })).status).toBe(403);

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).patch(`/api/strategy-playbook/${PLAYBOOK_ID}`).send({ status: "active" })).status).toBe(200);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).patch(`/api/strategy-playbook/${PLAYBOOK_ID}`).send({ status: "active" })).status).toBe(200);
      const instAdminApp = createApp(boardUser("inst-admin", { isInstanceAdmin: true }));
      expect((await request(instAdminApp).patch(`/api/strategy-playbook/${PLAYBOOK_ID}`).send({ status: "active" })).status).toBe(200);
    });
  });

  describe("harness-rsi routes", () => {
    it("blocks viewer on screen/decision/evaluate, blocks member on decision, allows member/agent on screen & evaluate and admin/local_implicit on decision", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/harness-rsi/diagnose`)).status).toBe(200);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/screen`).send({ diffText: "+ok" })).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/proposals/decision`).send({ decision: "approved" })).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/ledger/${ENTRY_ID}/evaluate`).send({})).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/screen`).send({ diffText: "+ok" })).status).toBe(200);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/ledger/${ENTRY_ID}/evaluate`).send({})).status).toBe(200);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/proposals/decision`).send({ decision: "approved" })).status).toBe(403);

      const agentApp = createApp(agentActor());
      expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/screen`).send({ diffText: "+ok" })).status).toBe(200);
      expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/ledger/${ENTRY_ID}/evaluate`).send({})).status).toBe(200);
      expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/proposals/decision`).send({ decision: "approved" })).status).toBe(403);

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/proposals/decision`).send({ decision: "approved" })).status).toBe(201);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).post(`/api/companies/${COMPANY_ID}/harness-rsi/proposals/decision`).send({ decision: "approved" })).status).toBe(201);
    });
  });

  describe("execution-workspaces routes", () => {
    it("allows viewer to GET execution workspaces but blocks PATCH; allows member, agent, and local_implicit", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/execution-workspaces`)).status).toBe(200);
      expect((await request(viewerApp).get(`/api/execution-workspaces/${WORKSPACE_ID}`)).status).toBe(200);
      expect((await request(viewerApp).patch(`/api/execution-workspaces/${WORKSPACE_ID}`).send({ cleanupReason: "manual" })).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).patch(`/api/execution-workspaces/${WORKSPACE_ID}`).send({ cleanupReason: "manual" })).status).toBe(200);

      const agentApp = createApp(agentActor());
      expect((await request(agentApp).patch(`/api/execution-workspaces/${WORKSPACE_ID}`).send({ cleanupReason: "manual" })).status).toBe(200);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).patch(`/api/execution-workspaces/${WORKSPACE_ID}`).send({ cleanupReason: "manual" })).status).toBe(200);
    });
  });
});
