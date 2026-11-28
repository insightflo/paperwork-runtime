import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createInitialExceptionHuddleState } from "../services/missions/exception-huddle-state.js";
import {
  maybeConveneQaFailureHuddle,
  type QaFailureHuddleInput,
} from "../services/missions/exception-huddle-qa-hook.js";
import type { ConveneExceptionHuddleInput } from "../services/missions/exception-huddle-service.js";

const NOW = new Date("2026-11-28T01:00:00.000Z");
const db = {} as Db;

function hookInput(overrides: Partial<QaFailureHuddleInput> = {}): QaFailureHuddleInput {
  return {
    companyId: randomUUID(),
    missionId: randomUUID(),
    workflowRunId: randomUUID(),
    sourceStepId: "qa-review",
    sourceIssueId: randomUUID(),
    ownerAgentId: randomUUID(),
    producerAgentId: randomUUID(),
    validatorAgentId: randomUUID(),
    verdict: "REQUEST_CHANGES",
    errorCode: null,
    errorSummary: null,
    failureKind: "qa_rejection",
    qaFailureCount: 1,
    workProductLinks: ["work-product://draft-report"],
    failureSummary: "QA rejected unsupported claims in the draft",
    ...overrides,
  };
}

function huddleFor(input: ConveneExceptionHuddleInput) {
  return {
    ...createInitialExceptionHuddleState({
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      sourceStepId: input.sourceStepId,
      sourceIssueId: input.sourceIssueId ?? null,
      workProductLinks: input.workProductLinks,
      participants: {
        ownerAgentId: input.ownerAgentId,
        producerAgentId: input.producerAgentId,
        validatorAgentId: input.validatorAgentId,
      },
      now: NOW,
    }),
    failureSummary: input.failureSummary,
  };
}

function successfulConvene() {
  return vi.fn(async (_db: Db, input: ConveneExceptionHuddleInput) => ({
    convened: true as const,
    eligibility: {
      eligible: true as const,
      category: "qa_content_rejection" as const,
      reason: "structured_qa_rejection_signal",
    },
    channelId: "channel-1",
    threadId: "thread-1",
    huddle: huddleFor(input),
  }));
}

function forbiddenConvene() {
  return vi.fn(async (_db: Db, _input: ConveneExceptionHuddleInput): Promise<never> => {
    throw new Error("convene must not be called");
  });
}

describe("maybeConveneQaFailureHuddle", () => {
  it("convenes a first QA REQUEST_CHANGES failure with all three participants", async () => {
    const input = hookInput();
    const convene = successfulConvene();

    const result = await maybeConveneQaFailureHuddle(input, { db, convene });

    expect(convene).toHaveBeenCalledTimes(1);
    expect(convene).toHaveBeenCalledWith(db, expect.objectContaining({
      companyId: input.companyId,
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      sourceStepId: input.sourceStepId,
      sourceIssueId: input.sourceIssueId,
      ownerAgentId: input.ownerAgentId,
      producerAgentId: input.producerAgentId,
      validatorAgentId: input.validatorAgentId,
      workProductLinks: input.workProductLinks,
      failureSummary: input.failureSummary,
    }));
    expect(result).toMatchObject({
      action: "huddle_convened",
      skipUnblockIssue: true,
      channelId: "channel-1",
      threadId: "thread-1",
      eligibility: {
        eligible: true,
        category: "qa_content_rejection",
        reason: "structured_qa_rejection_signal",
      },
    });
    if (result.action !== "huddle_convened") throw new Error("expected huddle_convened");
    expect(result.huddle.failureSummary).toBe(input.failureSummary);
  });

  it("falls back without convening for a second QA failure", async () => {
    const convene = forbiddenConvene();

    const result = await maybeConveneQaFailureHuddle(hookInput({ qaFailureCount: 2 }), { db, convene });

    expect(convene).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "fallback_standard_flow",
      skipUnblockIssue: false,
      eligibility: {
        eligible: false,
        category: "unknown_non_collaborative",
        reason: "huddle_mvp_first_qa_failure_only",
      },
    });
  });

  it.each([
    ["workproduct_selector_stale_producer", "selector_or_contract_error"],
    ["429", "infra_quota_timeout"],
  ] as const)("falls back without convening for runtime/infra error %s", async (errorCode, category) => {
    const convene = forbiddenConvene();

    const result = await maybeConveneQaFailureHuddle(hookInput({ errorCode }), { db, convene });

    expect(convene).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "fallback_standard_flow",
      skipUnblockIssue: false,
      eligibility: { eligible: false, category },
    });
  });

  it("falls back without convening when a huddle participant is missing", async () => {
    const convene = forbiddenConvene();

    const result = await maybeConveneQaFailureHuddle(hookInput({ validatorAgentId: null }), { db, convene });

    expect(convene).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: "fallback_standard_flow",
      reason: "missing_huddle_participants",
      skipUnblockIssue: false,
      eligibility: { eligible: true, category: "qa_content_rejection" },
    });
  });

  it("falls back if the injected convene service declines the huddle", async () => {
    const eligibility = {
      eligible: false as const,
      category: "unknown_non_collaborative" as const,
      recommendedRoute: "operator_escalation" as const,
      reason: "service_declined",
    };
    const convene = vi.fn(async (_db: Db, _input: ConveneExceptionHuddleInput) => ({
      convened: false as const,
      eligibility,
    }));

    const result = await maybeConveneQaFailureHuddle(hookInput(), { db, convene });

    expect(convene).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ action: "fallback_standard_flow", eligibility, skipUnblockIssue: false });
  });
});
