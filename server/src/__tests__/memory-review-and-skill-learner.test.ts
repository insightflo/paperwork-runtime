import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { computeLineDiff, createMemoryReviewStore } from "../services/agent-memory-review.js";
import { createLocalSkillLearnerStore } from "../services/local-skill-learner.js";
import { agentGovernanceLearningRoutes } from "../routes/agent-governance-learning.js";

const PROPOSAL_INPUT = {
  companyId: "c1",
  agentId: "agent-1",
  targetPath: "agents/agent-1/memory.md",
  beforeContent: "alpha\nbeta\ngamma",
  afterContent: "alpha\ndelta\ngamma",
  summary: "replace beta with delta",
};

describe("memory review store", () => {
  it("computes a deterministic unified line diff and stores it on propose", () => {
    expect(computeLineDiff("alpha\nbeta\ngamma", "alpha\ndelta\ngamma")).toEqual([
      "  alpha",
      "- beta",
      "+ delta",
      "  gamma",
    ]);
    const store = createMemoryReviewStore();
    const proposal = store.propose(PROPOSAL_INPUT);
    expect(proposal.status).toBe("pending");
    expect(proposal.diffLines).toEqual(
      computeLineDiff(PROPOSAL_INPUT.beforeContent, PROPOSAL_INPUT.afterContent),
    );
    expect(proposal.diffLines).toContain("- beta");
  });

  it("rejects path traversal, NUL bytes, and empty target paths", () => {
    const store = createMemoryReviewStore();
    for (const targetPath of ["../escape.md", "memory/\0evil.md", ""]) {
      expect(() => store.propose({ ...PROPOSAL_INPUT, targetPath })).toThrow();
    }
    expect(store.list("c1")).toEqual([]);
  });

  it("hold blocks the held target until expiry", () => {
    const store = createMemoryReviewStore();
    const held = store.decide("c1", store.propose(PROPOSAL_INPUT).id, {
      decision: "hold",
      userId: "user-1",
      note: "wait for review",
      holdMs: 60_000,
    });
    expect(held.status).toBe("held");
    expect(held.heldUntilMs).not.toBeNull();
    expect(store.isTargetHeld("c1", "agent-1", PROPOSAL_INPUT.targetPath)).toBe(true);
    expect(store.isTargetHeld("c1", "agent-2", PROPOSAL_INPUT.targetPath)).toBe(false);
    expect(store.isTargetHeld("c1", "agent-1", "other.md")).toBe(false);
    const expiry = held.heldUntilMs ?? 0;
    expect(store.isTargetHeld("c1", "agent-1", PROPOSAL_INPUT.targetPath, expiry + 1)).toBe(false);
  });

  it("approves and rejects pending proposals", () => {
    const store = createMemoryReviewStore();
    const approved = store.decide("c1", store.propose(PROPOSAL_INPUT).id, {
      decision: "approve",
      userId: "user-1",
      note: "ok",
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewedByUserId).toBe("user-1");
    expect(approved.reviewNote).toBe("ok");
    const rejected = store.decide("c1", store.propose(PROPOSAL_INPUT).id, {
      decision: "reject",
      userId: "user-1",
    });
    expect(rejected.status).toBe("rejected");
  });

  it("does not allow re-deciding a decided proposal", () => {
    const store = createMemoryReviewStore();
    const proposal = store.propose(PROPOSAL_INPUT);
    store.decide("c1", proposal.id, { decision: "approve", userId: "user-1" });
    expect(() => store.decide("c1", proposal.id, { decision: "hold", userId: "user-1" })).toThrow();
  });

  it("enforces company isolation on decide and list", () => {
    const store = createMemoryReviewStore();
    const proposal = store.propose(PROPOSAL_INPUT);
    expect(() => store.decide("c2", proposal.id, { decision: "approve", userId: "user-2" })).toThrow();
    expect(store.list("c2")).toEqual([]);
    expect(store.list("c1")).toHaveLength(1);
    expect(store.list("c1", { status: "held" })).toEqual([]);
  });
});

describe("local skill learner store", () => {
  const DRAFT_INPUT = {
    companyId: "c1",
    slug: "triage-ticket",
    title: "Ticket Triage",
    description: "How to triage tickets",
    steps: ["Read the ticket", "Label the ticket"],
    sourceRunId: "run-1",
  };

  it("generates deterministic SKILL.md with frontmatter and numbered steps", () => {
    const store = createLocalSkillLearnerStore();
    const draft = store.extractDraft(DRAFT_INPUT);
    expect(draft.skillMarkdown).toContain("---");
    expect(draft.skillMarkdown).toContain("name: triage-ticket");
    expect(draft.skillMarkdown).toContain("1. Read the ticket");
    expect(draft.skillMarkdown).toContain("2. Label the ticket");
    expect(draft.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.revision).toBe(1);
    expect(draft.status).toBe("draft");
    const repeat = createLocalSkillLearnerStore().extractDraft(DRAFT_INPUT);
    expect(repeat.skillMarkdown).toBe(draft.skillMarkdown);
    expect(repeat.contentSha256).toBe(draft.contentSha256);
  });

  it("dedupes identical content without a new revision", () => {
    const store = createLocalSkillLearnerStore();
    const first = store.extractDraft(DRAFT_INPUT);
    const second = store.extractDraft({ ...DRAFT_INPUT, sourceRunId: "run-2" });
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(1);
    expect(second.sourceRunIds).toEqual(["run-1", "run-2"]);
    expect(store.list("c1")).toHaveLength(1);
  });

  it("creates an immutable next revision for new content", () => {
    const store = createLocalSkillLearnerStore();
    const first = store.extractDraft(DRAFT_INPUT);
    const next = store.extractDraft({
      ...DRAFT_INPUT,
      steps: ["Read the ticket", "Label the ticket", "Escalate"],
      sourceRunId: "run-3",
    });
    expect(next.id).not.toBe(first.id);
    expect(next.revision).toBe(2);
    expect(next.contentSha256).not.toBe(first.contentSha256);
    expect(store.list("c1")).toHaveLength(2);
  });

  it("promotes and discards drafts with company isolation", () => {
    const store = createLocalSkillLearnerStore();
    const draft = store.extractDraft(DRAFT_INPUT);
    expect(store.promote("c1", draft.id).status).toBe("promoted");
    expect(() => store.promote("c2", draft.id)).toThrow();
    const other = store.extractDraft({ ...DRAFT_INPUT, companyId: "c2", steps: ["x"] });
    expect(store.discard("c2", other.id).status).toBe("discarded");
    expect(() => store.discard("c2", draft.id)).toThrow();
  });
});

function governanceApp(companyIds: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "user-1", companyIds, source: "session", isInstanceAdmin: false };
    next();
  });
  app.use("/api", agentGovernanceLearningRoutes());
  app.use(errorHandler);
  return app;
}

describe("governance learning routes", () => {
  const companyId = "route-company-1";
  const app = () => governanceApp([companyId]);

  it("serves memory review endpoints end to end", async () => {
    const created = await request(app())
      .post(`/api/companies/${companyId}/memory-reviews`)
      .send({ agentId: "agent-1", targetPath: "agents/agent-1/memory.md", beforeContent: "before", afterContent: "after", summary: "update memory" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    const listed = await request(app()).get(`/api/companies/${companyId}/memory-reviews`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    const decided = await request(app())
      .post(`/api/companies/${companyId}/memory-reviews/${created.body.id}/decide`)
      .send({ decision: "approve", userId: "user-1", note: "ok" });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("approved");
    const invalid = await request(app()).post(`/api/companies/${companyId}/memory-reviews`).send({ agentId: "agent-1" });
    expect(invalid.status).toBe(400);
  });

  it("blocks other companies from memory reviews", async () => {
    const res = await request(app()).get("/api/companies/other-company/memory-reviews");
    expect(res.status).toBe(403);
  });

  it("serves skill draft endpoints end to end", async () => {
    const created = await request(app())
      .post(`/api/companies/${companyId}/skill-drafts`)
      .send({ slug: "triage-ticket", title: "Ticket Triage", description: "How to triage", steps: ["Read it"], sourceRunId: "run-1" });
    expect(created.status).toBe(201);
    expect(created.body.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const listed = await request(app()).get(`/api/companies/${companyId}/skill-drafts`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    const promoted = await request(app()).post(`/api/companies/${companyId}/skill-drafts/${created.body.id}/promote`);
    expect(promoted.status).toBe(200);
    expect(promoted.body.status).toBe("promoted");
  });

  it("discards a draft", async () => {
    const created = await request(app())
      .post(`/api/companies/${companyId}/skill-drafts`)
      .send({ slug: "escalate-bug", title: "Escalate Bug", description: "Escalation", steps: ["Reproduce"], sourceRunId: "run-9" });
    const discarded = await request(app()).post(`/api/companies/${companyId}/skill-drafts/${created.body.id}/discard`);
    expect(discarded.status).toBe(200);
    expect(discarded.body.status).toBe("discarded");
  });
});
