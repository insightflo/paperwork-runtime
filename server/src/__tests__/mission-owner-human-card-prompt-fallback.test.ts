import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOperatorDecisionSchema } from "@paperclipai/shared/validators/operator-decision";
import {
  buildMissionOwnerHumanInputDecisionCard,
  hasConcreteHumanCardReason,
  isGenericFallbackMissionHumanCard,
  type MissionOwnerHumanInputCardSpec,
} from "../services/missions/mission-owner-human-input-card.js";

function spec(overrides: Partial<MissionOwnerHumanInputCardSpec> = {}): MissionOwnerHumanInputCardSpec {
  return {
    companyId: randomUUID(),
    missionId: randomUUID(),
    decisionEventId: randomUUID(),
    decision: "request_input",
    ownerActionIssueId: randomUUID(),
    ownerActionIssueStatus: "in_progress",
    requestedByAgentId: randomUUID(),
    issueTitle: "Owner oversight",
    issueIdentifier: "GAZ-1",
    sourceIssueId: null,
    workflowRunId: null,
    ...overrides,
  };
}

describe("mission owner human card prompt fallback", () => {
  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace", " \n\t "],
  ] as const)("uses nextAction as the symptom when reason is %s", (_name, reason) => {
    const nextAction = "운영자가 복구 경로를 선택해 주세요";
    const input = spec({
      nextAction,
      ...(reason === undefined ? {} : { reason }),
    });
    const card = buildMissionOwnerHumanInputDecisionCard(input);

    expect(() => createOperatorDecisionSchema.parse(card)).not.toThrow();
    const review = card.definition.humanReview!;
    expect(review.recommendedNextStep).toBe(nextAction);
    expect(review.symptom).toBe(nextAction);
    expect(review.symptom!.trim().length).toBeGreaterThan(0);
    expect(hasConcreteHumanCardReason({
      nextAction,
      ...(reason === undefined ? {} : { reason }),
    })).toBe(true);
  });

  it("keeps the generic fallback card shape when reason and nextAction are both absent", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec());
    const review = card.definition.humanReview!;

    expect(review.symptom).toBeUndefined();
    expect(isGenericFallbackMissionHumanCard({ requestKey: card.requestKey, definition: card.definition })).toBe(true);
    expect(hasConcreteHumanCardReason({})).toBe(false);
  });
});
