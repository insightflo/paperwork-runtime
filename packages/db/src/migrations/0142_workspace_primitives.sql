-- 0142: Workspace primitives (Stage 35 W3) — agent shared tables + pending agent open waits.
-- Idempotent for fresh and live DBs; the server store also bootstraps these tables
-- with the same statements (ensureWorkspacePrimitivesTables) so existing A1 DBs
-- auto-bootstrap cleanly even before migrations run.
CREATE TABLE IF NOT EXISTS "agent_shared_tables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "columns_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rows_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_open_waits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "target_label" text,
  "status" text DEFAULT 'waiting' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "agent_open_waits_status_check" CHECK ("status" in ('waiting', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_shared_tables_company_name_unique_idx" ON "agent_shared_tables" ("company_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_open_waits_company_status_created_idx" ON "agent_open_waits" ("company_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_open_waits_company_agent_idx" ON "agent_open_waits" ("company_id", "agent_id");
