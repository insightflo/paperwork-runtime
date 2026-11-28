import { describe, expect, it } from "vitest";
import {
  exceptionHuddleMetadataSchema,
  type ExceptionHuddleDecision,
  type ExceptionHuddleMetadata,
} from "@paperclipai/shared/validators/exception-huddle";
import { buildExceptionHuddlePromptContext } from "../services/missions/exception-huddle-prompt-context.js";

const baseMetadata = {
  schemaVersion: "workflow.exception-huddle.v1",
  missionId: "mission-1",
  workflowRunId: "run-1",
  sourceStepId: "qa-step",
  sourceIssueId: "issue-1",
  workProductLinks: ["work-product://draft-report", "artifact://qa-evidence"],
  participants: {
    ownerAgentId: "chair-1",
    producerAgentId: "producer-1",
    validatorAgentId: "validator-1",
  },
  maxRounds: 2,
  currentRound: 1,
  timeoutAt: "2026-11-28T01:05:00.000Z",
  status: "open",
  decision: null,
  decidedByAgentId: null,
  decidedAt: null,
} as const;

function metadata(overrides: Partial<ExceptionHuddleMetadata> = {}): ExceptionHuddleMetadata {
  return exceptionHuddleMetadataSchema.parse({ ...baseMetadata, ...overrides });
}

const decisionInputs = [
  ["retry_with_guidance", "guidance", "Use only cited claims", /Retry the affected work/],
  ["accept_with_waiver", "waiverCondition", "Accept the UI copy scope despite the missing footer link", /Accept only the scope/],
  ["replan_remaining", "replanSummary", "Split remaining release validation into two tasks", /Replan the remaining work/],
  ["escalate", "escalationReason", "Evidence source is unavailable to all agents", /Stop the current execution path/],
] as const;

const decisionDetailLabels = {
  guidance: "Guidance",
  waiverCondition: "Waiver condition",
  replanSummary: "Replan summary",
  escalationReason: "Escalation reason",
} as const;

function decisionFor(
  kind: (typeof decisionInputs)[number][0],
  detail: string,
  overrides: Partial<ExceptionHuddleDecision> = {},
): ExceptionHuddleDecision {
  const field = decisionInputs.find(([candidate]) => candidate === kind)?.[1];
  if (!field) throw new Error(`unknown decision kind: ${kind}`);
  return {
    kind,
    rationale: `Rationale for ${kind}`,
    [field]: detail,
    forcedByChair: kind === "escalate",
    ...overrides,
  } as ExceptionHuddleDecision;
}

function decidedMetadata(decision: ExceptionHuddleDecision): ExceptionHuddleMetadata {
  return metadata({
    status: "decided",
    decision,
    decidedByAgentId: "chair-1",
    decidedAt: "2026-11-28T01:03:30.000Z",
  });
}

describe("buildExceptionHuddlePromptContext", () => {
  it("compiles open huddles for the owner chair with sole decision authority", () => {
    const result = buildExceptionHuddlePromptContext(metadata(), { recipientRole: "owner_chair" });

    expect(result).toMatchObject({ status: "open", decisionKind: null, truncated: false });
    expect(result.markdown).toContain("## Exception Huddle Context");
    expect(result.markdown).toContain("- Status: `open`");
    expect(result.markdown).toContain("- Round: `1/2`");
    expect(result.markdown).toContain("- Source step ID: `qa-step`");
    expect(result.markdown).toContain("- Source issue ID: `issue-1`");
    expect(result.markdown).toContain("work-product://draft-report");
    expect(result.markdown).toContain("sole decision authority");
    expect(result.markdown).toContain("`exception_huddle_decide`");
  });

  it.each(["owner_chair", "producer", "validator"] as const)(
    "marks the recipient role and compiles a role-specific directive for %s",
    (recipientRole) => {
      const result = buildExceptionHuddlePromptContext(metadata(), { recipientRole });

      expect(result.markdown).toContain(`- Recipient role: \`${recipientRole}\``);
      if (recipientRole === "owner_chair") {
        expect(result.markdown).toContain("sole decision authority");
      } else {
        expect(result.markdown).toContain("Provide concise structured evidence within the 2-round / 5-minute budget");
        expect(result.markdown).toContain("owner chair alone decides");
      }
    },
  );

  it("requires an immediate Chair decision for timed_out huddles", () => {
    const result = buildExceptionHuddlePromptContext(metadata({ status: "timed_out" }), { recipientRole: "owner_chair" });

    expect(result.status).toBe("timed_out");
    expect(result.markdown).toContain("timed out and requires an immediate Chair decision");
    expect(result.markdown).toContain("`exception_huddle_decide` now");
  });

  it.each(["producer", "validator"] as const)("freezes %s when the huddle timed out", (recipientRole) => {
    const result = buildExceptionHuddlePromptContext(metadata({ status: "timed_out" }), { recipientRole });

    expect(result.markdown).toContain("frozen pending the Chair decision");
    expect(result.markdown).toContain("Do not add further turns");
  });

  it.each(decisionInputs)("renders the exact structured fields for %s", (kind, field, detail, actionPattern) => {
    const decision = decisionFor(kind, detail);
    const result = buildExceptionHuddlePromptContext(decidedMetadata(decision), { recipientRole: "producer" });

    expect(result.status).toBe("decided");
    expect(result.decisionKind).toBe(kind);
    expect(result.markdown).toContain("### Structured Decision");
    expect(result.markdown).toContain(`- Kind: \`${kind}\``);
    expect(result.markdown).toContain(`Rationale for ${kind}`);
    expect(result.markdown).toContain(`- ${decisionDetailLabels[field]}: ${JSON.stringify(detail)}`);
    expect(result.markdown).toContain(`- Forced by chair: \`${String(decision.forcedByChair)}\``);
    expect(result.markdown).toContain("- Decided by agent ID: `chair-1`");
    expect(result.markdown).toContain("- Decided at: `2026-11-28T01:03:30.000Z`");
    expect(result.markdown).toMatch(actionPattern);
  });

  it("renders a concise cancelled notice", () => {
    const result = buildExceptionHuddlePromptContext(metadata({ status: "cancelled" }), { recipientRole: "validator" });

    expect(result.status).toBe("cancelled");
    expect(result.decisionKind).toBeNull();
    expect(result.markdown).toContain("cancelled");
    expect(result.markdown).toContain("Do not act on this huddle");
  });

  it("enforces maxChars with the deterministic truncation marker", () => {
    const decision = decisionFor("retry_with_guidance", `guidance-${"x".repeat(3000)}`, {
      rationale: `rationale-${"y".repeat(3000)}`,
    });
    const result = buildExceptionHuddlePromptContext(decidedMetadata(decision), {
      recipientRole: "owner_chair",
      maxChars: 200,
    });

    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(200);
    expect(result.markdown.endsWith("... [truncated]")).toBe(true);
    expect(result.markdown.startsWith("## Exception Huddle Context")).toBe(true);
  });

  it("treats maxChars below 200 as the 200-character minimum", () => {
    const decision = decisionFor("retry_with_guidance", `guidance-${"x".repeat(3000)}`);
    const result = buildExceptionHuddlePromptContext(decidedMetadata(decision), {
      recipientRole: "producer",
      maxChars: 20,
    });

    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(200);
    expect(result.markdown.length).toBeGreaterThan(20);
  });

  it("fails closed through Zod on malformed or non-schema metadata", () => {
    const invalidRound = { ...baseMetadata, currentRound: 3 } as unknown as ExceptionHuddleMetadata;
    const extraProse = { ...baseMetadata, failureSummary: "unstructured prose" } as unknown as ExceptionHuddleMetadata;

    expect(() => buildExceptionHuddlePromptContext(invalidRound, { recipientRole: "owner_chair" })).toThrow();
    expect(() => buildExceptionHuddlePromptContext(extraProse, { recipientRole: "owner_chair" })).toThrow();
  });

  it("fails closed on an unknown recipient role instead of inferring authority", () => {
    const invalidOptions = { recipientRole: "owner" } as unknown as Parameters<typeof buildExceptionHuddlePromptContext>[1];

    expect(() => buildExceptionHuddlePromptContext(metadata(), invalidOptions)).toThrow(TypeError);
  });
});
