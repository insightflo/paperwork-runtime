import { api } from "./client";

export type CollabThreadStatus = "open" | "waiting" | "paused" | "resolved";
export type CollabAuthorType = "user" | "agent" | "system";
export type CollabActorType = "user" | "agent";
export type CollabActionKind =
  | "message"
  | "channel_assign"
  | "channel_transfer"
  | "channel_reply"
  | "channel_result"
  | "user_steer";

export interface CollabChannel {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string | null;
  memberAgentIds: string[];
  leadAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollabThread {
  id: string;
  companyId: string;
  channelId: string;
  title: string;
  status: CollabThreadStatus;
  ownerAgentId: string | null;
  assignmentCount: number;
  replyCount: number;
  createdByActorType: CollabActorType;
  createdAt: string;
  updatedAt: string;
}

export interface CollabMessage {
  id: string;
  companyId: string;
  channelId: string;
  threadId: string;
  authorType: CollabAuthorType;
  authorId: string | null;
  actionKind: CollabActionKind;
  targetAgentId: string | null;
  body: string;
  expectsReply: boolean;
  createdAt: string;
}

export interface CollabCreateChannelInput {
  name: string;
  description?: string;
  memberAgentIds: string[];
  leadAgentId?: string | null;
}

export interface CollabCreateThreadInput {
  title: string;
  body: string;
  targetAgentId?: string | null;
}

export interface CollabPostMessageInput {
  body: string;
  actionKind?: "message" | "user_steer";
  targetAgentId?: string | null;
}

const channelBase = (companyId: string, channelId?: string) =>
  `/companies/${encodeURIComponent(companyId)}/collab-channels${channelId ? `/${encodeURIComponent(channelId)}` : ""}`;
const threadBase = (companyId: string, channelId: string, threadId?: string) =>
  `${channelBase(companyId, channelId)}/threads${threadId ? `/${encodeURIComponent(threadId)}` : ""}`;

export const collabChannelsApi = {
  listChannels: (companyId: string) => api.get<CollabChannel[]>(channelBase(companyId)),
  createChannel: (companyId: string, body: CollabCreateChannelInput) =>
    api.post<CollabChannel>(channelBase(companyId), body),
  listThreads: (companyId: string, channelId: string) => api.get<CollabThread[]>(threadBase(companyId, channelId)),
  createThread: (companyId: string, channelId: string, body: CollabCreateThreadInput) =>
    api.post<CollabThread>(threadBase(companyId, channelId), body),
  listMessages: (companyId: string, channelId: string, threadId: string) =>
    api.get<CollabMessage[]>(`${threadBase(companyId, channelId, threadId)}/messages`),
  postMessage: (companyId: string, channelId: string, threadId: string, body: CollabPostMessageInput) =>
    api.post<CollabMessage>(`${threadBase(companyId, channelId, threadId)}/messages`, body),
  resumeThread: (companyId: string, channelId: string, threadId: string) =>
    api.post<CollabThread>(`${threadBase(companyId, channelId, threadId)}/resume`, {}),
};
