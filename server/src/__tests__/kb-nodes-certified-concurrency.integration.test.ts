// @vitest-environment node
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, knowledgeBases, companies } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "../../../packages/db/src/test-embedded-postgres.js";
import { upsertKbNode } from "../services/knowledge/kb-nodes.js";

const C1 = "40000000-0000-4000-8000-000000000001";
const KB1 = "41000000-0000-4000-8000-000000000001";

async function waitForBlockedForUpdate(
  observerDb: ReturnType<typeof createDb>,
  blockerPid: number,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await observerDb.execute(sql`
      SELECT query FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        AND query ILIKE '%knowledge_nodes%' AND query ILIKE '%for update%'
    `);
    const list = Array.isArray(rows) ? rows : (rows as { rows?: Array<{ query: string }> }).rows ?? [];
    if (list.length > 0) return String((list[0] as { query: string }).query);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for FOR UPDATE blocked by pid=${blockerPid}`);
}

describe("upsertKbNode real PostgreSQL 2-session concurrency", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;
  let lockDb: ReturnType<typeof createDb>;
  let observerDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("kb-toctou-");
    db = createDb(database.connectionString);
    lockDb = createDb(database.connectionString);
    observerDb = createDb(database.connectionString);
    await db.insert(companies).values({ id: C1, name: "Concurrency Co", issuePrefix: "CC1" });
    await db.insert(knowledgeBases).values({ id: KB1, companyId: C1, name: "Core KB", type: "ontology" });
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("proves FOR UPDATE lock-wait on concurrent certify and skips overwrite under preserveCertified", async () => {
    const initial = await upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "canon-lock-test", title: "Initial", certified: false, actorId: "seed",
    });

    let triggerCertifyAndCommit!: () => void;
    const blockerPid = await new Promise<number>((r) => {
      void lockDb.transaction(async (tx) => {
        const pidRows = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
        const pid = Number(((Array.isArray(pidRows) ? pidRows : (pidRows as { rows?: Array<{ pid: number }> }).rows ?? [])[0] as { pid: number }).pid);
        await tx.execute(sql`SELECT id FROM knowledge_nodes WHERE id = ${initial.node.id} FOR UPDATE`);
        r(pid);
        await new Promise<void>((done) => { triggerCertifyAndCommit = done; });
        await tx.execute(sql`UPDATE knowledge_nodes SET certified = true, title = 'Certified By Board' WHERE id = ${initial.node.id}`);
      });
    });

    const upsertPromise = upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "canon-lock-test", title: "Stale Auto Sync", certified: false, preserveCertified: true, actorId: "sys",
    });
    const blockedQuery = await waitForBlockedForUpdate(observerDb, blockerPid);
    expect(blockedQuery.toLowerCase()).toContain("for update");
    triggerCertifyAndCommit();

    const out = await upsertPromise;
    expect(out.skippedCertified).toBe(true);
    expect(out.node.certified).toBe(true);
    expect(out.node.title).toBe("Certified By Board");
  });

  it("proves 1st INSERT conflict -> FOR UPDATE lock-wait -> delete -> 2nd-attempt INSERT recovery", async () => {
    const initial = await upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "delete-race-test", title: "Before Delete", certified: false, actorId: "seed",
    });

    let triggerDeleteAndCommit!: () => void;
    const blockerPid = await new Promise<number>((r) => {
      void lockDb.transaction(async (tx) => {
        const pidRows = await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`);
        const pid = Number(((Array.isArray(pidRows) ? pidRows : (pidRows as { rows?: Array<{ pid: number }> }).rows ?? [])[0] as { pid: number }).pid);
        // Hold row lock WITHOUT deleting yet so attempt-1 INSERT conflicts on existing (kb_id, slug)
        await tx.execute(sql`SELECT id FROM knowledge_nodes WHERE id = ${initial.node.id} FOR UPDATE`);
        r(pid);
        await new Promise<void>((done) => { triggerDeleteAndCommit = done; });
        await tx.execute(sql`DELETE FROM knowledge_nodes WHERE id = ${initial.node.id}`);
      });
    });

    const upsertPromise = upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "delete-race-test", title: "Recreated After Delete", certified: false, actorId: "sys",
    });
    // Reaching FOR UPDATE proves attempt-1 INSERT conflicted; now delete + commit so FOR UPDATE sees 0 rows
    const blockedQuery = await waitForBlockedForUpdate(observerDb, blockerPid);
    expect(blockedQuery.toLowerCase()).toContain("for update");
    triggerDeleteAndCommit();

    const out = await upsertPromise;
    expect(out.created).toBe(true);
    expect(out.skippedCertified).toBe(false);
    expect(out.node.title).toBe("Recreated After Delete");
    expect(out.node.id).not.toBe(initial.node.id);
  });
});
