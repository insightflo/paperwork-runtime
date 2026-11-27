import { describe, expect, it } from "vitest";
import {
  CHANNEL_ASSIGNMENT_LIMIT,
  CHANNEL_REPLY_LIMIT,
  CHANNEL_REPLY_MAX_CHARS,
  evaluateChannelAction,
  resolveDeterministicTargets,
} from "../services/collab-channel-state.ts";

const m = (id: string, name: string, slug?: string | null) => ({ id, name, slug });
const rejectShape = (code: string) => ({ ok: false, code, message: expect.any(String) });

describe("resolveDeterministicTargets", () => {
  it("returns the explicit target when it is a channel member", () => {
    const result = resolveDeterministicTargets({
      body: "please start",
      members: [m("a1", "Alpha", "alpha"), m("a2", "Beta", "beta")],
      leadAgentId: "a2",
      explicitTargetAgentId: "a1",
    });
    expect(result).toEqual({ targetAgentIds: ["a1"], reason: "explicit" });
  });

  it("ignores a non-member explicit target and falls through to mention routing", () => {
    const result = resolveDeterministicTargets({
      body: "@beta please look",
      members: [m("a1", "Alpha", "alpha"), m("a2", "Beta", "beta")],
      explicitTargetAgentId: "outsider",
    });
    expect(result).toEqual({ targetAgentIds: ["a2"], reason: "mention" });
  });

  it("routes @slug mentions case-insensitively", () => {
    const result = resolveDeterministicTargets({
      body: "@ALPHA please take this",
      members: [m("a1", "Alpha", "alpha"), m("a2", "Beta", "beta")],
    });
    expect(result).toEqual({ targetAgentIds: ["a1"], reason: "mention" });
  });

  it("matches names with spaces normalized to dashes and stripped", () => {
    const dashed = resolveDeterministicTargets({ body: "@codex-coder run the checks", members: [m("a1", "Codex Coder")] });
    const stripped = resolveDeterministicTargets({ body: "cc @codexcoder", members: [m("a2", "Codex Coder")] });
    expect(dashed).toEqual({ targetAgentIds: ["a1"], reason: "mention" });
    expect(stripped).toEqual({ targetAgentIds: ["a2"], reason: "mention" });
  });

  it("deduplicates mentions and lists targets in member roster order", () => {
    const result = resolveDeterministicTargets({
      body: "@beta and @alpha, please pair on this @beta",
      members: [m("a1", "Alpha", "alpha"), m("a2", "Beta", "beta")],
    });
    expect(result).toEqual({ targetAgentIds: ["a1", "a2"], reason: "mention" });
  });

  it("falls back to the only member even when the mention matches nobody", () => {
    expect(resolveDeterministicTargets({ body: "@ghost anyone?", members: [m("a1", "Alpha", "alpha")] }))
      .toEqual({ targetAgentIds: ["a1"], reason: "single_member" });
  });

  it("falls back to the lead agent when present among members", () => {
    expect(
      resolveDeterministicTargets({ body: "no mention here", members: [m("a1", "Alpha"), m("a2", "Beta")], leadAgentId: "a2" }),
    ).toEqual({ targetAgentIds: ["a2"], reason: "lead_fallback" });
  });

  it("returns ambiguous when there is no lead and no way to choose", () => {
    expect(resolveDeterministicTargets({ body: "no mention here", members: [m("a1", "Alpha"), m("a2", "Beta")] }))
      .toEqual({ targetAgentIds: [], reason: "ambiguous" });
  });
});

describe("evaluateChannelAction - guard rejections", () => {
  it("rejects agent messages on a paused thread", () => {
    expect(
      evaluateChannelAction({ threadStatus: "paused", assignmentCount: 1, replyCount: 0, actionKind: "message", authorType: "agent" }),
    ).toEqual(rejectShape("thread_paused_for_approval"));
  });

  it("rejects channel actions triggered by a channel reply", () => {
    for (const actionKind of ["channel_assign", "channel_transfer", "channel_reply"] as const) {
      expect(
        evaluateChannelAction({ threadStatus: "open", assignmentCount: 0, replyCount: 0, actionKind, authorType: "agent", triggeredByChannelReply: true }),
      ).toEqual(rejectShape("nested_channel_reply_forbidden"));
    }
  });

  it("rejects channel_assign and channel_transfer without a target agent", () => {
    for (const actionKind of ["channel_assign", "channel_transfer"] as const) {
      expect(
        evaluateChannelAction({ threadStatus: "open", assignmentCount: 0, replyCount: 0, actionKind, authorType: "user", targetAgentId: null }),
      ).toEqual(rejectShape("target_agent_required"));
    }
  });

  it("rejects channel_reply beyond the reply limit", () => {
    expect(
      evaluateChannelAction({ threadStatus: "waiting", assignmentCount: 1, replyCount: CHANNEL_REPLY_LIMIT, actionKind: "channel_reply", authorType: "agent" }),
    ).toEqual(rejectShape("channel_reply_limit_exceeded"));
  });

  it("rejects channel_result while subtasks remain open", () => {
    expect(
      evaluateChannelAction({ threadStatus: "waiting", assignmentCount: 1, replyCount: 0, actionKind: "channel_result", authorType: "agent", hasOpenSubtasks: true }),
    ).toEqual(rejectShape("open_subtasks_remaining"));
  });
});

describe("evaluateChannelAction - transitions", () => {
  it("moves an open thread to waiting and records the owner on channel_assign", () => {
    expect(
      evaluateChannelAction({ threadStatus: "open", assignmentCount: 0, replyCount: 0, actionKind: "channel_assign", authorType: "user", targetAgentId: "a1" }),
    ).toEqual({ ok: true, nextStatus: "waiting", nextAssignmentCount: 1, nextReplyCount: 0, nextOwnerAgentId: "a1", expectsReply: false, pausedForApproval: false });
  });

  it("keeps an open thread open and moves the owner on channel_transfer", () => {
    expect(
      evaluateChannelAction({ threadStatus: "open", assignmentCount: 2, replyCount: 0, actionKind: "channel_transfer", authorType: "user", targetAgentId: "a2" }),
    ).toEqual({ ok: true, nextStatus: "open", nextAssignmentCount: 3, nextReplyCount: 0, nextOwnerAgentId: "a2", expectsReply: false, pausedForApproval: false });
  });

  it("pauses for approval exactly at the assignment limit without changing the owner", () => {
    const atCap = evaluateChannelAction({
      threadStatus: "waiting", assignmentCount: CHANNEL_ASSIGNMENT_LIMIT - 1, replyCount: 0, actionKind: "channel_assign", authorType: "user", targetAgentId: "a1",
    });
    expect(atCap).toEqual({ ok: true, nextStatus: "paused", nextAssignmentCount: CHANNEL_ASSIGNMENT_LIMIT, nextReplyCount: 0, expectsReply: false, pausedForApproval: true });

    const underCap = evaluateChannelAction({
      threadStatus: "open", assignmentCount: CHANNEL_ASSIGNMENT_LIMIT - 2, replyCount: 0, actionKind: "channel_assign", authorType: "user", targetAgentId: "a1",
    });
    expect(underCap).toEqual({ ok: true, nextStatus: "waiting", nextAssignmentCount: CHANNEL_ASSIGNMENT_LIMIT - 1, nextReplyCount: 0, nextOwnerAgentId: "a1", expectsReply: false, pausedForApproval: false });
  });

  it("increments the reply counter while under the reply limit", () => {
    expect(
      evaluateChannelAction({ threadStatus: "waiting", assignmentCount: 1, replyCount: 1, actionKind: "channel_reply", authorType: "agent" }),
    ).toEqual({ ok: true, nextStatus: "waiting", nextAssignmentCount: 1, nextReplyCount: 2, expectsReply: false, pausedForApproval: false });
  });

  it("resolves a thread with channel_result when no subtasks are open", () => {
    expect(
      evaluateChannelAction({ threadStatus: "waiting", assignmentCount: 1, replyCount: 0, actionKind: "channel_result", authorType: "agent", hasOpenSubtasks: false }),
    ).toEqual({ ok: true, nextStatus: "resolved", nextAssignmentCount: 1, nextReplyCount: 0, expectsReply: false, pausedForApproval: false });
  });

  it("reopens a paused thread when a human steers it", () => {
    const steer = evaluateChannelAction({
      threadStatus: "paused", assignmentCount: CHANNEL_ASSIGNMENT_LIMIT, replyCount: 0, actionKind: "user_steer", authorType: "user",
    });
    expect(steer).toEqual({ ok: true, nextStatus: "open", nextAssignmentCount: CHANNEL_ASSIGNMENT_LIMIT, nextReplyCount: 0, expectsReply: true, pausedForApproval: false });

    const userMessage = evaluateChannelAction({
      threadStatus: "waiting", assignmentCount: 1, replyCount: 0, actionKind: "message", authorType: "user",
    });
    expect(userMessage).toEqual({ ok: true, nextStatus: "open", nextAssignmentCount: 1, nextReplyCount: 0, expectsReply: true, pausedForApproval: false });
  });

  it("keeps agent messages on an open thread unchanged", () => {
    expect(
      evaluateChannelAction({ threadStatus: "open", assignmentCount: 1, replyCount: 0, actionKind: "message", authorType: "agent" }),
    ).toEqual({ ok: true, nextStatus: "open", nextAssignmentCount: 1, nextReplyCount: 0, expectsReply: false, pausedForApproval: false });
  });
});

describe("channel constants", () => {
  it("exposes the documented limits", () => {
    expect(CHANNEL_ASSIGNMENT_LIMIT).toBe(8);
    expect(CHANNEL_REPLY_LIMIT).toBe(2);
    expect(CHANNEL_REPLY_MAX_CHARS).toBe(2000);
  });
});
