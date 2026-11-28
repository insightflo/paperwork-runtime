import { api } from "./client";
import type { CollabMessage, CollabThread } from "./collabChannels";
import type {
  ExceptionHuddleDecision,
  ExceptionHuddleMetadata,
  ExceptionHuddleRole,
} from "@paperclipai/shared/validators/exception-huddle";

export type {
  ExceptionHuddleDecision,
  ExceptionHuddleDecisionKind,
  ExceptionHuddleMetadata,
  ExceptionHuddleRole,
  ExceptionHuddleStatus,
} from "@paperclipai/shared/validators/exception-huddle";

export type ExceptionHuddleDecisionInput = Omit<ExceptionHuddleDecision, "forcedByChair"> & {
  forcedByChair?: boolean;
};

export type ExceptionHuddleRecord = ExceptionHuddleMetadata & {
  roundTurns: Record<"1" | "2", ExceptionHuddleRole[]>;
  failureSummary: string;
};

export type ExceptionHuddleEligibility =
  | {
      eligible: true;
      category: "qa_content_rejection" | "spec_interpretation_conflict" | "external_source_gap";
      reason: string;
    }
  | {
      eligible: false;
      category:
        | "runtime_tool_error"
        | "infra_quota_timeout"
        | "auth_permission_error"
        | "selector_or_contract_error"
        | "unknown_non_collaborative";
      recommendedRoute: "backoff_retry" | "operator_escalation";
      reason: string;
    };

export interface ConveneExceptionHuddleInput {
  missionId: string;
  workflowRunId: string;
  sourceStepId: string;
  sourceIssueId?: string | null;
  ownerAgentId: string;
  producerAgentId: string;
  validatorAgentId: string;
  workProductLinks: string[];
  failureSummary: string;
  errorCode?: string | null;
  errorSummary?: string | null;
  verdict?: string | null;
  stepRole?: string | null;
  failureKind?: string | null;
  qaFailureCount?: number | null;
}

export type ConveneExceptionHuddleResponse =
  | { convened: false; eligibility: ExceptionHuddleEligibility }
  | {
      convened: true;
      eligibility: ExceptionHuddleEligibility;
      channelId: string;
      threadId: string;
      huddle: ExceptionHuddleRecord;
    };

export interface ExceptionHuddleMessage extends CollabMessage {
  metadata: Record<string, unknown> | null;
}

export interface GetExceptionHuddleResponse {
  thread: CollabThread;
  huddle: ExceptionHuddleRecord;
  messages: ExceptionHuddleMessage[];
}

export interface PostExceptionHuddleTurnInput {
  actorAgentId: string;
  body: string;
}

export interface PostExceptionHuddleTurnResponse {
  threadId: string;
  huddle: ExceptionHuddleRecord;
  message: CollabMessage;
}

export interface DecideExceptionHuddleInput {
  actorAgentId: string;
  decision: ExceptionHuddleDecisionInput;
}

export interface DecideExceptionHuddleResponse {
  threadId: string;
  huddle: ExceptionHuddleRecord;
  nextAction: ExceptionHuddleDecisionInput["kind"];
}

const huddleBase = (companyId: string, threadId?: string) =>
  `/companies/${encodeURIComponent(companyId)}/collab-channels/huddles${threadId ? `/${encodeURIComponent(threadId)}` : ""}`;

export function getExceptionHuddle(companyId: string, threadId: string) {
  return api.get<GetExceptionHuddleResponse>(huddleBase(companyId, threadId));
}

export function conveneExceptionHuddle(companyId: string, body: ConveneExceptionHuddleInput) {
  return api.post<ConveneExceptionHuddleResponse>(huddleBase(companyId), body);
}

export function postExceptionHuddleTurn(companyId: string, threadId: string, body: PostExceptionHuddleTurnInput) {
  return api.post<PostExceptionHuddleTurnResponse>(`${huddleBase(companyId, threadId)}/turns`, body);
}

export function decideExceptionHuddle(companyId: string, threadId: string, body: DecideExceptionHuddleInput) {
  return api.post<DecideExceptionHuddleResponse>(`${huddleBase(companyId, threadId)}/decide`, body);
}

export const exceptionHuddlesApi = {
  getExceptionHuddle,
  conveneExceptionHuddle,
  postExceptionHuddleTurn,
  decideExceptionHuddle,
};
