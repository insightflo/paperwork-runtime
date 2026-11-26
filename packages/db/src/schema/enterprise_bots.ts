import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUniqueIdx: uniqueIndex("teams_company_slug_unique_idx").on(table.companyId, table.slug),
  }),
);

export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id"),
    teamId: uuid("team_id").references(() => teams.id),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    callableBy: text("callable_by").notNull().default("team"),
    status: text("status").notNull().default("active"),
    webhookUrl: text("webhook_url"),
    tokenSecretId: uuid("token_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    inboundTokenHash: text("inbound_token_hash"),
    lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
    lastPingStatus: text("last_ping_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("bots_company_status_idx").on(table.companyId, table.status),
    teamIdx: index("bots_team_idx").on(table.teamId),
    ownerUserIdx: index("bots_owner_user_idx").on(table.ownerUserId),
    kindCheck: check("bots_kind_check", sql`${table.kind} in ('personal', 'team', 'company')`),
    callableByCheck: check(
      "bots_callable_by_check",
      sql`${table.callableBy} in ('self_only', 'team', 'company')`,
    ),
    ownerOrTeamRequiredCheck: check(
      "bots_owner_or_team_required_check",
      sql`(${table.kind} = 'personal' and ${table.ownerUserId} is not null) or (${table.kind} = 'team' and ${table.teamId} is not null) or (${table.kind} = 'company')`,
    ),
    lastPingStatusCheck: check(
      "bots_last_ping_status_check",
      sql`${table.lastPingStatus} is null or ${table.lastPingStatus} in ('ok', 'error')`,
    ),
  }),
);

export const botCapabilities = pgTable(
  "bot_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
    capabilityKey: text("capability_key").notNull(),
    callableBy: text("callable_by").notNull(),
    dataScope: text("data_scope").notNull().default("self"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    botCapabilityUniqueIdx: uniqueIndex("bot_capabilities_bot_capability_unique_idx").on(
      table.botId,
      table.capabilityKey,
    ),
    callableByCheck: check(
      "bot_capabilities_callable_by_check",
      sql`${table.callableBy} in ('self_only', 'team', 'company')`,
    ),
    dataScopeCheck: check(
      "bot_capabilities_data_scope_check",
      sql`${table.dataScope} in ('self', 'team', 'company')`,
    ),
  }),
);

export const clientTerminals = pgTable(
  "client_terminals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id"),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull(),
    transport: text("transport").notNull().default("outbound_wss"),
    status: text("status").notNull().default("offline"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("client_terminals_company_status_idx").on(table.companyId, table.status),
    tokenHashIdx: index("client_terminals_token_hash_idx").on(table.tokenHash),
    botIdx: index("client_terminals_bot_idx").on(table.botId),
    kindCheck: check(
      "client_terminals_kind_check",
      sql`${table.kind} in ('personal_terminal', 'worker_node')`,
    ),
    transportCheck: check(
      "client_terminals_transport_check",
      sql`${table.transport} in ('outbound_wss', 'tailscale_direct')`,
    ),
    tokenHashHexCheck: check(
      "client_terminals_token_hash_hex_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindIdx: index("channels_company_kind_idx").on(table.companyId, table.kind),
    teamIdx: index("channels_team_idx").on(table.teamId),
    kindCheck: check("channels_kind_check", sql`${table.kind} in ('team', 'shared', 'dm')`),
  }),
);

export const channelMembers = pgTable(
  "channel_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    principalKind: text("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    role: text("role").notNull().default("member"),
    invitedByUserId: text("invited_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelPrincipalUniqueIdx: uniqueIndex("channel_members_channel_principal_unique_idx").on(
      table.channelId,
      table.principalKind,
      table.principalId,
    ),
    principalIdx: index("channel_members_principal_idx").on(table.principalKind, table.principalId),
    principalKindCheck: check(
      "channel_members_principal_kind_check",
      sql`${table.principalKind} in ('human', 'personal_bot', 'team_bot')`,
    ),
    roleCheck: check("channel_members_role_check", sql`${table.role} in ('owner', 'member')`),
  }),
);
