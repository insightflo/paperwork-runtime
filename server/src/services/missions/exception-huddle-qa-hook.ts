import type { Db } from "@paperclipai/db";
import {
  classifyExceptionHuddleEligibility,
  type ExceptionHuddleEligibility,
} from "./exception-huddle-classifier.js";
import {
  conveneExceptionHuddle,
  type ConveneExceptionHuddleInput,
} from "./exception-huddle-service.js";

export interface QaFailureHuddleInput {
  companyId: string;
  missionId: string;
  workflowRunId: string;
  sourceStepId: string;
  sourceIssueId?: string | null;
  ownerAgentId?: string | null;
  producerAgentId?: string | null;
  validatorAgentId?: string | null;
  verdict?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  failureKind?: string | null;
  qaFailureCount?: number | null;
  workProductLinks: string[];
  failureSummary: string;
}

type ConveneExceptionHuddleResult = Awaited<ReturnType<typeof conveneExceptionHuddle>>;
type ConvenedExceptionHuddleResult = Extract<ConveneExceptionHuddleResult, { convened: true }>;

export type QaFailureHuddleFallback = {
  action: "fallback_standard_flow";
  eligibility: ExceptionHuddleEligibility;
  reason?: "missing_huddle_participants";
  skipUnblockIssue: false;
};

export type QaFailureHuddleConvened = {
  action: "huddle_convened";
  skipUnblockIssue: true;
  channelId: ConvenedExceptionHuddleResult["channelId"];
  threadId: ConvenedExceptionHuddleResult["threadId"];
  huddle: ConvenedExceptionHuddleResult["huddle"];
  eligibility: ExceptionHuddleEligibility;
};

export type MaybeConveneQaFailureHuddleResult = QaFailureHuddleFallback | QaFailureHuddleConvened;

export interface ExceptionHuddleQaHookDeps {
  db: Db;
  convene?: typeof conveneExceptionHuddle;
}

type ParticipantCompleteInput = QaFailureHuddleInput & {
  ownerAgentId: string;
  producerAgentId: string;
  validatorAgentId: string;
};

function hasRequiredParticipants(input: QaFailureHuddleInput): input is ParticipantCompleteInput {
  return [input.ownerAgentId, input.producerAgentId, input.validatorAgentId]
    .every((agentId) => typeof agentId === "string" && agentId.trim().length > 0);
}

function toConveneInput(input: ParticipantCompleteInput): ConveneExceptionHuddleInput {
  return {
    companyId: input.companyId,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    sourceStepId: input.sourceStepId,
    sourceIssueId: input.sourceIssueId ?? null,
    ownerAgentId: input.ownerAgentId,
    producerAgentId: input.producerAgentId,
    validatorAgentId: input.validatorAgentId,
    verdict: input.verdict ?? null,
    errorCode: input.errorCode ?? null,
    errorSummary: input.errorSummary ?? null,
    failureKind: input.failureKind ?? null,
    qaFailureCount: input.qaFailureCount ?? null,
    workProductLinks: input.workProductLinks,
    failureSummary: input.failureSummary,
  };
}

function fallback(eligibility: ExceptionHuddleEligibility, reason?: "missing_huddle_participants"): QaFailureHuddleFallback {
  return { action: "fallback_standard_flow", eligibility, ...(reason ? { reason } : {}), skipUnblockIssue: false };
}

export async function maybeConveneQaFailureHuddle(
  input: QaFailureHuddleInput,
  deps: ExceptionHuddleQaHookDeps,
): Promise<MaybeConveneQaFailureHuddleResult> {
  const eligibility = classifyExceptionHuddleEligibility(input);
  if (!eligibility.eligible) return fallback(eligibility);
  if (!hasRequiredParticipants(input)) return fallback(eligibility, "missing_huddle_participants");

  const convene = deps.convene ?? conveneExceptionHuddle;
  const result = await convene(deps.db, toConveneInput(input));
  if (!result.convened) return fallback(result.eligibility);

  return {
    action: "huddle_convened",
    skipUnblockIssue: true,
    channelId: result.channelId,
    threadId: result.threadId,
    huddle: result.huddle,
    eligibility,
  };
}
