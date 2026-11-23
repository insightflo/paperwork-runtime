-- 0136: Enforce tenant + KB isolation on knowledge_nodes via composite FKs.
-- Fail-closed preflight: never silently reassign cross-company ownership.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM "knowledge_nodes" kn
  JOIN "knowledge_bases" kb ON kb."id" = kn."kb_id"
  WHERE kn."company_id" <> kb."company_id";

  IF bad_count > 0 THEN
    RAISE EXCEPTION '0136 preflight failed: % knowledge_nodes rows have company_id != knowledge_bases.company_id; manual remediation required', bad_count;
  END IF;
END $$;
--> statement-breakpoint
-- Sanitize any legacy cross-KB or cross-company parent_id pointers to NULL before adding composite self-FK.
UPDATE "knowledge_nodes" c
SET "parent_id" = NULL
WHERE c."parent_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "knowledge_nodes" p
    WHERE p."id" = c."parent_id"
      AND p."company_id" = c."company_id"
      AND p."kb_id" = c."kb_id"
  );
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_bases_company_id_id_uq'
  ) THEN
    ALTER TABLE "knowledge_bases"
      ADD CONSTRAINT "knowledge_bases_company_id_id_uq" UNIQUE ("company_id", "id");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_nodes_company_kb_id_uq'
  ) THEN
    ALTER TABLE "knowledge_nodes"
      ADD CONSTRAINT "knowledge_nodes_company_kb_id_uq" UNIQUE ("company_id", "kb_id", "id");
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "knowledge_nodes"
  DROP CONSTRAINT IF EXISTS "knowledge_nodes_kb_id_knowledge_bases_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_nodes"
  DROP CONSTRAINT IF EXISTS "knowledge_nodes_parent_id_knowledge_nodes_id_fk";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_nodes_company_kb_fk'
  ) THEN
    ALTER TABLE "knowledge_nodes"
      ADD CONSTRAINT "knowledge_nodes_company_kb_fk"
      FOREIGN KEY ("company_id", "kb_id")
      REFERENCES "knowledge_bases" ("company_id", "id")
      ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_nodes_parent_same_kb_fk'
  ) THEN
    ALTER TABLE "knowledge_nodes"
      ADD CONSTRAINT "knowledge_nodes_parent_same_kb_fk"
      FOREIGN KEY ("company_id", "kb_id", "parent_id")
      REFERENCES "knowledge_nodes" ("company_id", "kb_id", "id")
      ON DELETE SET NULL ("parent_id");
  END IF;
END $$;
