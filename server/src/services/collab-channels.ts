// [파일 목적] Stage 29 W2 — 스레드 협업 채널 서비스: 채널·스레드·메시지 영속화와
//   on-demand wakeup 큐(agent_wakeup_requests) 브리지. 순수 ChannelTask 상태머신의
//   결정론적 결과를 구조화된 DB 쓰기로 반영하며, 댓글·자연어를 실행 권한으로 읽지 않는다.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { agents, agentWakeupRequests, collabChannels, collabMessages, collabThreads, type Db } from "@paperclipai/db";
import { HttpError, notFound } from "../errors.js";
import {
  evaluateChannelAction,
  resolveDeterministicTargets,
  type ChannelActionKind,
  type ChannelAuthorType,
  type ChannelRoutingMember,
  type ChannelThreadStatus,
} from "./collab-channel-state.js";
import { dispatchChannelMessageToEndpoint, dispatchChannelMessageToEndpointDb } from "./endpoint-channel-dispatch.js";
import { globalEndpointBotPairingStore, type EndpointBotPairingService } from "./endpoint-bot-pairing.js";

export type CollabThreadAuthorType = Exclude<ChannelAuthorType, "system">;

export interface CollabCreateChannelInput {
  name: string;
  description?: string;
  memberAgentIds: string[];
  leadAgentId?: string | null;
  createdByUserId?: string | null;
}

export interface CollabCreateThreadInput {
  title: string;
  body: string;
  authorType: CollabThreadAuthorType;
  authorId?: string | null;
  targetAgentId?: string | null;
}

export interface CollabPostMessageInput {
  body: string;
  authorType: ChannelAuthorType;
  authorId?: string | null;
  actionKind?: ChannelActionKind;
  targetAgentId?: string | null;
  hasOpenSubtasks?: boolean;
  triggeredByChannelReply?: boolean;
}

/** 상태머신 거부를 타입화된 409/422 로 변환한다. code 로 UI·에이전트가 원인을 구분한다. */
export class ChannelActionError extends HttpError {
  readonly code: string;
  constructor(status: 409 | 422, code: string, message: string) {
    super(status, message, { code });
    this.code = code;
  }
}

const WAKEUP_SOURCE = "on_demand";
const WAKEUP_TRIGGER = "collab_channel";
const WAKEUP_REASON = "collab_thread_message";
const RESUME_SYSTEM_NOTE = "Human operator approved resuming this thread.";

function rejectionToError(code: string, message: string): ChannelActionError {
  return new ChannelActionError(code === "target_agent_required" ? 422 : 409, code, message);
}

function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "channel" : slug;
}

function requestedByActorType(authorType: ChannelAuthorType): "user" | "agent" {
  return authorType === "user" ? "user" : "agent";
}

/** 명시적 endpointStore는 테스트 격리용이며, 운영 기본 경로는 DB의 페어링·작업 상태를 사용한다. */
export function collabChannelsService(
  db: Db,
  endpointStore?: Pick<EndpointBotPairingService, "listEndpoints" | "enqueueLocalTask">,
) {
  async function loadChannel(companyId: string, channelId: string) {
    const [channel] = await db.select().from(collabChannels).where(and(
      eq(collabChannels.id, channelId), eq(collabChannels.companyId, companyId), isNull(collabChannels.archivedAt),
    )).limit(1);
    return channel ?? null;
  }

  async function loadMembers(companyId: string, memberAgentIds: string[]): Promise<ChannelRoutingMember[]> {
    if (memberAgentIds.length === 0) return [];
    return db.select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, memberAgentIds)));
  }

  /** [wakeup 큐 브리지] on-demand 비동기 우편함 행을 적는다. 상태 기본 queued 로 heartbeat 가
   *  소비하며, requestedByActorType:"user" 행은 기존 user-first 선매(preemption)를 그대로 누린다. */
  async function enqueueChannelWakeup(input: {
    companyId: string; agentId: string; requestedByActorType: "user" | "agent"; requestedByActorId: string | null;
    channelId: string; threadId: string; messageId: string; actionKind: ChannelActionKind;
  }) {
    await db.insert(agentWakeupRequests).values({
      companyId: input.companyId, agentId: input.agentId,
      source: WAKEUP_SOURCE, triggerDetail: WAKEUP_TRIGGER, reason: WAKEUP_REASON,
      requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
      payload: {
        channelId: input.channelId, threadId: input.threadId,
        messageId: input.messageId, actionKind: input.actionKind,
      },
    });
  }

  async function listChannels(companyId: string) {
    return db.select().from(collabChannels)
      .where(and(eq(collabChannels.companyId, companyId), isNull(collabChannels.archivedAt)))
      .orderBy(desc(collabChannels.updatedAt));
  }

  async function createChannel(companyId: string, input: CollabCreateChannelInput) {
    const base = slugify(input.name);
    const existing = await db.select({ slug: collabChannels.slug }).from(collabChannels)
      .where(eq(collabChannels.companyId, companyId));
    const taken = new Set(existing.map((row) => row.slug));
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    const [channel] = await db.insert(collabChannels).values({
      companyId, slug, name: input.name, description: input.description ?? null,
      memberAgentIds: input.memberAgentIds, leadAgentId: input.leadAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
    }).returning();
    return channel;
  }

  async function listThreads(companyId: string, channelId: string) {
    return db.select().from(collabThreads)
      .where(and(eq(collabThreads.companyId, companyId), eq(collabThreads.channelId, channelId)))
      .orderBy(desc(collabThreads.updatedAt));
  }

  async function createThread(companyId: string, channelId: string, input: CollabCreateThreadInput) {
    const channel = await loadChannel(companyId, channelId);
    if (!channel) throw notFound("Channel not found");
    const [thread] = await db.insert(collabThreads).values({
      companyId, channelId, title: input.title, status: "open",
      createdByActorType: input.authorType, createdByActorId: input.authorId ?? null,
    }).returning();
    const [message] = await db.insert(collabMessages).values({
      companyId, channelId, threadId: thread.id, authorType: input.authorType,
      authorId: input.authorId ?? null, actionKind: "message", body: input.body, expectsReply: true,
    }).returning();
    const members = await loadMembers(companyId, channel.memberAgentIds);
    const targets = resolveDeterministicTargets({
      body: input.body, members, leadAgentId: channel.leadAgentId,
      explicitTargetAgentId: input.targetAgentId ?? null,
    });
    for (const agentId of targets.targetAgentIds) {
      await enqueueChannelWakeup({
        companyId, agentId, requestedByActorType: requestedByActorType(input.authorType),
        requestedByActorId: input.authorId ?? null, channelId, threadId: thread.id,
        messageId: message.id, actionKind: "message",
      });
    }
    return thread;
  }

  async function listMessages(companyId: string, channelId: string, threadId: string) {
    return db.select().from(collabMessages).where(and(
      eq(collabMessages.companyId, companyId),
      eq(collabMessages.channelId, channelId),
      eq(collabMessages.threadId, threadId),
    )).orderBy(asc(collabMessages.createdAt));
  }

  async function postMessage(companyId: string, channelId: string, threadId: string, input: CollabPostMessageInput) {
    const [thread] = await db.select().from(collabThreads).where(and(
      eq(collabThreads.id, threadId),
      eq(collabThreads.companyId, companyId),
      eq(collabThreads.channelId, channelId),
    )).limit(1);
    if (!thread) throw notFound("Thread not found");
    const channel = await loadChannel(companyId, channelId);
    if (!channel) throw notFound("Channel not found");
    const actionKind = input.actionKind ?? "message";
    const evaluation = evaluateChannelAction({
      threadStatus: thread.status as ChannelThreadStatus,
      assignmentCount: thread.assignmentCount,
      replyCount: thread.replyCount,
      actionKind,
      authorType: input.authorType,
      targetAgentId: input.targetAgentId ?? null,
      hasOpenSubtasks: input.hasOpenSubtasks,
      triggeredByChannelReply: input.triggeredByChannelReply,
    });
    if (!evaluation.ok) throw rejectionToError(evaluation.code, evaluation.message);

    const [message] = await db.insert(collabMessages).values({
      companyId, channelId, threadId: thread.id, authorType: input.authorType, authorId: input.authorId ?? null,
      actionKind, targetAgentId: input.targetAgentId ?? null, body: input.body, expectsReply: evaluation.expectsReply,
    }).returning();
    await db.update(collabThreads).set({
      status: evaluation.nextStatus,
      assignmentCount: evaluation.nextAssignmentCount,
      replyCount: evaluation.nextReplyCount,
      // 상태머신이 소유자를 내려주지 않으면(undefined) 기존 소유자를 유지한다.
      ownerAgentId: evaluation.nextOwnerAgentId ?? thread.ownerAgentId,
      updatedAt: new Date(),
    }).where(eq(collabThreads.id, thread.id));

    // [wakeup 조건] paused 전이가 아니면서 (사람 message/steer 또는 assign/transfer) 일 때만 깨운다.
    if (!evaluation.pausedForApproval) {
      const wakeable = actionKind === "channel_assign" || actionKind === "channel_transfer"
        || (input.authorType === "user" && (actionKind === "message" || actionKind === "user_steer"));
      if (wakeable) {
        const members = await loadMembers(companyId, channel.memberAgentIds);
        const targets = resolveDeterministicTargets({
          body: input.body, members, leadAgentId: channel.leadAgentId,
          explicitTargetAgentId: input.targetAgentId ?? null,
        });
        for (const agentId of targets.targetAgentIds) {
          await enqueueChannelWakeup({
            companyId, agentId, requestedByActorType: requestedByActorType(input.authorType),
            requestedByActorId: input.authorId ?? null, channelId, threadId: thread.id,
            messageId: message.id, actionKind,
          });
        }
      }
    }

    // [endpoint 브리지] 발화가 `@<botName> list|read|run` 단일행 명령이면 페어링된 개인 엔드포인트 봇에
    //   폴더 스코프 로컬 작업을 큐잉하고, 결과 설명을 같은 스레드의 시스템 답글로 남긴다.
    //   matched:false 는 기존 동작과 100% 동일하며, 에이전트 @mention wakeup 흐름을 건드리지 않는다.
    //   시스템 답글은 직접 insert 되므로 상태머신 카운터나 재디스패치를 유발하지 않는다.
    const endpointDispatch = endpointStore !== undefined || !db
      ? dispatchChannelMessageToEndpoint({
        companyId, messageText: input.body, store: endpointStore ?? globalEndpointBotPairingStore,
      })
      : await dispatchChannelMessageToEndpointDb(db, { companyId, messageText: input.body });
    if (endpointDispatch.matched) {
      await db.insert(collabMessages).values({
        companyId, channelId, threadId: thread.id, authorType: "system",
        actionKind: "message", body: endpointDispatch.replyText, expectsReply: false,
      });
    }
    return message;
  }

  async function resumeThread(companyId: string, channelId: string, threadId: string, actorUserId: string | null) {
    const [thread] = await db.select().from(collabThreads).where(and(
      eq(collabThreads.id, threadId),
      eq(collabThreads.companyId, companyId),
      eq(collabThreads.channelId, channelId),
    )).limit(1);
    if (!thread) throw notFound("Thread not found");
    if (thread.status !== "paused") {
      throw new ChannelActionError(409, "thread_not_paused", "Thread is not paused; nothing to resume.");
    }
    const channel = await loadChannel(companyId, channelId);
    if (!channel) throw notFound("Channel not found");
    const [updated] = await db.update(collabThreads).set({
      status: "open", assignmentCount: 0, updatedAt: new Date(),
    }).where(eq(collabThreads.id, thread.id)).returning();
    const [note] = await db.insert(collabMessages).values({
      companyId, channelId, threadId: thread.id, authorType: "system",
      actionKind: "message", body: RESUME_SYSTEM_NOTE, expectsReply: true,
    }).returning();
    const wakeAgentId = thread.ownerAgentId ?? channel.leadAgentId;
    if (wakeAgentId) {
      await enqueueChannelWakeup({
        companyId, agentId: wakeAgentId, requestedByActorType: "user", requestedByActorId: actorUserId,
        channelId, threadId: thread.id, messageId: note.id, actionKind: "message",
      });
    }
    return updated;
  }

  return {
    listChannels, createChannel, listThreads, createThread,
    listMessages, postMessage, resumeThread,
  };
}
