// Stage 26 Wave 3: human_wait decision card creator tests.
// Pure mapping tests plus embedded-PG idempotency tests. There is no natural-language
// parsing surface here: template fields map 1:1 into structured title/description/options/facts.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  HUMAN_WAIT_SOURCE_TYPE,
  buildHumanWaitDecisionInput,
  buildHumanWaitRequestKey,
  ensureHumanWaitDecisionCard,
} from "../services/workflow/human-wait-card.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

type KeyParams = Parameters<typeof buildHumanWaitRequestKey>[0];
type CardParams = Parameters<typeof buildHumanWaitDecisionInput>[0];

function keyParams(overrides: Partial<KeyParams> = {}): KeyParams {
  return {
    companyId: randomUUID(),
    workflowRunId: randomUUID(),
    stepKey: "approve-draft",
    generation: 0,
    ...overrides,
  };
}

function cardParams(overrides: Partial<CardParams> = {}): CardParams {
  return {
    companyId: randomUUID(),
    missionId: null,
    issueId: null,
    workflowRunId: randomUUID(),
    stepKey: "approve-draft",
    stepName: "Draft review",
    generation: 2,
    decisionTemplate: null,
    ...overrides,
  };
}

describe("buildHumanWaitRequestKey", () => {
  it("is deterministic for identical params", () => {
    const params = keyParams();
    expect(buildHumanWaitRequestKey(params)).toBe(buildHumanWaitRequestKey({ ...params }));
  });

  it("changes when any scoping component changes", () => {
    const base = keyParams();
    const key = buildHumanWaitRequestKey(base);
    expect(buildHumanWaitRequestKey({ ...base, generation: base.generation + 1 })).not.toBe(key);
    expect(buildHumanWaitRequestKey({ ...base, stepKey: "other-step" })).not.toBe(key);
    expect(buildHumanWaitRequestKey({ ...base, workflowRunId: randomUUID() })).not.toBe(key);
    expect(buildHumanWaitRequestKey({ ...base, companyId: randomUUID() })).not.toBe(key);
  });

  it("carries a stable human-wait prefix and all components", () => {
    const params = keyParams({ stepKey: "gate_1", generation: 7 });
    const key = buildHumanWaitRequestKey(params);
    expect(key.startsWith("human-wait:")).toBe(true);
    expect(key).toContain(params.companyId);
    expect(key).toContain(params.workflowRunId);
    expect(key.endsWith(":gate_1:7")).toBe(true);
  });
});

describe("buildHumanWaitDecisionInput", () => {
  it("maps defaults into a single-select approve/reject card", () => {
    const params = cardParams();
    const input = buildHumanWaitDecisionInput(params);
    expect(input.companyId).toBe(params.companyId);
    expect(input.schemaVersion).toBe(1);
    expect(input.requestKey).toBe(buildHumanWaitRequestKey(params));
    expect(input.priority).toBe("high");
    expect(input.interactionType).toBe("single_select");
    expect(input.sourceType).toBe(HUMAN_WAIT_SOURCE_TYPE);
    expect(input.sourceId).toBe(`${params.workflowRunId}:approve-draft`);
    expect(input.title).toBe("Human approval: Draft review");
    expect(input.description).toContain("Draft review");
    expect(input.issueId).toBeNull();
    expect(input.continuationMode).toBe("none");
    expect(input.sourceContext).toMatchObject({
      missionId: null,
      workflowId: null,
      workflowRunId: params.workflowRunId,
      artifactRefs: [],
      targetSnapshot: { executionGeneration: 2 },
    });
    expect(input.definition.options.map((option) => option.id)).toEqual(["approve", "reject"]);
    expect(input.definition.options.map((option) => option.label)).toEqual(["Approve", "Reject"]);
    expect(input.definition.selection).toEqual({ min: 1, max: 1 });
    expect(input.definition.actions).toHaveLength(1);
    expect(input.definition.actions[0]).toMatchObject({ id: "submit", outcome: "submit", requiresSelection: true });
  });

  it("applies template overrides for title, prompt, and labels", () => {
    const input = buildHumanWaitDecisionInput(cardParams({
      decisionTemplate: {
        title: "Sign off the draft",
        prompt: "Review the compliance draft before continuing.",
        approvalLabel: "Sign off",
        rejectLabel: "Send back",
      },
    }));
    expect(input.title).toBe("Sign off the draft");
    expect(input.description).toBe("Review the compliance draft before continuing.");
    expect(input.definition.options.map((option) => option.label)).toEqual(["Sign off", "Send back"]);
  });

  it("omits the reject option when allowReject is false", () => {
    const input = buildHumanWaitDecisionInput(cardParams({ decisionTemplate: { allowReject: false } }));
    expect(input.definition.options.map((option) => option.id)).toEqual(["approve"]);
    expect(input.definition.selection).toEqual({ min: 1, max: 1 });
  });

  it("maps requiredRole and timeoutMinutes into structured option facts", () => {
    const input = buildHumanWaitDecisionInput(cardParams({
      decisionTemplate: { requiredRole: "compliance-lead", timeoutMinutes: 90 },
    }));
    const expectedFacts = [
      { label: "Required role", value: "compliance-lead", status: "known" },
      { label: "Timeout", value: "90 minutes", status: "known" },
    ];
    for (const option of input.definition.options) {
      expect(option.facts).toEqual(expectedFacts);
    }
  });

  it("binds issue continuation when an issueId is provided", () => {
    const issueId = randomUUID();
    const input = buildHumanWaitDecisionInput(cardParams({ issueId }));
    expect(input.issueId).toBe(issueId);
    expect(input.continuationMode).toBe("issue_current_assignee");
  });

  it("satisfies the strict create contract with a deterministic hash", () => {
    const input = buildHumanWaitDecisionInput(cardParams());
    const { companyId, ...create } = input;
    const first = validateAndHashOperatorDecisionCreate(create);
    const second = validateAndHashOperatorDecisionCreate(create);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describeDb("ensureHumanWaitDecisionCard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("human-wait-card-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb.cleanup();
  });

  afterEach(async () => {
    await db.delete(operatorDecisions);
    await db.delete(companies);
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "HW", issuePrefix: `H${id.slice(0, 4)}` });
    return id;
  }

  it("creates the card once and replays return the same card without duplicates", async () => {
    const companyId = await seedCompany();
    const missionId = randomUUID();
    const input = buildHumanWaitDecisionInput(cardParams({ companyId, missionId }));
    const first = await ensureHumanWaitDecisionCard(db, input);
    expect(first.created).toBe(true);
    expect(first.card.requestKey).toBe(input.requestKey);
    expect(first.card.status).toBe("pending");
    expect(first.card.sourceType).toBe(HUMAN_WAIT_SOURCE_TYPE);
    expect(first.card.sourceContext).toMatchObject({ missionId, workflowRunId: input.sourceContext.workflowRunId });
    const replay = await ensureHumanWaitDecisionCard(db, input);
    expect(replay.created).toBe(false);
    expect(replay.card.id).toBe(first.card.id);
    expect(replay.card.createdAt).toEqual(first.card.createdAt);
    const rows = await db.select().from(operatorDecisions);
    expect(rows).toHaveLength(1);
  });

  it("keeps card identity scoped per company", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const shared = { workflowRunId: randomUUID(), stepKey: "gate", generation: 1 };
    const first = await ensureHumanWaitDecisionCard(db, buildHumanWaitDecisionInput(cardParams({ companyId: companyA, ...shared })));
    const second = await ensureHumanWaitDecisionCard(db, buildHumanWaitDecisionInput(cardParams({ companyId: companyB, ...shared })));
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.card.id).not.toBe(first.card.id);
    const rows = await db.select().from(operatorDecisions);
    expect(rows).toHaveLength(2);
    const persistedGeneration = (first.card.sourceContext as { targetSnapshot?: { executionGeneration?: number } }).targetSnapshot;
    expect(persistedGeneration).toEqual({ executionGeneration: 1 });
  });
});
