import {
  check,
  index,
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
 * Workspace primitives (Stage 35 W3): durable Postgres backing for agent shared
 * tables and pending agent open waits. Display/reference state only — never
 * read back as execution authority. Mirrors 0142_workspace_primitives.sql.
 */

export type SharedTableRowPayload = {
  values: Record<string, unknown>;
  updatedByAgentId: string | null;
  updatedAt: string;
};

export const agentSharedTables = pgTable(
  "agent_shared_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    columnsJson: jsonb("columns_json").$type<unknown[]>().notNull().default([]),
    rowsJson: jsonb("rows_json").$type<Record<string, SharedTableRowPayload>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUniqueIdx: uniqueIndex("agent_shared_tables_company_name_unique_idx").on(
      table.companyId,
      table.name,
    ),
  }),
);

export const agentOpenWaits = pgTable(
  "agent_open_waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary").notNull().default(""),
    targetLabel: text("target_label"),
    status: text("status").notNull().default("waiting"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusCreatedIdx: index("agent_open_waits_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyAgentIdx: index("agent_open_waits_company_agent_idx").on(table.companyId, table.agentId),
    statusCheck: check(
      "agent_open_waits_status_check",
      sql`${table.status} in ('waiting', 'resolved')`,
    ),
  }),
);
