// [파일 목적] 생산자 이슈가 done 으로 전환될 때, 재작업/Unblock 이터레이션에서 디스크 파일만
//   수정하고 work-products API 재등록을 빠뜨린 로컬 산출물을 서버가 결정적으로 자동 재봉인한다.
//   기존 registeredProducer + sealProducerWrite 보안 경계를 그대로 재사용하며 all-or-nothing 트랜잭션으로 동작.
import { and, eq, inArray, ne } from "drizzle-orm";
import { activityLog, issueWorkProducts, type Db } from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { logger } from "../../middleware/logger.js";
import { registeredProducer } from "./producer-provenance.js";
import { sealProducerWrite } from "./producer-seal.js";

export type ActiveProducerIdentity = Extract<
  NonNullable<Awaited<ReturnType<typeof registeredProducer>>>,
  { schemaVersion: "workflow.work-product-producer.v1" }
>;

export interface AutoResealResult {
  resealed: number;
  productIds: string[];
  skippedReason?: string;
}

export interface AutoResealDeps {
  resolveProducer?: typeof registeredProducer;
  sealFn?: typeof sealProducerWrite;
}

export function needsProducerReseal(
  existingMetadata: Record<string, unknown> | null | undefined,
  currentProducer: ActiveProducerIdentity,
): boolean {
  if (!existingMetadata || typeof existingMetadata !== "object" || Array.isArray(existingMetadata)) return false;
  if (Object.hasOwn(existingMetadata, "qaCorrection")) return false;
  const parsed = workProductProducerSchema.safeParse(existingMetadata.workflowProducer);
  if (!parsed.success) return false;
  const prev = parsed.data;
  if (
    prev.companyId !== currentProducer.companyId ||
    prev.workflowRunId !== currentProducer.workflowRunId ||
    prev.stepRunId !== currentProducer.stepRunId ||
    prev.stepId !== currentProducer.stepId
  ) {
    return false;
  }
  if (
    currentProducer.executionGeneration < prev.executionGeneration ||
    currentProducer.iterationIndex < prev.iterationIndex
  ) {
    return false;
  }
  return (
    prev.executionGeneration !== currentProducer.executionGeneration ||
    prev.iterationIndex !== currentProducer.iterationIndex ||
    prev.retryCount !== currentProducer.retryCount ||
    prev.heartbeatRunId !== currentProducer.heartbeatRunId
  );
}

export async function autoResealStaleProducerWorkProductsOnDone(
  db: Db,
  input: { companyId: string; issueId: string; heartbeatRunId: string },
  deps: AutoResealDeps = {},
): Promise<AutoResealResult> {
  const resolveProducer = deps.resolveProducer ?? registeredProducer;
  const sealFn = deps.sealFn ?? sealProducerWrite;

  try {
    return await db.transaction(async (tx) => {
      const tdb = tx as unknown as Db;
      let producer: Awaited<ReturnType<typeof registeredProducer>>;
      try {
        producer = await resolveProducer(tdb, input.companyId, input.issueId, input.heartbeatRunId);
      } catch {
        return { resealed: 0, productIds: [], skippedReason: "not_dispatched_producer_heartbeat" };
      }
      if (!producer || producer.schemaVersion !== "workflow.work-product-producer.v1") {
        return { resealed: 0, productIds: [], skippedReason: "no_producer_binding" };
      }

      const rows = await tx
        .select()
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, input.companyId),
            eq(issueWorkProducts.issueId, input.issueId),
            ne(issueWorkProducts.status, "archived"),
            inArray(issueWorkProducts.provider, ["local", "local_file"]),
          ),
        );

      const eligible = rows.filter((r) =>
        needsProducerReseal(r.metadata as Record<string, unknown> | null, producer),
      );
      if (eligible.length === 0) return { resealed: 0, productIds: [] };

      const resealedIds: string[] = [];
      for (const row of eligible) {
        const { metadata } = await sealFn(row, producer);
        await tx
          .update(issueWorkProducts)
          .set({ metadata, createdByRunId: input.heartbeatRunId, updatedAt: new Date() })
          .where(and(eq(issueWorkProducts.id, row.id), eq(issueWorkProducts.companyId, input.companyId)));
        resealedIds.push(row.id);
      }

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "workproduct-auto-reseal",
        action: "work_product.auto_resealed_on_done",
        entityType: "issue",
        entityId: input.issueId,
        runId: input.heartbeatRunId,
        details: {
          workflowRunId: producer.workflowRunId,
          stepRunId: producer.stepRunId,
          stepId: producer.stepId,
          executionGeneration: producer.executionGeneration,
          iterationIndex: producer.iterationIndex,
          productIds: resealedIds,
        },
      });

      return { resealed: resealedIds.length, productIds: resealedIds };
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, companyId: input.companyId, issueId: input.issueId }, "work_product auto-reseal on done rolled back");
    await db
      .insert(activityLog)
      .values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "workproduct-auto-reseal",
        action: "work_product.auto_reseal_failed",
        entityType: "issue",
        entityId: input.issueId,
        runId: input.heartbeatRunId,
        details: { reason },
      })
      .catch(() => {});
    return { resealed: 0, productIds: [], skippedReason: reason };
  }
}
