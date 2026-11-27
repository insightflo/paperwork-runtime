// Pure deterministic ChannelTask state machine for threaded collaboration channels.
// Execution authority: callers persist the returned next-state through structured DB writes;
// this module never reads comments, prose, or natural language as authority.

export const CHANNEL_ASSIGNMENT_LIMIT = 8;
export const CHANNEL_REPLY_LIMIT = 2;
export const CHANNEL_REPLY_MAX_CHARS = 2000;

export type ChannelThreadStatus = "open" | "waiting" | "paused" | "resolved";
export type ChannelActionKind =
  | "message"
  | "channel_assign"
  | "channel_transfer"
  | "channel_reply"
  | "channel_result"
  | "user_steer";
export type ChannelAuthorType = "user" | "agent" | "system";

export interface ChannelRoutingMember {
  id: string;
  name: string;
  slug?: string | null;
}

export interface ResolveDeterministicTargetsInput {
  body: string;
  members: ReadonlyArray<ChannelRoutingMember>;
  leadAgentId?: string | null;
  explicitTargetAgentId?: string | null;
}

export type ResolveDeterministicTargetsReason =
  | "explicit"
  | "mention"
  | "single_member"
  | "lead_fallback"
  | "ambiguous";

export interface ResolveDeterministicTargetsResult {
  targetAgentIds: string[];
  reason: ResolveDeterministicTargetsReason;
}

export interface EvaluateChannelActionInput {
  threadStatus: ChannelThreadStatus;
  assignmentCount: number;
  replyCount: number;
  actionKind: ChannelActionKind;
  authorType: ChannelAuthorType;
  targetAgentId?: string | null;
  hasOpenSubtasks?: boolean;
  triggeredByChannelReply?: boolean;
}

export type ChannelActionEvaluation =
  | {
      ok: true;
      nextStatus: ChannelThreadStatus;
      nextAssignmentCount: number;
      nextReplyCount: number;
      nextOwnerAgentId?: string | null;
      expectsReply: boolean;
      pausedForApproval: boolean;
    }
  | { ok: false; code: string; message: string };

function mentionTokens(body: string): string[] {
  const rawTokens = body.match(/@[A-Za-z0-9._-]+/g) ?? [];
  return rawTokens.map((token) => token.slice(1).toLowerCase());
}

function memberRoutingKeys(member: ChannelRoutingMember): string[] {
  const keys = new Set<string>();
  if (member.slug) keys.add(member.slug.toLowerCase());
  const name = member.name.toLowerCase();
  keys.add(name.replace(/\s+/g, "-"));
  keys.add(name.replace(/\s+/g, ""));
  return [...keys];
}

export function resolveDeterministicTargets(
  input: ResolveDeterministicTargetsInput,
): ResolveDeterministicTargetsResult {
  const { body, members, leadAgentId, explicitTargetAgentId } = input;

  if (explicitTargetAgentId && members.some((member) => member.id === explicitTargetAgentId)) {
    return { targetAgentIds: [explicitTargetAgentId], reason: "explicit" };
  }

  const tokens = mentionTokens(body);
  if (tokens.length > 0) {
    const matchedIds: string[] = [];
    for (const member of members) {
      const keys = memberRoutingKeys(member);
      const matched = tokens.some((token) => keys.includes(token));
      if (matched && !matchedIds.includes(member.id)) matchedIds.push(member.id);
    }
    if (matchedIds.length > 0) return { targetAgentIds: matchedIds, reason: "mention" };
  }

  if (members.length === 1) {
    return { targetAgentIds: [members[0].id], reason: "single_member" };
  }

  if (leadAgentId && members.some((member) => member.id === leadAgentId)) {
    return { targetAgentIds: [leadAgentId], reason: "lead_fallback" };
  }

  return { targetAgentIds: [], reason: "ambiguous" };
}

function evaluation(
  nextStatus: ChannelThreadStatus,
  nextAssignmentCount: number,
  nextReplyCount: number,
  nextOwnerAgentId: string | null | undefined,
  expectsReply: boolean,
  pausedForApproval: boolean,
): ChannelActionEvaluation {
  return {
    ok: true,
    nextStatus,
    nextAssignmentCount,
    nextReplyCount,
    ...(nextOwnerAgentId !== undefined && nextOwnerAgentId !== null
      ? { nextOwnerAgentId }
      : {}),
    expectsReply,
    pausedForApproval,
  };
}

function rejection(code: string, message: string): ChannelActionEvaluation {
  return { ok: false, code, message };
}

export function evaluateChannelAction(input: EvaluateChannelActionInput): ChannelActionEvaluation {
  const { threadStatus, assignmentCount, replyCount, actionKind, authorType } = input;

  // Human intervention reopens/steers a thread even when paused or waiting.
  if (actionKind === "user_steer" || (authorType === "user" && actionKind === "message")) {
    return evaluation("open", assignmentCount, replyCount, undefined, true, false);
  }

  if (authorType === "agent" && threadStatus === "paused") {
    return rejection(
      "thread_paused_for_approval",
      "Thread is paused pending operator approval; agent actions are rejected.",
    );
  }

  if (
    input.triggeredByChannelReply &&
    (actionKind === "channel_assign" || actionKind === "channel_transfer" || actionKind === "channel_reply")
  ) {
    return rejection(
      "nested_channel_reply_forbidden",
      "Channel-triggered actions must not start another channel reply cycle.",
    );
  }

  if (actionKind === "channel_assign" || actionKind === "channel_transfer") {
    const targetAgentId = input.targetAgentId ?? null;
    if (!targetAgentId) {
      return rejection("target_agent_required", `${actionKind} requires a targetAgentId.`);
    }
    const nextAssignmentCount = assignmentCount + 1;
    if (nextAssignmentCount >= CHANNEL_ASSIGNMENT_LIMIT) {
      return evaluation("paused", nextAssignmentCount, replyCount, undefined, false, true);
    }
    return evaluation(
      actionKind === "channel_assign" ? "waiting" : "open",
      nextAssignmentCount,
      replyCount,
      targetAgentId,
      false,
      false,
    );
  }

  if (actionKind === "channel_reply") {
    if (replyCount >= CHANNEL_REPLY_LIMIT) {
      return rejection(
        "channel_reply_limit_exceeded",
        `Thread already used ${replyCount} of ${CHANNEL_REPLY_LIMIT} channel replies.`,
      );
    }
    return evaluation(threadStatus, assignmentCount, replyCount + 1, undefined, false, false);
  }

  if (actionKind === "channel_result") {
    if (input.hasOpenSubtasks) {
      return rejection(
        "open_subtasks_remaining",
        "Cannot publish a channel result while subtasks remain open.",
      );
    }
    return evaluation("resolved", assignmentCount, replyCount, undefined, false, false);
  }

  // Plain agent/system message on an unpaused thread: state unchanged.
  return evaluation(threadStatus, assignmentCount, replyCount, undefined, false, false);
}
