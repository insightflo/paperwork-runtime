import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Threaded collaboration channels (Stage 29): channels group agents for a company,
 * threads carry one ChannelTask with a deterministic open/waiting/paused/resolved
 * lifecycle, and messages are the append-only transcript (never execution authority).
 */
export const collabChannels = pgTable(
  "collab_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    memberAgentIds: jsonb("member_agent_ids").$type<string[]>().notNull().default([]),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUniqueIdx: uniqueIndex("collab_channels_company_slug_unique_idx").on(
      table.companyId,
      table.slug,
    ),
  }),
);

export const collabThreads = pgTable(
  "collab_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => collabChannels.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    rootIssueId: uuid("root_issue_id"),
    assignmentCount: integer("assignment_count").notNull().default(0),
    replyCount: integer("reply_count").notNull().default(0),
    createdByActorType: text("created_by_actor_type").notNull().default("user"),
    createdByActorId: text("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyChannelUpdatedIdx: index("collab_threads_company_channel_updated_idx").on(
      table.companyId,
      table.channelId,
      table.updatedAt,
    ),
    statusCheck: check(
      "collab_threads_status_check",
      sql`${table.status} in ('open', 'waiting', 'paused', 'resolved')`,
    ),
    createdByActorTypeCheck: check(
      "collab_threads_created_by_actor_type_check",
      sql`${table.createdByActorType} in ('user', 'agent')`,
    ),
  }),
);

export const collabMessages = pgTable(
  "collab_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => collabChannels.id, {
      onDelete: "cascade",
    }),
    threadId: uuid("thread_id").notNull().references(() => collabThreads.id, {
      onDelete: "cascade",
    }),
    parentMessageId: uuid("parent_message_id"),
    authorType: text("author_type").notNull(),
    authorId: text("author_id"),
    actionKind: text("action_kind").notNull().default("message"),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    expectsReply: boolean("expects_reply").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadCreatedIdx: index("collab_messages_company_thread_created_idx").on(
      table.companyId,
      table.threadId,
      table.createdAt,
    ),
    authorTypeCheck: check(
      "collab_messages_author_type_check",
      sql`${table.authorType} in ('user', 'agent', 'system')`,
    ),
    actionKindCheck: check(
      "collab_messages_action_kind_check",
      sql`${table.actionKind} in ('message', 'channel_assign', 'channel_transfer', 'channel_reply', 'channel_result', 'user_steer')`,
    ),
  }),
);
