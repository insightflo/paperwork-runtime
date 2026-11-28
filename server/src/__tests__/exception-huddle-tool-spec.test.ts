import { describe, expect, it } from "vitest";
import {
  EXCEPTION_HUDDLE_DECIDE_TOOL_NAME,
  EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA,
  buildExceptionHuddleBriefPrompt,
  parseExceptionHuddleDecideToolArgs,
} from "../services/missions/exception-huddle-tool-spec.js";

const THREAD_ID = "123e4567-e89b-42d3-a456-426614174000";
const VALID_DECISIONS = [
  {
    kind: "retry_with_guidance",
    rationale: "The rejection evidence is specific enough to retry.",
    guidance: "Cite the missing source and rerun QA.",
  },
  {
    kind: "accept_with_waiver",
    rationale: "The remaining issue is cosmetic and explicitly waived.",
    waiverCondition: "Waiver applies only to the formatting warning in this draft.",
  },
  {
    kind: "replan_remaining",
    rationale: "The original remaining plan no longer fits the validated facts.",
    replanSummary: "Keep the approved research, replace the publication step, then rerun QA.",
  },
  {
    kind: "escalate",
    rationale: "The participants cannot resolve the conflict within the cap.",
    escalationReason: "The specification and external source contradict each other.",
  },
] as const;

function payloadFor(decision: (typeof VALID_DECISIONS)[number]) {
  return { threadId: THREAD_ID, decision };
}

describe("EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA", () => {
  it("names the structured owner decision tool", () => {
    expect(EXCEPTION_HUDDLE_DECIDE_TOOL_NAME).toBe("exception_huddle_decide");
  });

  it("contains all four choices and the required thread/decision fields", () => {
    expect(EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA.required).toEqual(
      expect.arrayContaining(["threadId", "decision"]),
    );
    expect(EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA.properties.threadId).toMatchObject({
      type: "string",
      format: "uuid",
    });

    const decision = EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA.properties.decision;
    expect(decision).toMatchObject({ type: "object", additionalProperties: false });
    expect(decision.required).toEqual(expect.arrayContaining(["kind", "rationale"]));
    expect(decision.properties.kind.enum).toEqual([
      "retry_with_guidance",
      "accept_with_waiver",
      "replan_remaining",
      "escalate",
    ]);
    for (const field of ["guidance", "waiverCondition", "replanSummary", "escalationReason"] as const) {
      expect(decision.properties[field]).toMatchObject({ type: "string", minLength: 1 });
    }
  });

  it("marks each kind-specific field as conditionally required", () => {
    const branches = EXCEPTION_HUDDLE_DECIDE_TOOL_SCHEMA.properties.decision.anyOf;
    for (const field of ["guidance", "waiverCondition", "replanSummary", "escalationReason"]) {
      expect(branches.some((branch) => branch.required.includes(field))).toBe(true);
    }
  });
});

describe("parseExceptionHuddleDecideToolArgs", () => {
  it.each(VALID_DECISIONS)("accepts a valid $kind payload", (decision) => {
    const result = parseExceptionHuddleDecideToolArgs(payloadFor(decision));
    expect(result).toEqual({
      ok: true,
      threadId: THREAD_ID,
      decision: { ...decision, forcedByChair: false },
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["not a uuid", "not-a-uuid"],
  ])("rejects a %s threadId", (_label, threadId) => {
    const result = parseExceptionHuddleDecideToolArgs({ threadId, decision: VALID_DECISIONS[0] });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid UUIDs even when the decision is valid", () => {
    const result = parseExceptionHuddleDecideToolArgs({
      threadId: "550e8400-e29b-41d4-a716-446655440000-not-uuid",
      decision: VALID_DECISIONS[0],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("threadId");
  });

  it("rejects an unknown decision kind", () => {
    const result = parseExceptionHuddleDecideToolArgs({
      threadId: THREAD_ID,
      decision: {
        kind: "ignore_failure",
        rationale: "Invalid choices must never be accepted.",
        guidance: "This field cannot rescue an unknown kind.",
      },
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("kind");
  });

  it.each([
    ["retry_with_guidance", "guidance"],
    ["accept_with_waiver", "waiverCondition"],
    ["replan_remaining", "replanSummary"],
    ["escalate", "escalationReason"],
  ] as const)("rejects %s without %s", (kind, field) => {
    const decision = {
      kind,
      rationale: "The required kind-specific field is absent.",
    };
    const result = parseExceptionHuddleDecideToolArgs({ threadId: THREAD_ID, decision });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(field);
  });

  it("rejects unknown top-level and decision fields", () => {
    expect(parseExceptionHuddleDecideToolArgs({
      threadId: THREAD_ID,
      decision: VALID_DECISIONS[0],
      proseDecision: "accept anyway",
    }).ok).toBe(false);
    expect(parseExceptionHuddleDecideToolArgs({
      threadId: THREAD_ID,
      decision: { ...VALID_DECISIONS[0], proseDecision: "accept anyway" },
    }).ok).toBe(false);
  });
});

describe("buildExceptionHuddleBriefPrompt", () => {
  const baseInput = {
    threadId: THREAD_ID,
    currentRound: 1,
    maxRounds: 2,
    timeoutAt: "2026-11-28T01:05:00.000Z",
    failureSummary: "QA rejected unsupported claims in the draft.",
    workProductLinks: ["work-product://draft-report", "artifact://qa-evidence"],
  };

  it("briefs the Owner as the Chair with exclusive structured decision authority", () => {
    const prompt = buildExceptionHuddleBriefPrompt({ ...baseInput, role: "owner" });
    expect(prompt).toContain("Owner");
    expect(prompt).toContain("Chair");
    expect(prompt).toContain("exception_huddle_decide");
    expect(prompt).toContain("chat prose never decides");
    expect(prompt).toContain("2 rounds");
    expect(prompt).toContain("5 minutes");
    expect(prompt).toContain(THREAD_ID);
    expect(prompt).toContain(baseInput.failureSummary);
    expect(prompt).toContain("work-product://draft-report");
  });

  it.each(["producer", "validator"] as const)(
    "briefs the %s for evidence/proposal only and no decision authority",
    (role) => {
      const prompt = buildExceptionHuddleBriefPrompt({ ...baseInput, role });
      expect(prompt).toContain("evidence and proposal only");
      expect(prompt).toContain("cannot decide");
      expect(prompt).toContain("Only the Owner");
      expect(prompt).toContain("exception_huddle_decide");
      expect(prompt).toContain("chat prose never decides");
      expect(prompt).not.toContain("You are the Owner and Chair");
    },
  );
});
