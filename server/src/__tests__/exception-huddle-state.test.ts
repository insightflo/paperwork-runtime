import { describe, expect, it } from "vitest";
import {
  EXCEPTION_HUDDLE_MAX_ROUNDS,
  EXCEPTION_HUDDLE_TIMEOUT_MS,
  exceptionHuddleDecisionKindSchema,
  exceptionHuddleDecisionSchema,
  exceptionHuddleMetadataSchema,
  exceptionHuddleRoleSchema,
  exceptionHuddleStatusSchema,
  type ExceptionHuddleDecision,
} from "@paperclipai/shared/validators/index";
import {
  createInitialExceptionHuddleState,
  evaluateHuddleDecision,
  evaluateHuddleTurn,
  type ExceptionHuddleEvaluation,
  type ExceptionHuddleState,
} from "../services/missions/exception-huddle-state.js";

const now = new Date("2026-11-28T01:00:00.000Z");
const initialInput = {
  missionId: "mission-1", workflowRunId: "run-1", sourceStepId: "qa-step",
  sourceIssueId: null, workProductLinks: ["/work-products/report.html"],
  participants: { ownerAgentId: "chair", producerAgentId: "writer", validatorAgentId: "reviewer" }, now,
};
const choices = [
  ["retry_with_guidance", "guidance"], ["accept_with_waiver", "waiverCondition"],
  ["replan_remaining", "replanSummary"], ["escalate", "escalationReason"],
] as const;
const retry = exceptionHuddleDecisionSchema.parse({
  kind: "retry_with_guidance", rationale: "Evidence needs correction", guidance: "Fix the evidence",
});
const initial = () => createInitialExceptionHuddleState(initialInput);
function accepted(result: ExceptionHuddleEvaluation): ExceptionHuddleState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}
const turn = (state: ExceptionHuddleState, actorAgentId: string) =>
  evaluateHuddleTurn(state, { actorAgentId, now });
const decide = (state: ExceptionHuddleState, actorAgentId = "chair", at = now, decision = retry) =>
  evaluateHuddleDecision(state, { actorAgentId, now: at, decision });
function exhausted(state = initial()) {
  for (let round = 0; round < state.maxRounds; round++) {
    state = accepted(turn(state, "writer"));
    state = accepted(turn(state, "reviewer"));
  }
  return state;
}

describe("exception huddle shared contract", () => {
  it("exports the fixed caps and exact role/status/decision choices", () => {
    expect(EXCEPTION_HUDDLE_MAX_ROUNDS).toBe(2);
    expect(EXCEPTION_HUDDLE_TIMEOUT_MS).toBe(300_000);
    expect(exceptionHuddleRoleSchema.options).toEqual(["owner", "producer", "validator"]);
    expect(exceptionHuddleStatusSchema.options).toEqual(["open", "decided", "timed_out", "cancelled"]);
    expect(exceptionHuddleDecisionKindSchema.options).toEqual(choices.map(([kind]) => kind));
  });

  it.each(choices)("validates %s with its required %s and an explicit decision", (kind, field) => {
    const payload = { kind, rationale: "  explain  ", [field]: "  action  " };
    const decision = exceptionHuddleDecisionSchema.parse(payload);
    expect(decision).toMatchObject({ rationale: "explain", [field]: "action", forcedByChair: false });
    expect(accepted(decide(initial(), "chair", now, decision))).toMatchObject({
      status: "decided", decision, decidedByAgentId: "chair", decidedAt: now.toISOString(),
    });
    for (const value of [undefined, "", "  "]) {
      const invalid = { ...payload, [field]: value };
      expect(exceptionHuddleDecisionSchema.safeParse(invalid).success).toBe(false);
      expect(decide(initial(), "chair", now, invalid as ExceptionHuddleDecision))
        .toEqual({ ok: false, code: "huddle_invalid_decision" });
    }
  });

  it("rejects invalid rationale, unknown choices/fields and nonboolean force flags", () => {
    for (const rationale of ["", " ", "a".repeat(4001)]) {
      expect(exceptionHuddleDecisionSchema.safeParse({ ...retry, rationale }).success).toBe(false);
    }
    expect(exceptionHuddleDecisionSchema.safeParse({ ...retry, rationale: "a".repeat(4000) }).success).toBe(true);
    for (const override of [{ kind: "APPROVED" }, { extra: "accepted" }, { forcedByChair: "true" }]) {
      expect(exceptionHuddleDecisionSchema.safeParse({ ...retry, ...override }).success).toBe(false);
    }
  });

  it("round-trips versioned metadata and defaults while enforcing bounds", () => {
    const { roundTurns: _turns, ...metadata } = initial();
    expect(exceptionHuddleMetadataSchema.parse(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
    const { maxRounds: _max, currentRound: _round, ...withoutDefaults } = metadata;
    expect(exceptionHuddleMetadataSchema.parse(withoutDefaults)).toMatchObject({ maxRounds: 2, currentRound: 1 });
    for (const override of [
      { schemaVersion: "v0" }, { maxRounds: 3 }, { maxRounds: 0 }, { maxRounds: 1.5 },
      { currentRound: 0 }, { currentRound: 3 }, { currentRound: 1.5 }, { maxRounds: 1, currentRound: 2 },
      { timeoutAt: "tomorrow" }, { decidedAt: "now" }, { status: "approved" }, { missionId: " " },
      { participants: { ...metadata.participants, ownerAgentId: "" } },
      { decision: { kind: "escalate", rationale: "why" } },
    ]) expect(exceptionHuddleMetadataSchema.safeParse({ ...metadata, ...override }).success).toBe(false);
    expect(exceptionHuddleMetadataSchema.parse({ ...metadata, sourceIssueId: "issue-1" }).sourceIssueId).toBe("issue-1");
  });
});

describe("pure exception huddle state", () => {
  it("creates an open round-one state with exactly five minutes and detached input data", () => {
    const state = initial();
    expect(state).toMatchObject({
      currentRound: 1, maxRounds: 2, status: "open", decision: null, decidedByAgentId: null, decidedAt: null,
      timeoutAt: "2026-11-28T01:05:00.000Z", roundTurns: { 1: [], 2: [] },
    });
    expect(state.participants).not.toBe(initialInput.participants);
    expect(state.workProductLinks).not.toBe(initialInput.workProductLinks);
    expect(createInitialExceptionHuddleState({ ...initialInput, timeoutMs: 1000 }).timeoutAt)
      .toBe("2026-11-28T01:00:01.000Z");
    for (const timeoutMs of [0, -1, 300_001, NaN, Infinity, 1.5]) {
      expect(() => createInitialExceptionHuddleState({ ...initialInput, timeoutMs })).toThrow(RangeError);
    }
    expect(() => createInitialExceptionHuddleState({ ...initialInput, maxRounds: 3 })).toThrow();
  });

  it.each([["writer", "reviewer"], ["reviewer", "writer"]])(
    "advances only after both evidence roles, in order %s / %s", (first, second) => {
      let state = accepted(turn(initial(), "chair"));
      expect(turn(state, "chair")).toEqual({ ok: false, code: "huddle_duplicate_turn" });
      state = accepted(turn(state, first));
      expect(state.currentRound).toBe(1);
      expect(turn(state, first)).toEqual({ ok: false, code: "huddle_duplicate_turn" });
      state = accepted(turn(state, second));
      expect(state.currentRound).toBe(2);
      expect(state.roundTurns[2]).toEqual([]);
      expect(accepted(decide(state)).decision?.forcedByChair).toBe(false);
      state = accepted(turn(state, "chair"));
      state = accepted(turn(state, first));
      state = accepted(turn(state, second));
      expect(state).toMatchObject({ currentRound: 2, status: "open", decision: null });
      for (const actor of ["chair", "writer", "reviewer"]) {
        expect(turn(state, actor)).toEqual({ ok: false, code: "huddle_round_cap_reached_chair_decision_required" });
      }
      expect(accepted(decide(state)).decision?.forcedByChair).toBe(true);
    },
  );

  it("retains per-round receipts through JSON persistence and permits only one configured round", () => {
    const state = exhausted(createInitialExceptionHuddleState({ ...initialInput, maxRounds: 1 }));
    const restored = JSON.parse(JSON.stringify(state)) as ExceptionHuddleState;
    expect(restored.currentRound).toBe(1);
    expect(turn(restored, "chair")).toEqual({ ok: false, code: "huddle_round_cap_reached_chair_decision_required" });
    expect(accepted(decide(restored)).decision?.forcedByChair).toBe(true);
    expect(turn({ ...initial(), currentRound: 3 }, "writer"))
      .toEqual({ ok: false, code: "huddle_round_cap_reached_chair_decision_required" });
  });

  it("blocks outsiders before recording any participation", () => {
    expect(turn(initial(), "outsider")).toEqual({ ok: false, code: "huddle_actor_not_participant" });
  });

  it.each(["writer", "reviewer", "outsider"])("denies %s structured decision authority", (actor) => {
    for (const state of [initial(), exhausted(), { ...initial(), status: "timed_out" as const }]) {
      expect(decide(state, actor)).toEqual({ ok: false, code: "huddle_chair_only_decision" });
    }
  });

  it.each([300_000, 300_001])("blocks chatter at elapsed %i ms but allows a forced Owner decision", (elapsed) => {
    const state = initial();
    const at = new Date(now.getTime() + elapsed);
    expect(evaluateHuddleTurn(state, { actorAgentId: "writer", now: at }))
      .toEqual({ ok: false, code: "huddle_timed_out_chair_decision_required" });
    expect(accepted(decide(state, "chair", at))).toMatchObject({
      status: "decided", decision: { forcedByChair: true }, decidedAt: at.toISOString(),
    });
    expect(state.status).toBe("open");
  });

  it("accepts a turn and an unforced decision one millisecond before timeout", () => {
    const at = new Date(now.getTime() + 299_999);
    expect(evaluateHuddleTurn(initial(), { actorAgentId: "writer", now: at }).ok).toBe(true);
    expect(accepted(decide(initial(), "chair", at)).decision?.forcedByChair).toBe(false);
  });

  it("allows the Owner to resolve a persisted timed-out state", () => {
    const state = { ...initial(), status: "timed_out" as const };
    expect(turn(state, "writer")).toEqual({ ok: false, code: "huddle_already_closed" });
    expect(accepted(decide(state))).toMatchObject({ status: "decided", decision: { forcedByChair: true } });
  });

  it.each(["decided", "cancelled"] as const)("rejects turns and further decisions after %s", (status) => {
    const state = status === "decided" ? accepted(decide(initial())) : { ...initial(), status };
    expect(turn(state, "writer")).toEqual({ ok: false, code: "huddle_already_closed" });
    expect(decide(state)).toEqual({ ok: false, code: "huddle_already_closed" });
  });

  it.each(["APPROVED", "retry_with_guidance", "accept_with_waiver", "replan_remaining", "escalate"])(
    "never reads %s chatter or embedded decision payloads as authority", (body) => {
      const state = initial();
      const input = { actorAgentId: "chair", now, body, decision: retry, status: "decided" };
      Object.defineProperty(input, "body", { get: () => { throw new Error("Text must never be read"); } });
      expect(accepted(evaluateHuddleTurn(state, input))).toMatchObject({
        status: "open", decision: null, decidedByAgentId: null, decidedAt: null,
      });
    },
  );

  it("does not mutate frozen state or decision payloads on success or rejection", () => {
    const state = initial();
    const before = JSON.stringify(state);
    Object.freeze(state.participants);
    Object.freeze(state.workProductLinks);
    Object.freeze(state.roundTurns[1]);
    Object.freeze(state.roundTurns[2]);
    Object.freeze(state.roundTurns);
    Object.freeze(state);
    const decision = Object.freeze({ ...retry });
    expect(turn(state, "writer").ok).toBe(true);
    expect(decide(state, "chair", new Date(now.getTime() + 300_000), decision).ok).toBe(true);
    expect(decision.forcedByChair).toBe(false);
    expect(turn(state, "outsider").ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("rejects invalid clocks rather than bypassing the deadline", () => {
    const at = new Date(NaN);
    expect(() => createInitialExceptionHuddleState({ ...initialInput, now: at })).toThrow(RangeError);
    expect(() => evaluateHuddleTurn(initial(), { actorAgentId: "writer", now: at })).toThrow(RangeError);
    expect(() => decide(initial(), "chair", at)).toThrow(RangeError);
  });
});
