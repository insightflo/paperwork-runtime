import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, harnessRsiLedger } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(
    `Skipping harness_rsi_ledger schema tests: ${support.reason ?? "unsupported environment"}`,
  );
}

describeDb("harness_rsi_ledger schema", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const insertCompany = async (id: string) => {
    await db.insert(companies).values({
      id,
      name: "RSI Ledger Co",
      issuePrefix: `HL${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-harness-rsi-ledger-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("migration applies; insert + read back scoped by companyId", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await insertCompany(companyId);
    await insertCompany(otherCompanyId);

    const [inserted] = await db
      .insert(harnessRsiLedger)
      .values({
        companyId,
        round: 3,
        variant: "v2-prompt",
        component: "workflow_dag",
        hypothesis: "shorten serial LLM depth",
        diffRef: "diff://abc123",
        decision: "approved",
        decidedBy: "board",
        baselineJson: { score: 0.81 },
        deltaScore: 0.04,
        deltaCost: -1200,
        accepted: true,
        verdict: "winner",
        evaluatedAt: new Date(),
      })
      .returning();
    expect(inserted?.id).toBeTruthy();
    expect(inserted?.companyId).toBe(companyId);
    expect(inserted?.createdAt).toBeInstanceOf(Date);

    const rows = await db
      .select()
      .from(harnessRsiLedger)
      .where(eq(harnessRsiLedger.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variant).toBe("v2-prompt");
    expect(rows[0]?.decision).toBe("approved");
    expect(rows[0]?.baselineJson).toEqual({ score: 0.81 });
    expect(rows[0]?.deltaScore).toBeCloseTo(0.04);

    const other = await db
      .select()
      .from(harnessRsiLedger)
      .where(eq(harnessRsiLedger.companyId, otherCompanyId));
    expect(other).toHaveLength(0);
  });

  it("cascades ledger rows when the company is deleted", async () => {
    const companyId = randomUUID();
    await insertCompany(companyId);
    await db.insert(harnessRsiLedger).values({
      companyId,
      variant: "v1",
      component: "guardrails",
      decision: "rejected",
      decidedBy: "critic",
    });

    await db.delete(companies).where(eq(companies.id, companyId));

    const rows = await db
      .select()
      .from(harnessRsiLedger)
      .where(eq(harnessRsiLedger.companyId, companyId));
    expect(rows).toHaveLength(0);
  });
});
