import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

type FolderGrant = { path: string; mode: "ro" | "rw" };
type DetectedCli = string | { id: string; binary: string; path: string | null; available: boolean };
const companyId = () => uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const personalEndpointPairingCodes = pgTable("personal_endpoint_pairing_codes", {
  code: text("code").primaryKey(),
  companyId: companyId(),
  botName: text("bot_name").notNull(),
  requestedFoldersJson: jsonb("requested_folders_json").$type<FolderGrant[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, t => ({ companyExpiryIdx: index("personal_endpoint_pairing_company_expiry_idx").on(t.companyId, t.expiresAt) }));

export const personalEndpointBots = pgTable("personal_endpoint_bots", {
  deviceId: uuid("device_id").primaryKey().defaultRandom(),
  companyId: companyId(),
  botName: text("bot_name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPreview: text("token_preview").notNull(),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  detectedClisJson: jsonb("detected_clis_json").$type<DetectedCli[]>().notNull().default([]),
  allowedFoldersJson: jsonb("allowed_folders_json").$type<FolderGrant[]>().notNull().default([]),
  pendingOutboxCount: integer("pending_outbox_count").notNull().default(0),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, t => ({
  companyDeviceIdx: uniqueIndex("personal_endpoint_bots_company_device_idx").on(t.companyId, t.deviceId),
  tokenHashCheck: check("personal_endpoint_bots_token_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  outboxCheck: check("personal_endpoint_bots_outbox_check", sql`${t.pendingOutboxCount} >= 0`),
}));

export const personalEndpointTasks = pgTable("personal_endpoint_tasks", {
  taskId: uuid("task_id").primaryKey().defaultRandom(),
  companyId: companyId(),
  deviceId: uuid("device_id").notNull(),
  kind: text("kind").$type<"read_file" | "write_file" | "list_dir" | "shell_exec">().notNull(),
  targetPath: text("target_path").notNull(),
  command: text("command"),
  argsJson: jsonb("args_json").$type<string[]>(),
  status: text("status").$type<"pending" | "completed" | "failed">().notNull().default("pending"),
  ok: boolean("ok"),
  output: text("output"),
  error: text("error"),
  createdAt: createdAt(),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
}, t => ({
  deviceFk: foreignKey({ name: "personal_endpoint_tasks_device_fk", columns: [t.companyId, t.deviceId],
    foreignColumns: [personalEndpointBots.companyId, personalEndpointBots.deviceId] }).onDelete("cascade"),
  pendingIdx: index("personal_endpoint_tasks_pending_idx").on(t.companyId, t.deviceId, t.status, t.createdAt, t.taskId),
  kindCheck: check("personal_endpoint_tasks_kind_check", sql`${t.kind} IN ('read_file', 'write_file', 'list_dir', 'shell_exec')`),
  statusCheck: check("personal_endpoint_tasks_status_check", sql`${t.status} IN ('pending', 'completed', 'failed')`),
}));
