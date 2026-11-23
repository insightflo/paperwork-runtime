import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { companies, createDb, knowledgeBases, knowledgeNodes } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("knowledge_nodes schema and migration 0135", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-knowledge-nodes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("supports hierarchical insert, unique (kb_id, slug), kb-scoped FTS, and idempotent re-apply", async () => {
    const companyId = randomUUID();
    const kbId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "KB Test Co",
      issuePrefix: `KB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(knowledgeBases).values({
      id: kbId,
      companyId,
      name: "Core Architecture",
      type: "ontology",
      description: "Tree KB",
      configJson: {},
    });

    const [root] = await db
      .insert(knowledgeNodes)
      .values({
        companyId,
        kbId,
        slug: "delivery-policy",
        title: "GitHub Delivery Policy",
        summary: "Isolated worktrees and independent QA gate",
        content: "Always use isolated worktrees and verify CI before merge.",
        nodeType: "glossary",
        certified: true,
        tags: ["github", "qa"],
        sourceRefs: [{ type: "manual", label: "Inflo Policy" }],
      })
      .returning();

    const [child] = await db
      .insert(knowledgeNodes)
      .values({
        companyId,
        kbId,
        parentId: root.id,
        slug: "worktree-rules",
        title: "Worktree Isolation Rules",
        summary: "Branch from origin/main per PR",
        content: "Keep each PR under 5 files and remove merged worktrees cleanly.",
        nodeType: "concept",
        tags: ["worktree"],
        linkedNodeIds: [root.id],
      })
      .returning();

    expect(child.parentId).toBe(root.id);
    expect(root.certified).toBe(true);

    // Unique (kb_id, slug) must reject duplicate slug in the same KB.
    await expect(
      db.insert(knowledgeNodes).values({
        companyId,
        kbId,
        slug: "delivery-policy",
        title: "Duplicate",
      }),
    ).rejects.toThrow();

    // kb_id-scoped FTS query using simple config must match the child node.
    const hits = await db
      .select({ id: knowledgeNodes.id, slug: knowledgeNodes.slug })
      .from(knowledgeNodes)
      .where(
        and(
          eq(knowledgeNodes.kbId, kbId),
          sql`to_tsvector('simple', coalesce(${knowledgeNodes.title}, '') || ' ' || coalesce(${knowledgeNodes.summary}, '') || ' ' || coalesce(${knowledgeNodes.content}, '')) @@ plainto_tsquery('simple', 'worktrees')`,
        ),
      );
    expect(hits.map((h) => h.slug)).toContain("worktree-rules");

    // Idempotent upgrade re-apply check: re-running 0135 SQL statements must succeed without error.
    const migrationSql = await readFile(
      new URL("../../../packages/db/src/migrations/0135_knowledge_nodes.sql", import.meta.url),
      "utf8",
    );
    for (const stmt of migrationSql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(stmt));
    }
  });
});
