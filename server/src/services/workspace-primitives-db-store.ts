// server/src/services/workspace-primitives-db-store.ts
// [Stage 35 W3] agent_shared_tables · agent_open_waits 의 Postgres 영속 스토어.
// [boot-safety] 0142 마이그레이션이 아직 적용되지 않은 기존 A1 DB에서도
//   ensureWorkspacePrimitivesTables가 동일 DDL의 CREATE TABLE IF NOT EXISTS로
//   자가 부트스트랩한다(멱등, 재호출 안전).
// [scope] 모든 CRUD는 companyId로 엄격 스코프된다. 표시/참조용 상태이며
//   실행 권한 판정(retry/branch/completion/approval 등)의 근거로 읽지 않는다.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentOpenWaits,
  agentSharedTables,
  type SharedTableRowPayload,
} from "@paperclipai/db/schema/workspace_primitives";

export type SharedTableDbRow = typeof agentSharedTables.$inferSelect;
export type OpenWaitDbRow = typeof agentOpenWaits.$inferSelect;

export type CreateSharedTableInput = { name: string; columns: unknown[] };
export type UpsertSharedTableRowInput = {
  key: string;
  values: Record<string, unknown>;
  agentId?: string | null;
};
export type CreateOpenWaitInput = {
  agentId: string;
  kind: string;
  summary?: string;
  targetLabel?: string | null;
};
export type ListOpenWaitsOptions = { agentId?: string; status?: "waiting" | "resolved" };

// 0142_workspace_primitives.sql 과 동일한 문장 목록 (순서 포함).
const BOOTSTRAP_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "agent_shared_tables" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE, "name" text NOT NULL, "columns_json" jsonb DEFAULT '[]'::jsonb NOT NULL, "rows_json" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "agent_open_waits" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE, "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE, "kind" text NOT NULL, "summary" text DEFAULT '' NOT NULL, "target_label" text, "status" text DEFAULT 'waiting' NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "resolved_at" timestamp with time zone, CONSTRAINT "agent_open_waits_status_check" CHECK ("status" in ('waiting', 'resolved')))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "agent_shared_tables_company_name_unique_idx" ON "agent_shared_tables" ("company_id", "name")`,
  `CREATE INDEX IF NOT EXISTS "agent_open_waits_company_status_created_idx" ON "agent_open_waits" ("company_id", "status", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "agent_open_waits_company_agent_idx" ON "agent_open_waits" ("company_id", "agent_id")`,
];

/** 기존 DB 자가 부트스트랩: 두 테이블과 인덱스를 멱등 생성한다. */
export async function ensureWorkspacePrimitivesTables(db: Db): Promise<void> {
  for (const statement of BOOTSTRAP_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

async function requireSharedTable(db: Db, companyId: string, name: string): Promise<SharedTableDbRow> {
  const [row] = await db
    .select()
    .from(agentSharedTables)
    .where(and(eq(agentSharedTables.companyId, companyId), eq(agentSharedTables.name, name)))
    .limit(1);
  if (!row) throw new Error(`shared table not found: ${name} (company ${companyId})`);
  return row;
}

export async function listSharedTablesDb(db: Db, companyId: string): Promise<SharedTableDbRow[]> {
  requireNonEmpty(companyId, "companyId");
  return db
    .select()
    .from(agentSharedTables)
    .where(eq(agentSharedTables.companyId, companyId))
    .orderBy(agentSharedTables.name);
}

export async function createSharedTableDb(
  db: Db,
  companyId: string,
  input: CreateSharedTableInput,
): Promise<SharedTableDbRow> {
  requireNonEmpty(companyId, "companyId");
  const name = requireNonEmpty(input.name, "table name");
  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    throw new Error("columns must be a non-empty array");
  }
  const existing = await db
    .select({ id: agentSharedTables.id })
    .from(agentSharedTables)
    .where(and(eq(agentSharedTables.companyId, companyId), eq(agentSharedTables.name, name)))
    .limit(1);
  if (existing.length > 0) throw new Error(`shared table already exists: ${name} (company ${companyId})`);
  const [row] = await db
    .insert(agentSharedTables)
    .values({ companyId, name, columnsJson: input.columns })
    .returning();
  return row;
}

export async function upsertSharedTableRowDb(
  db: Db,
  companyId: string,
  tableName: string,
  input: UpsertSharedTableRowInput,
): Promise<SharedTableDbRow> {
  requireNonEmpty(companyId, "companyId");
  const table = await requireSharedTable(db, companyId, requireNonEmpty(tableName, "table name"));
  const key = requireNonEmpty(input.key, "row key");
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
    throw new Error("values must be a plain object");
  }
  const agentId = input.agentId == null ? null : requireNonEmpty(input.agentId, "agentId");
  const rows: Record<string, SharedTableRowPayload> = { ...(table.rowsJson ?? {}) };
  rows[key] = { values: { ...input.values }, updatedByAgentId: agentId, updatedAt: new Date().toISOString() };
  const [row] = await db
    .update(agentSharedTables)
    .set({ rowsJson: rows, updatedAt: new Date() })
    .where(eq(agentSharedTables.id, table.id))
    .returning();
  return row;
}

export async function listOpenWaitsDb(
  db: Db,
  companyId: string,
  options: ListOpenWaitsOptions = {},
): Promise<OpenWaitDbRow[]> {
  requireNonEmpty(companyId, "companyId");
  const conditions = [eq(agentOpenWaits.companyId, companyId)];
  if (options.agentId !== undefined) {
    conditions.push(eq(agentOpenWaits.agentId, requireNonEmpty(options.agentId, "agentId")));
  }
  if (options.status !== undefined) {
    conditions.push(eq(agentOpenWaits.status, options.status));
  }
  return db
    .select()
    .from(agentOpenWaits)
    .where(and(...conditions))
    .orderBy(agentOpenWaits.createdAt);
}

export async function createOpenWaitDb(
  db: Db,
  companyId: string,
  input: CreateOpenWaitInput,
): Promise<OpenWaitDbRow> {
  requireNonEmpty(companyId, "companyId");
  const agentId = requireNonEmpty(input.agentId, "agentId");
  const kind = requireNonEmpty(input.kind, "kind");
  const [row] = await db
    .insert(agentOpenWaits)
    .values({
      companyId,
      agentId,
      kind,
      summary: typeof input.summary === "string" ? input.summary : "",
      targetLabel: input.targetLabel ?? null,
    })
    .returning();
  return row;
}

/** 대기 하나를 resolved로 전환한다. 회사가 다르거나 이미 해결됐으면 null. */
export async function resolveOpenWaitDb(
  db: Db,
  companyId: string,
  waitId: string,
): Promise<OpenWaitDbRow | null> {
  requireNonEmpty(companyId, "companyId");
  const id = requireNonEmpty(waitId, "waitId");
  const [row] = await db
    .update(agentOpenWaits)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(
      and(
        eq(agentOpenWaits.id, id),
        eq(agentOpenWaits.companyId, companyId),
        eq(agentOpenWaits.status, "waiting"),
      ),
    )
    .returning();
  return row ?? null;
}
