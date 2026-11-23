import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const C1 = "10000000-0000-4000-8000-000000000001";
const C2 = "10000000-0000-4000-8000-000000000002";
const KB1 = "20000000-0000-4000-8000-000000000001";
const KB2 = "20000000-0000-4000-8000-000000000002";
const KB3 = "20000000-0000-4000-8000-000000000003";
const N_PARENT = "30000000-0000-4000-8000-000000000001";
const N_CHILD = "30000000-0000-4000-8000-000000000002";
const N_OTHER_KB = "30000000-0000-4000-8000-000000000003";
const N_BAD_CO = "30000000-0000-4000-8000-000000000004";
const N_UPG_CHILD = "30000000-0000-4000-8000-000000000005";
const N_UPG_OTHER = "30000000-0000-4000-8000-000000000006";

describe("migration 0136 knowledge_nodes composite FK & FTS GIN constraints", () => {
  let database: EmbeddedPostgresTestDatabase;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("kb-nodes-0136-");
    sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${C1}, 'Co1', 'CO1'), (${C2}, 'Co2', 'CO2')`;
    await sql`INSERT INTO knowledge_bases (id, company_id, name, type) VALUES (${KB1}, ${C1}, 'KB1', 'ontology'), (${KB2}, ${C1}, 'KB2', 'ontology'), (${KB3}, ${C2}, 'KB3', 'ontology')`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  it("fresh bootstrap installs composite FKs, parent-only SET NULL, and FTS GIN index", async () => {
    const fts = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'knowledge_nodes' AND indexname = 'idx_knowledge_nodes_fts'
    `;
    expect(fts[0]?.indexdef).toContain("USING gin");

    // Reject cross-company (company_id, kb_id)
    await expect(sql`
      INSERT INTO knowledge_nodes (id, company_id, kb_id, slug, title)
      VALUES (${N_BAD_CO}, ${C1}, ${KB3}, 'bad-co', 'Bad Co')
    `).rejects.toThrow(/knowledge_nodes_company_kb_fk|foreign key/i);

    // Valid parent + child in KB1, plus node in KB2
    await sql`INSERT INTO knowledge_nodes (id, company_id, kb_id, slug, title) VALUES (${N_PARENT}, ${C1}, ${KB1}, 'parent', 'Parent')`;
    await sql`INSERT INTO knowledge_nodes (id, company_id, kb_id, parent_id, slug, title) VALUES (${N_CHILD}, ${C1}, ${KB1}, ${N_PARENT}, 'child', 'Child')`;
    await sql`INSERT INTO knowledge_nodes (id, company_id, kb_id, slug, title) VALUES (${N_OTHER_KB}, ${C1}, ${KB2}, 'other', 'Other KB')`;

    // Reject cross-KB parent_id
    await expect(sql`
      UPDATE knowledge_nodes SET parent_id = ${N_OTHER_KB} WHERE id = ${N_CHILD}
    `).rejects.toThrow(/knowledge_nodes_parent_same_kb_fk|foreign key/i);

    // Deleting parent nulls ONLY parent_id (preserves company_id and kb_id)
    await sql`DELETE FROM knowledge_nodes WHERE id = ${N_PARENT}`;
    const [child] = await sql<{ company_id: string; kb_id: string; parent_id: string | null }[]>`
      SELECT company_id::text, kb_id::text, parent_id::text FROM knowledge_nodes WHERE id = ${N_CHILD}
    `;
    expect(child).toEqual({ company_id: C1, kb_id: KB1, parent_id: null });
  });

  it("0135 -> 0136 upgrade fails closed on cross-company kb_id and sanitizes cross-KB parent_id", async () => {
    // Rewind 0136 constraints + history to simulate a 0135 database state
    await sql`ALTER TABLE knowledge_nodes DROP CONSTRAINT IF EXISTS knowledge_nodes_parent_same_kb_fk`;
    await sql`ALTER TABLE knowledge_nodes DROP CONSTRAINT IF EXISTS knowledge_nodes_company_kb_fk`;
    await sql`ALTER TABLE knowledge_nodes DROP CONSTRAINT IF EXISTS knowledge_nodes_company_kb_id_uq`;
    await sql`ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_company_id_id_uq`;
    await sql`ALTER TABLE knowledge_nodes ADD CONSTRAINT knowledge_nodes_kb_id_knowledge_bases_id_fk FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE`;
    await sql`ALTER TABLE knowledge_nodes ADD CONSTRAINT knowledge_nodes_parent_id_knowledge_nodes_id_fk FOREIGN KEY (parent_id) REFERENCES knowledge_nodes(id) ON DELETE SET NULL`;
    const sql0136 = await readFile(new URL("./migrations/0136_knowledge_nodes_constraints.sql", import.meta.url));
    const hash0136 = createHash("sha256").update(sql0136).digest("hex");
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash0136}`;

    // Legacy invalid cross-company kb_id row (allowed under 0135) must fail closed
    await sql`INSERT INTO knowledge_nodes (id, company_id, kb_id, slug, title) VALUES (${N_BAD_CO}, ${C1}, ${KB3}, 'legacy-bad-co', 'Legacy Bad Co')`;
    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(/0136 preflight failed/);

    // After operator remediates cross-company row, legacy cross-KB parent_id is sanitized to NULL.
    // Also verify a same-named constraint in another schema does not cause 0136 to skip installing FKs.
    await sql`CREATE SCHEMA IF NOT EXISTS other_schema`;
    await sql`CREATE TABLE IF NOT EXISTS other_schema.dummy (id uuid PRIMARY KEY, kb_id uuid, company_id uuid, parent_id uuid, CONSTRAINT knowledge_nodes_company_kb_fk CHECK (id IS NOT NULL), CONSTRAINT knowledge_nodes_parent_same_kb_fk CHECK (id IS NOT NULL))`;
    await sql`DELETE FROM knowledge_nodes WHERE id = ${N_BAD_CO}`;
    await sql`INSERT INTO knowledge_nodes (id, company_id, kb_id, slug, title) VALUES (${N_UPG_OTHER}, ${C1}, ${KB2}, 'upg-other', 'Upg Other') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO knowledge_nodes (id, company_id, kb_id, parent_id, slug, title) VALUES (${N_UPG_CHILD}, ${C1}, ${KB1}, ${N_UPG_OTHER}, 'upg-child', 'Upg Child') ON CONFLICT DO NOTHING`;
    await applyPendingMigrations(database.connectionString);

    const [sanitized] = await sql<{ parent_id: string | null }[]>`
      SELECT parent_id::text FROM knowledge_nodes WHERE id = ${N_UPG_CHILD}
    `;
    expect(sanitized?.parent_id).toBeNull();
    const installedFks = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.knowledge_nodes'::regclass
        AND conname IN ('knowledge_nodes_company_kb_fk', 'knowledge_nodes_parent_same_kb_fk')
      ORDER BY conname
    `;
    expect(installedFks.map((r) => r.conname)).toEqual([
      "knowledge_nodes_company_kb_fk",
      "knowledge_nodes_parent_same_kb_fk",
    ]);
  });
});
