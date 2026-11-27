// [파일 목적] Stage 29 W2 — collab-channels REST 라우트. ui/src/api/collabChannels.ts
//   계약과 1:1 로 대응하며 회사 경계(assertCompanyAccess)·zod 검증·변경 활동 기록을 적용한다.
//   실행 권한 판정은 서비스의 상태머신 결과에 위임한다(자연어 파싱 금지).
import { Router, type Request } from "express";
import { z } from "zod";
import { collabChannels, collabMessages, collabThreads, type Db } from "@paperclipai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";
import { collabChannelsService } from "../services/collab-channels.js";

type ChannelRow = typeof collabChannels.$inferSelect;
type ThreadRow = typeof collabThreads.$inferSelect;
type MessageRow = typeof collabMessages.$inferSelect;

const iso = (value: Date) => value.toISOString();

const serializeChannel = (row: ChannelRow) => ({
  id: row.id, companyId: row.companyId, slug: row.slug, name: row.name, description: row.description,
  memberAgentIds: row.memberAgentIds, leadAgentId: row.leadAgentId,
  createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
});

const serializeThread = (row: ThreadRow) => ({
  id: row.id, companyId: row.companyId, channelId: row.channelId, title: row.title, status: row.status,
  ownerAgentId: row.ownerAgentId, assignmentCount: row.assignmentCount, replyCount: row.replyCount,
  createdByActorType: row.createdByActorType, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
});

const serializeMessage = (row: MessageRow) => ({
  id: row.id, companyId: row.companyId, channelId: row.channelId, threadId: row.threadId,
  authorType: row.authorType, authorId: row.authorId, actionKind: row.actionKind, targetAgentId: row.targetAgentId,
  body: row.body, expectsReply: row.expectsReply, createdAt: iso(row.createdAt),
});

const createChannelSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  memberAgentIds: z.array(z.string().uuid()).min(1),
  leadAgentId: z.string().uuid().nullable().optional(),
});

const createThreadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  targetAgentId: z.string().uuid().nullable().optional(),
});

const postMessageSchema = z.object({
  body: z.string().min(1),
  actionKind: z.enum(["message", "user_steer"]).optional(),
  targetAgentId: z.string().uuid().nullable().optional(),
});

export function collabChannelsRoutes(db: Db) {
  const router = Router();
  const svc = collabChannelsService(db);

  /** [활동 기록] 변이 라우트 공통 — actor 정보를 구조화 활동 로그로 남긴다. */
  function logMutation(req: Request, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    return logActivity(db, {
      companyId: req.params.companyId as string,
      actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId,
      action, entityType, entityId, details,
    });
  }

  router.get("/companies/:companyId/collab-channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json((await svc.listChannels(companyId)).map(serializeChannel));
  });

  router.post("/companies/:companyId/collab-channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = createChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", details: parsed.error.errors });
      return;
    }
    const actor = getActorInfo(req);
    const channel = await svc.createChannel(companyId, {
      ...parsed.data,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logMutation(req, "collab.channel.created", "collab_channel", channel.id, { name: channel.name, slug: channel.slug });
    res.status(201).json(serializeChannel(channel));
  });

  router.get("/companies/:companyId/collab-channels/:channelId/threads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json((await svc.listThreads(companyId, req.params.channelId as string)).map(serializeThread));
  });

  router.post("/companies/:companyId/collab-channels/:channelId/threads", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    assertCompanyAccess(req, companyId);
    const parsed = createThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", details: parsed.error.errors });
      return;
    }
    const actor = getActorInfo(req);
    const thread = await svc.createThread(companyId, channelId, {
      ...parsed.data, authorType: actor.actorType, authorId: actor.actorId,
    });
    await logMutation(req, "collab.thread.created", "collab_thread", thread.id, { channelId, title: thread.title });
    res.status(201).json(serializeThread(thread));
  });

  router.get("/companies/:companyId/collab-channels/:channelId/threads/:threadId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const messages = await svc.listMessages(companyId, req.params.channelId as string, req.params.threadId as string);
    res.json(messages.map(serializeMessage));
  });

  router.post("/companies/:companyId/collab-channels/:channelId/threads/:threadId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    const threadId = req.params.threadId as string;
    assertCompanyAccess(req, companyId);
    const parsed = postMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", details: parsed.error.errors });
      return;
    }
    const actor = getActorInfo(req);
    const message = await svc.postMessage(companyId, channelId, threadId, {
      ...parsed.data, authorType: actor.actorType, authorId: actor.actorId,
    });
    await logMutation(req, "collab.message.posted", "collab_message", message.id, { channelId, threadId, actionKind: message.actionKind });
    res.status(201).json(serializeMessage(message));
  });

  router.post("/companies/:companyId/collab-channels/:channelId/threads/:threadId/resume", async (req, res) => {
    const companyId = req.params.companyId as string;
    const channelId = req.params.channelId as string;
    const threadId = req.params.threadId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const thread = await svc.resumeThread(companyId, channelId, threadId, actor.actorType === "user" ? actor.actorId : null);
    await logMutation(req, "collab.thread.resumed", "collab_thread", thread.id, { channelId });
    res.json(serializeThread(thread));
  });

  return router;
}
