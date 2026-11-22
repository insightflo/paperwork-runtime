-- 0135: knowledge_nodes — PageIndex tree + ontology (node_type/certified) + grounded source_refs + simple FTS GIN index.
CREATE TABLE IF NOT EXISTS "knowledge_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "kb_id" uuid NOT NULL REFERENCES "knowledge_bases"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "knowledge_nodes"("id") ON DELETE SET NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "node_type" text DEFAULT 'concept' NOT NULL,
  "certified" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "linked_node_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_knowledge_nodes_company_kb" ON "knowledge_nodes" ("company_id", "kb_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_knowledge_nodes_kb_parent" ON "knowledge_nodes" ("kb_id", "parent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_nodes_kb_id_slug_uq" ON "knowledge_nodes" ("kb_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_knowledge_nodes_fts" ON "knowledge_nodes"
  USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("content", '')));
