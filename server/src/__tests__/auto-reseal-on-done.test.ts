import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  autoResealStaleProducerWorkProductsOnDone,
  needsProducerReseal,
  type ActiveProducerIdentity,
} from "../services/work-products/auto-reseal-on-done.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_RUN_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_RUN_ID = "33333333-3333-4333-8333-333333333334";
const STEP_RUN_ID = "44444444-4444-4444-8444-444444444444";
const HB_NEW = "55555555-5555-4555-8555-555555555555";
const HB_OLD = "66666666-6666-4666-8666-666666666666";
const ISSUE_ID = "77777777-7777-4777-8777-777777777777";

const CURRENT_PRODUCER: ActiveProducerIdentity = {
  schemaVersion: "workflow.work-product-producer.v1",
  companyId: COMPANY_ID,
  missionId: MISSION_ID,
  workflowRunId: WORKFLOW_RUN_ID,
  stepRunId: STEP_RUN_ID,
  stepId: "build-service-report-content",
  executionGeneration: 4,
  retryCount: 0,
  iterationIndex: 1,
  heartbeatRunId: HB_NEW,
};

const STALE_METADATA = {
  path: "/tmp/content.json",
  workflowProducer: {
    ...CURRENT_PRODUCER,
    executionGeneration: 0,
    iterationIndex: 0,
    heartbeatRunId: HB_OLD,
    sha256: "a".repeat(64),
    byteSize: 123,
  },
};

describe("needsProducerReseal", () => {
  it("returns true for ordinary rework/Unblock artifacts with stale iteration, generation, retry, or heartbeat", () => {
    expect(needsProducerReseal(STALE_METADATA, CURRENT_PRODUCER)).toBe(true);
    expect(
      needsProducerReseal(
        { workflowProducer: { ...STALE_METADATA.workflowProducer, executionGeneration: 4, iterationIndex: 0, heartbeatRunId: HB_NEW } },
        CURRENT_PRODUCER,
      ),
    ).toBe(true);
    expect(
      needsProducerReseal(
        { workflowProducer: { ...STALE_METADATA.workflowProducer, executionGeneration: 4, iterationIndex: 1, retryCount: 1, heartbeatRunId: HB_NEW } },
        CURRENT_PRODUCER,
      ),
    ).toBe(true);
  });

  it("is idempotent (returns false when already resealed to current producer)", () => {
    expect(
      needsProducerReseal(
        { workflowProducer: { ...CURRENT_PRODUCER, sha256: "b".repeat(64), byteSize: 456 } },
        CURRENT_PRODUCER,
      ),
    ).toBe(false);
  });

  it("excludes qaCorrection, missing provenance, mismatched run/step, and backwards generation/iteration", () => {
    expect(needsProducerReseal({ ...STALE_METADATA, qaCorrection: { version: 1 } }, CURRENT_PRODUCER)).toBe(false);
    expect(needsProducerReseal({ path: "/tmp/content.json" }, CURRENT_PRODUCER)).toBe(false);
    expect(
      needsProducerReseal(
        { workflowProducer: { ...STALE_METADATA.workflowProducer, workflowRunId: OTHER_RUN_ID } },
        CURRENT_PRODUCER,
      ),
    ).toBe(false);
    expect(
      needsProducerReseal(
        { workflowProducer: { ...STALE_METADATA.workflowProducer, executionGeneration: 9 } },
        CURRENT_PRODUCER,
      ),
    ).toBe(false);
  });
});

describe("autoResealStaleProducerWorkProductsOnDone rollback & audit", () => {
  it("rolls back all updates on mid-transaction seal failure and logs company-scoped failure on outer root db", async () => {
    const committedUpdates: string[] = [];
    const outerAuditInserts: Array<Record<string, unknown>> = [];

    const fakeProducts = [
      { id: "wp-1", companyId: COMPANY_ID, issueId: ISSUE_ID, provider: "local_file", status: "active", metadata: STALE_METADATA, url: null },
      { id: "wp-2", companyId: COMPANY_ID, issueId: ISSUE_ID, provider: "local_file", status: "active", metadata: STALE_METADATA, url: null },
    ];

    const fakeDb = {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
        const pendingUpdates: string[] = [];
        const tx = {
          select: () => ({ from: () => ({ where: async () => fakeProducts }) }),
          update: () => ({
            set: () => ({
              where: async () => {
                pendingUpdates.push("updated");
              },
            }),
          }),
          insert: () => ({ values: async () => {} }),
        };
        const out = await fn(tx);
        committedUpdates.push(...pendingUpdates);
        return out;
      },
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          outerAuditInserts.push(row);
          return Promise.resolve();
        },
      }),
    } as unknown as Db;

    let calls = 0;
    const sealFn = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("workproduct_producer_file_unreadable");
      return { metadata: { ...STALE_METADATA, sha256: "c".repeat(64) }, seal: { sha256: "c".repeat(64), byteSize: 99 } };
    }) as unknown as NonNullable<Parameters<typeof autoResealStaleProducerWorkProductsOnDone>[2]>["sealFn"];

    const res = await autoResealStaleProducerWorkProductsOnDone(
      fakeDb,
      { companyId: COMPANY_ID, issueId: ISSUE_ID, heartbeatRunId: HB_NEW },
      { resolveProducer: async () => CURRENT_PRODUCER, sealFn },
    );

    expect(res).toEqual({ resealed: 0, productIds: [], skippedReason: "workproduct_producer_file_unreadable" });
    expect(committedUpdates).toHaveLength(0);
    expect(outerAuditInserts).toHaveLength(1);
    expect(outerAuditInserts[0]).toMatchObject({
      companyId: COMPANY_ID,
      action: "work_product.auto_reseal_failed",
      entityType: "issue",
      entityId: ISSUE_ID,
      runId: HB_NEW,
      details: { reason: "workproduct_producer_file_unreadable" },
    });
  });
});
