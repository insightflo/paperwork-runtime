// @vitest-environment node
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, knowledgeBases, companies } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "../../../packages/db/src/test-embedded-postgres.js";
import { upsertKbNode } from "../services/knowledge/kb-nodes.js";

const C1 = "40000000-0000-4000-8000-000000000001";
const KB1 = "41000000-0000-4000-8000-000000000001";

describe("upsertKbNode real PostgreSQL 2-session concurrency", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;
  let lockDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("kb-toctou-");
    db = createDb(database.connectionString);
    lockDb = createDb(database.connectionString);
    await db.insert(companies).values({ id: C1, name: "Concurrency Co", issuePrefix: "CC1" });
    await db.insert(knowledgeBases).values({ id: KB1, companyId: C1, name: "Core KB", type: "ontology" });
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("blocks on concurrent certify transaction and skips overwrite under preserveCertified", async () => {
    const initial = await upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "canon-lock-test", title: "Initial", certified: false, actorId: "seed",
    });
    expect(initial.created).toBe(true);

    let releaseCertify!: () => void;
    const certifyStarted = new Promise<void>((r) => {
      void lockDb.transaction(async (tx) => {
        await tx.execute(sql`UPDATE knowledge_nodes SET certified = true, title = 'Certified By Board' WHERE id = ${initial.node.id}`);
        r();
        await new Promise<void>((done) => { releaseCertify = done; });
      });
    });
    await certifyStarted;

    const upsertPromise = upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "canon-lock-test", title: "Stale Auto Sync", certified: false, preserveCertified: true, actorId: "sys",
    });
    await new Promise((r) => setTimeout(r, 80));
    releaseCertify();

    const out = await upsertPromise;
    expect(out.skippedCertified).toBe(true);
    expect(out.node.certified).toBe(true);
    expect(out.node.title).toBe("Certified By Board");
  });

  it("retries on concurrent delete after conflict and recreates the node cleanly", async () => {
    const initial = await upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "delete-race-test", title: "Before Delete", certified: false, actorId: "seed",
    });

    let releaseDelete!: () => void;
    const deleteStarted = new Promise<void>((r) => {
      void lockDb.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM knowledge_nodes WHERE id = ${initial.node.id}`);
        r();
        await new Promise<void>((done) => { releaseDelete = done; });
      });
    });
    await deleteStarted;

    const upsertPromise = upsertKbNode(db, {
      companyId: C1, kbId: KB1, slug: "delete-race-test", title: "Recreated After Delete", certified: false, actorId: "sys",
    });
    await new Promise((r) => setTimeout(r, 80));
    releaseDelete();

    const out = await upsertPromise;
    expect(out.created).toBe(true);
    expect(out.skippedCertified).toBe(false);
    expect(out.node.title).toBe("Recreated After Delete");
    expect(out.node.id).not.toBe(initial.node.id);
  });
});
