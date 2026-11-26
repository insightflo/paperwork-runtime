import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";
import { companyDataStorageRoutes } from "../routes/company-data-storage.js";
import { companyWorkProductStorageRoutes } from "../routes/company-work-product-storage.js";
import { assetRoutes } from "../routes/assets.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";
import { qualityPolicyRoutes } from "../routes/quality-policies.js";
import type { StorageService } from "../storage/types.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";

const mockAccessService = vi.hoisted(() => ({
  getMembership: vi.fn(),
  canUser: vi.fn(),
}));

const mockToolService = vi.hoisted(() => ({
  listDefinitions: vi.fn(),
  getDefinitionById: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
}));

const mockAssetService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockOperatorDecisionRead = vi.hoisted(() => ({
  list: vi.fn(),
  getRequired: vi.fn(),
}));

const mockOperatorDecisionWrite = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: vi.fn(),
  cancel: vi.fn(),
  reportOutcome: vi.fn(),
  retryContinuation: vi.fn(),
}));

const mockCardSummaries = vi.hoisted(() => ({
  getRows: vi.fn(),
  ensureSummary: vi.fn(),
  retranslate: vi.fn(),
}));

const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockCreateQualityPolicy = vi.hoisted(() => vi.fn());
const mockActivateQualityPolicy = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/tools/registry.js", () => ({
  toolService: mockToolService,
}));

vi.mock("../services/index.js", () => ({
  assetService: () => mockAssetService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/operator-decisions-read.js", () => ({
  operatorDecisionReadService: () => mockOperatorDecisionRead,
}));

vi.mock("../services/operator-decisions-write.js", () => ({
  operatorDecisionWriteService: () => mockOperatorDecisionWrite,
}));

vi.mock("../services/card-summaries.js", () => ({
  cardSummaryService: () => mockCardSummaries,
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => mockHeartbeat,
}));

vi.mock("../services/quality/policy.js", () => ({
  createQualityPolicy: mockCreateQualityPolicy,
  activateQualityPolicy: mockActivateQualityPolicy,
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

function makeStorageService(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(async (input) => ({
      provider: "local_disk" as const,
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-test",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  const fakeDataStorage = {
    get: vi.fn().mockResolvedValue({ provider: "local_disk" }),
    save: vi.fn().mockImplementation(async (_cid: string, cfg: unknown) => cfg),
    testConnection: vi.fn().mockResolvedValue({ provider: "local_disk", ok: true }),
    resolveActive: vi.fn().mockResolvedValue({ provider: "local_disk" }),
  };
  const fakeDataObjects = {
    listObjects: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    readObject: vi.fn(),
    writeObject: vi.fn().mockResolvedValue({
      key: "data/sample.json",
      size: 11,
      contentType: "application/json",
    }),
  };
  const fakeWpStorage = {
    get: vi.fn().mockResolvedValue({ provider: "local_disk" }),
    save: vi.fn().mockImplementation(async (_cid: string, cfg: unknown) => cfg),
    testConnection: vi.fn().mockResolvedValue({ provider: "local_disk", ok: true }),
  };
  const mockExecuteTest = vi.fn().mockResolvedValue({
    ok: true,
    status: "success",
    httpStatus: 200,
    result: { ok: true },
  });

  app.use("/api", toolDefinitionRoutes({} as any, { executeTest: mockExecuteTest as any }));
  app.use("/api", companyDataStorageRoutes({} as any, {
    storageService: fakeDataStorage as any,
    objectService: fakeDataObjects as any,
  }));
  app.use("/api", companyWorkProductStorageRoutes({} as any, {
    service: fakeWpStorage as any,
  }));
  app.use("/api", assetRoutes({} as any, makeStorageService()));
  app.use("/api", operatorDecisionRoutes({} as any));
  app.use("/api", qualityPolicyRoutes({} as any, "native"));
  app.use(errorHandler);
  return app;
}

const sampleTool = {
  id: TOOL_ID,
  companyId: COMPANY_ID,
  name: "sample-tool",
  description: "Sample",
  inputSchema: { type: "object" },
  adapterType: "http",
  adapterConfig: { url: "https://example.test/tool" },
  enabled: true,
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

const sampleDecision = {
  id: DECISION_ID,
  companyId: COMPANY_ID,
  issueId: null,
  status: "pending",
  title: "Confirm deployment",
  description: "Deploy v2?",
  interactionType: "confirm",
  requestedBy: { type: "agent", id: AGENT_ID },
};

const sampleAsset = {
  id: "asset-1",
  companyId: COMPANY_ID,
  provider: "local_disk",
  objectKey: "assets/general/pic.png",
  contentType: "image/png",
  byteSize: 3,
  sha256: "sha256-test",
  originalFilename: "pic.png",
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

describe("Stage 20 secondary route RBAC hardening", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockToolService.listDefinitions.mockResolvedValue([sampleTool]);
    mockToolService.getDefinitionById.mockResolvedValue(sampleTool);
    mockToolService.createDefinition.mockResolvedValue(sampleTool);
    mockToolService.updateDefinition.mockResolvedValue(sampleTool);
    mockToolService.deleteDefinition.mockResolvedValue(true);
    mockAssetService.create.mockResolvedValue(sampleAsset);
    mockOperatorDecisionRead.getRequired.mockResolvedValue(sampleDecision);
    mockOperatorDecisionWrite.create.mockResolvedValue({ decision: sampleDecision, replayed: false });
    mockOperatorDecisionWrite.resolve.mockResolvedValue({ decision: { ...sampleDecision, status: "resolved", requestedBy: null } });
    mockOperatorDecisionWrite.cancel.mockResolvedValue({ ...sampleDecision, status: "cancelled" });
    mockOperatorDecisionWrite.retryContinuation.mockResolvedValue({ ok: true });
    mockCardSummaries.retranslate.mockResolvedValue({
      status: "done",
      adapterType: "claude",
      model: "sonnet",
      summaryJson: { headline: "ok" },
      error: null,
      updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    mockCreateQualityPolicy.mockResolvedValue({ policyVersionId: POLICY_ID });
    mockActivateQualityPolicy.mockResolvedValue({ policyVersionId: POLICY_ID });
  });

  describe("tool-definitions routes", () => {
    it("allows viewer to GET tools but blocks viewer and member from POST/PATCH/DELETE/test", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/tools`)).status).toBe(200);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/tools`).send({
        name: "new-tool", adapterType: "http", adapterConfig: { url: "https://example.test" },
      })).status).toBe(403);
      expect((await request(viewerApp).patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`).send({
        enabled: false,
      })).status).toBe(403);
      expect((await request(viewerApp).delete(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)).status).toBe(403);
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}/test`).send({
        input: {},
      })).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/tools`).send({
        name: "new-tool", adapterType: "http", adapterConfig: { url: "https://example.test" },
      })).status).toBe(403);
      expect((await request(memberApp).patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`).send({
        enabled: false,
      })).status).toBe(403);
      expect((await request(memberApp).delete(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)).status).toBe(403);
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}/test`).send({
        input: {},
      })).status).toBe(403);
    });

    it("allows admin on POST/PATCH/DELETE/test", async () => {
      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/tools`).send({
        name: "new-tool", adapterType: "http", adapterConfig: { url: "https://example.test" },
      })).status).toBe(201);
      expect((await request(adminApp).patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`).send({
        enabled: false,
      })).status).toBe(200);
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}/test`).send({
        input: {},
      })).status).toBe(200);
      expect((await request(adminApp).delete(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)).status).toBe(200);
    });
  });

  describe("company-data-storage routes", () => {
    it("blocks viewer and member from PUT /data-storage and POST /data-storage/test, allows admin", async () => {
      for (const role of ["viewer", "member"] as const) {
        setMembershipRole(role);
        const app = createApp(boardUser(`${role}-1`));
        expect((await request(app).get(`/api/companies/${COMPANY_ID}/data-storage`)).status).toBe(200);
        expect((await request(app).put(`/api/companies/${COMPANY_ID}/data-storage`).send({ provider: "local_disk" })).status).toBe(403);
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/data-storage/test`).send({})).status).toBe(403);
      }

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).put(`/api/companies/${COMPANY_ID}/data-storage`).send({ provider: "local_disk" })).status).toBe(200);
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/data-storage/test`).send({})).status).toBe(200);
    });

    it("blocks viewer from PUT /data/objects but allows member and agent", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).get(`/api/companies/${COMPANY_ID}/data/objects`)).status).toBe(200);
      expect((await request(viewerApp)
        .put(`/api/companies/${COMPANY_ID}/data/objects?key=data/sample.json`)
        .set("Content-Type", "application/json")
        .send('{"ok":true}')).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp)
        .put(`/api/companies/${COMPANY_ID}/data/objects?key=data/sample.json`)
        .set("Content-Type", "application/json")
        .send('{"ok":true}')).status).toBe(201);

      const agentApp = createApp(agentActor());
      expect((await request(agentApp)
        .put(`/api/companies/${COMPANY_ID}/data/objects?key=data/sample.json`)
        .set("Content-Type", "application/json")
        .send('{"ok":true}')).status).toBe(201);
    });
  });

  describe("company-work-product-storage routes", () => {
    it("blocks viewer and member from PUT and POST /test, allows admin", async () => {
      for (const role of ["viewer", "member"] as const) {
        setMembershipRole(role);
        const app = createApp(boardUser(`${role}-1`));
        expect((await request(app).get(`/api/companies/${COMPANY_ID}/work-product-storage`)).status).toBe(200);
        expect((await request(app).put(`/api/companies/${COMPANY_ID}/work-product-storage`).send({ provider: "local_disk" })).status).toBe(403);
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/work-product-storage/test`).send({})).status).toBe(403);
      }

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).put(`/api/companies/${COMPANY_ID}/work-product-storage`).send({ provider: "local_disk" })).status).toBe(200);
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/work-product-storage/test`).send({})).status).toBe(200);
    });
  });

  describe("assets routes", () => {
    it("blocks viewer and member from POST /logo, allows admin", async () => {
      for (const role of ["viewer", "member"] as const) {
        setMembershipRole(role);
        const app = createApp(boardUser(`${role}-1`));
        const res = await request(app)
          .post(`/api/companies/${COMPANY_ID}/logo`)
          .attach("file", Buffer.from("png"), "logo.png");
        expect(res.status).toBe(403);
      }

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      const adminRes = await request(adminApp)
        .post(`/api/companies/${COMPANY_ID}/logo`)
        .attach("file", Buffer.from("png"), "logo.png");
      expect(adminRes.status).toBe(201);
    });

    it("blocks viewer from POST /assets/images, allows member and agent", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      const viewerRes = await request(viewerApp)
        .post(`/api/companies/${COMPANY_ID}/assets/images`)
        .attach("file", Buffer.from("png"), "pic.png");
      expect(viewerRes.status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      const memberRes = await request(memberApp)
        .post(`/api/companies/${COMPANY_ID}/assets/images`)
        .attach("file", Buffer.from("png"), "pic.png");
      expect(memberRes.status).toBe(201);

      const agentApp = createApp(agentActor());
      const agentRes = await request(agentApp)
        .post(`/api/companies/${COMPANY_ID}/assets/images`)
        .attach("file", Buffer.from("png"), "pic.png");
      expect(agentRes.status).toBe(201);
    });
  });

  describe("operator-decisions routes", () => {
    const createPayload = {
      schemaVersion: 1,
      requestKey: "rbac-s20-create",
      priority: "medium",
      interactionType: "action",
      title: "Hold work?",
      description: "",
      sourceType: "system",
      sourceId: "fixture",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      definition: {
        options: [],
        actions: [
          { id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false },
        ],
        selection: null,
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [],
        forbiddenScope: [],
        humanReview: {
          schemaVersion: "human-review-v1",
          decisionSubject: "Hold work?",
          evidence: [{ label: "Fixture", href: "/operator-decisions/fixture", location: "Fixture" }],
          interpretation: "Operator chooses whether to hold.",
          impact: { ifApproved: "Held.", ifRejected: "Continued.", ifWrong: "Wrong state." },
          unresolvedFacts: [],
          questions: ["Hold?"],
          recommendedNextStep: "Choose hold.",
          requiredReviewer: "Human Operator",
        },
      },
      issueId: null,
      continuationMode: "none",
    };

    const resolvePayload = {
      actionId: "hold",
      selectedOptionIds: [],
      comment: null,
    };

    it("blocks viewer from creating and retranslating, allows member and agent on create", async () => {
      setMembershipRole("viewer");
      const viewerApp = createApp(boardUser("viewer-1"));
      expect((await request(viewerApp).post(`/api/companies/${COMPANY_ID}/operator-decisions`).send(createPayload)).status).toBe(403);
      expect((await request(viewerApp).post(`/api/operator-decisions/${DECISION_ID}/summary/retranslate`).send({})).status).toBe(403);

      setMembershipRole("member");
      const memberApp = createApp(boardUser("member-1"));
      expect((await request(memberApp).post(`/api/companies/${COMPANY_ID}/operator-decisions`).send(createPayload)).status).toBe(201);
      expect((await request(memberApp).post(`/api/operator-decisions/${DECISION_ID}/summary/retranslate`).send({})).status).toBe(200);

      const agentApp = createApp(agentActor());
      expect((await request(agentApp).post(`/api/companies/${COMPANY_ID}/operator-decisions`).send(createPayload)).status).toBe(201);
    });

    it("blocks viewer and member from resolve, cancel, and retry-continuation; allows admin, local_implicit, isInstanceAdmin, and agent cancel", async () => {
      for (const role of ["viewer", "member"] as const) {
        setMembershipRole(role);
        const app = createApp(boardUser(`${role}-1`));
        expect((await request(app).post(`/api/operator-decisions/${DECISION_ID}/resolve`).send(resolvePayload)).status).toBe(403);
        expect((await request(app).post(`/api/operator-decisions/${DECISION_ID}/cancel`).send({})).status).toBe(403);
        expect((await request(app).post(`/api/operator-decisions/${DECISION_ID}/retry-continuation`).send({})).status).toBe(403);
      }

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).post(`/api/operator-decisions/${DECISION_ID}/resolve`).send(resolvePayload)).status).toBe(200);
      expect((await request(adminApp).post(`/api/operator-decisions/${DECISION_ID}/cancel`).send({})).status).toBe(200);
      expect((await request(adminApp).post(`/api/operator-decisions/${DECISION_ID}/retry-continuation`).send({})).status).toBe(200);

      // Preserve local_implicit and isInstanceAdmin without membership lookup
      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).post(`/api/operator-decisions/${DECISION_ID}/resolve`).send(resolvePayload)).status).toBe(200);
      const instanceAdminApp = createApp(boardUser("inst-admin", { isInstanceAdmin: true }));
      expect((await request(instanceAdminApp).post(`/api/operator-decisions/${DECISION_ID}/cancel`).send({})).status).toBe(200);

      // Preserve agent cancel
      const agentApp = createApp(agentActor());
      expect((await request(agentApp).post(`/api/operator-decisions/${DECISION_ID}/cancel`).send({})).status).toBe(200);
    });
  });

  describe("quality-policies routes", () => {
    it("blocks viewer and member on create and activate, preserves 401 for unauthenticated, allows admin and local_implicit", async () => {
      const unauthApp = createApp({ type: "none" });
      expect((await request(unauthApp).post(`/api/companies/${COMPANY_ID}/quality/policies`).send({ policy: {} })).status).toBe(401);

      for (const role of ["viewer", "member"] as const) {
        setMembershipRole(role);
        const app = createApp(boardUser(`${role}-1`));
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/quality/policies`).send({ policy: {} })).status).toBe(403);
        expect((await request(app).post(`/api/companies/${COMPANY_ID}/quality/policies/${POLICY_ID}/activate`).send({
          expectedActivePolicyVersionId: null,
        })).status).toBe(403);
      }

      setMembershipRole("admin");
      const adminApp = createApp(boardUser("admin-1"));
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/quality/policies`).send({ policy: {} })).status).toBe(201);
      expect((await request(adminApp).post(`/api/companies/${COMPANY_ID}/quality/policies/${POLICY_ID}/activate`).send({
        expectedActivePolicyVersionId: null,
      })).status).toBe(200);

      setMembershipRole(null);
      const localApp = createApp(boardUser("local-board", { source: "local_implicit" }));
      expect((await request(localApp).post(`/api/companies/${COMPANY_ID}/quality/policies`).send({ policy: {} })).status).toBe(201);
    });
  });
});
