-- 0137: Drop legacy auto-named single-column FKs on knowledge_nodes left over from 0135.
-- 0135 declared inline REFERENCES (Postgres auto-named "*_fkey"); 0136 installed the
-- composite tenant/KB-scoped FKs but only dropped the drizzle-named "*_id_fk" variants,
-- so these redundant single-column FKs survive on databases that ran the journaled 0135.
-- Composite knowledge_nodes_company_kb_fk / knowledge_nodes_parent_same_kb_fk remain the
-- enforcement authority; these drops are idempotent no-ops where the names are absent.
ALTER TABLE "knowledge_nodes" DROP CONSTRAINT IF EXISTS "knowledge_nodes_kb_id_fkey";
--> statement-breakpoint
ALTER TABLE "knowledge_nodes" DROP CONSTRAINT IF EXISTS "knowledge_nodes_parent_id_fkey";
