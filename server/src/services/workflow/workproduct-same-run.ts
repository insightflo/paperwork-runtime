import { and, eq, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { heartbeatRuns, issueWorkProducts, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workProductProducerPromotionMarkerSchema, workProductProducerRebindMarkerSchema, workProductProducerSchema, type WorkProductSelectors } from "@paperclipai/shared/validators/workflow-artifact";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";
import { ProducerRebindRequired, withAutomaticProducerRebind } from "./automatic-producer-rebind.js";
import { readQaCorrectionSelectedProduct, type CorrectionSelectedProduct } from "./control-flow/qa-correction-selection.js";

/**
 * [producer provenance rebind] 보드 승인 재바인딩 표시가 생산 사실과 정합한지 검증.
 * 유효한 경우에만 세대 비교를 실제 생산 세대(fromGeneration) 기준으로 평가하고
 * 디스크 바이트(sha256/byteSize)를 매 소비마다 재검증한다. 그 외 모든 검증은 기본 경로와 동일.
 * 표시는 fromGeneration 이후 어떤 현재 세대에서도 유효하다(회복/재발사의 세대 진행에 강건).
 */
function validRebindMarker(product: typeof issueWorkProducts.$inferSelect, producer: {
  executionGeneration: number; heartbeatRunId: string;
}, step: typeof workflowStepRuns.$inferSelect) {
  const parsed = workProductProducerRebindMarkerSchema.safeParse(product.metadata?.workflowProducerRebind);
  if (!parsed.success) return null;
  const marker = parsed.data;
  if (marker.fromGeneration !== producer.executionGeneration
    || marker.fromHeartbeatRunId !== producer.heartbeatRunId
    || step.executionGeneration < marker.fromGeneration) return null;
  return marker;
}

/**
 * [delegated producer promotion — #323] 보드 승격 마커가 유효한지 검증.
 *   합성 귀속의 세대(fromGeneration)와 발라 권위(delegatedHeartbeatRunId)가 마커와
 *   정합하고 현재 세대가 fromGeneration 이후면 유효하다(전방향 — 회복/재발사 강건).
 */
function validPromotionMarker(product: typeof issueWorkProducts.$inferSelect, producer: {
  executionGeneration: number; heartbeatRunId: string;
}, step: typeof workflowStepRuns.$inferSelect) {
  const parsed = workProductProducerPromotionMarkerSchema.safeParse(product.metadata?.workflowProducerPromotion);
  if (!parsed.success) return null;
  const marker = parsed.data;
  if (marker.fromGeneration !== producer.executionGeneration
    || marker.delegatedHeartbeatRunId !== producer.heartbeatRunId
    || step.executionGeneration < marker.fromGeneration) return null;
  return marker;
}

/** Ordinary same-run selector: cross-run approval must never weaken these checks. */
type SameRunScope = { companyId: string; workflowRunId: string;
  stepId: string; selector: WorkProductSelectors[string]; pinnedId?: string };

/**
 * [2026-11-28 provenance_missing 재발 교정] 귀속 봉인(workflowProducer)이 없거나 스키마가
 *   맞지 않는 로컬 산출물이라도, createdByRunId 하트비트가 “이 생산자 stepRun 의 실제
 *   디스패치 시도”임을 DB 사슬로 증명하면 같은-런 셀렉터가 등록 시점과 동일한 검사
 *   (registeredProducer: 회사/이슈/stepRun/현재 세대 + 시도증명)로 신원을 재도출해 소비를
 *   통과시킨다. 이는 2026-10-17(#392) 이후에도 남은 독 기록 경로(스텝 바인딩 이슈에
 *   런 없는 등록 — board API createdByRunId=null 은 registeredProducer null 반환)와
 *   봉인 유실 행을 회복 불가 실패에서 구하기 위한 것이다.
 * [정직성/보안] 파생은 기존 등록 검사와 동일한 사실만 요구하므로 외부 회사·무주·위임
 *   (workflow.delegated-work-product-producer.v1, createdByRunId 가 언블록 이슈에 연결)
 *   산출물은 절대 통과하지 못한다 — 위임 제품은 기존과 같이 provenance_missing 으로
 *   펜스되고 보드 승격(promotion)만이 유일한 회복 경로다.
 */
async function deriveSameRunProducerFromDispatch(db: Db, product: typeof issueWorkProducts.$inferSelect,
  run: typeof workflowRuns.$inferSelect, step: typeof workflowStepRuns.$inferSelect):
  Promise<z.infer<typeof workProductProducerSchema>> {
  const fenced = () => new Error("workproduct_selector_provenance_missing");
  if (typeof product.createdByRunId !== "string") throw fenced();
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, product.createdByRunId));
  if (!heartbeat || heartbeat.companyId !== product.companyId || heartbeat.issueId !== step.issueId
    || heartbeat.workflowStepRunId !== step.id
    || heartbeat.workflowExecutionGeneration !== step.executionGeneration) throw fenced();
  let attempt: { retryCount: number; iterationIndex: number };
  try { attempt = await producerAttempt(db, heartbeat, step); }
  catch { throw new Error("workproduct_selector_stale_producer"); }
  return { schemaVersion: "workflow.work-product-producer.v1", companyId: product.companyId,
    missionId: run.missionId, workflowRunId: run.id, stepRunId: step.id, stepId: step.stepId,
    executionGeneration: heartbeat.workflowExecutionGeneration,
    retryCount: attempt.retryCount, iterationIndex: attempt.iterationIndex,
    heartbeatRunId: heartbeat.id };
}
export function selectSameRunWorkProduct(db: Db, scope: SameRunScope) {
  return withAutomaticProducerRebind(db, () => readSameRunWorkProduct(db, scope));
}

const LOCAL_FILE_TYPE_FALLBACK: Readonly<Record<string, string>> = {
  document: "artifact",
  artifact: "document",
};

async function readSameRunWorkProduct(db: Db, scope: SameRunScope): Promise<CorrectionSelectedProduct> {
  const [source] = await db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(eq(workflowRuns.id, scope.workflowRunId), eq(workflowRuns.companyId, scope.companyId), eq(workflowStepRuns.stepId, scope.stepId)));
  if (!source?.step.issueId || source.step.status !== "completed") throw new Error("workproduct_selector_producer_unavailable");
  const baseConds = [
    eq(issueWorkProducts.companyId, scope.companyId), eq(issueWorkProducts.issueId, source.step.issueId),
    ...(scope.pinnedId ? [eq(issueWorkProducts.id, scope.pinnedId)] : [ne(issueWorkProducts.status, "archived")]),
    eq(issueWorkProducts.title, scope.selector.title),
  ];
  let products = await db.select().from(issueWorkProducts).where(and(...baseConds, eq(issueWorkProducts.type, scope.selector.type)));
  // [2026-11-28] Producers occasionally register local file artifacts (e.g. content.json) as "artifact"
  // when the workflow selector declares "document" (or vice versa). Fall back ONLY when exact type
  // yields 0 rows, while keeping strict cardinality (=== 1), exact title, and all provenance checks.
  const fallbackType = products.length === 0 ? LOCAL_FILE_TYPE_FALLBACK[scope.selector.type] : undefined;
  if (fallbackType) {
    products = await db.select().from(issueWorkProducts).where(and(...baseConds, eq(issueWorkProducts.type, fallbackType)));
  }
  if (products.length !== 1) throw new Error("workproduct_selector_not_exactly_one");
  const product = products[0];
  if (Object.hasOwn(product.metadata ?? {}, "qaCorrection")) {
    return readQaCorrectionSelectedProduct(db, scope, product);
  }
  const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
  const derived = !parsed.success;
  const p = parsed.success ? parsed.data
    : await deriveSameRunProducerFromDispatch(db, product, source.run, source.step);
  const s = source.step;
  const promotion = validPromotionMarker(product, p, s);
  const rebind = promotion ? null : validRebindMarker(product, p, s);
  const toleratedFields = promotion || rebind ? ["executionGeneration", "sourceExecutionGeneration"] : [];
  const mismatches = workProductProducerMismatches(p, { ...scope, run: source.run, step: s, product });
  // [파생 경로] sourceExecutionGeneration(등록 시점 봉인 흔적)은 파생 신원의 세대 출처가 아니다.
  //   하트비트 사슬이 이미 현재 세대를 증명했으므로 이 필드 불일치만은 수선 대상이고,
  //   파생 신원이 곧 현재 세대 귀속이므로 ProducerRebindRequired(자동 재귀속)도 필요 없다.
  const repairedByDerivation = derived ? new Set(["sourceExecutionGeneration"]) : new Set<string>();
  if (mismatches.some(field => !toleratedFields.includes(field) && !repairedByDerivation.has(field))) {
    if (!promotion && !rebind && mismatches.every(field => ["executionGeneration", "sourceExecutionGeneration"].includes(field) || repairedByDerivation.has(field))) {
      throw new ProducerRebindRequired({ companyId: scope.companyId, workflowRunId: scope.workflowRunId,
        producerStepId: scope.stepId, productId: product.id, selector: scope.selector, pinnedId: scope.pinnedId });
    }
    throw new Error("workproduct_selector_stale_producer");
  }
  if (promotion) {
    // [delegated producer promotion] 보드 승격 권위가 시도증명(producerAttempt) 사슬을 대체한다.
    //   위임 생산의 하트비트는 생산자 stepRun 이 아닌 위임 이슈에 연결돼 있으므로 존재·회사·
    //   위임 이슈 정합만 검증하고, 바이트 동일성은 아래에서 매 소비 재검증한다.
    const [delegatedHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, p.heartbeatRunId));
    if (!delegatedHeartbeat || delegatedHeartbeat.companyId !== p.companyId
      || delegatedHeartbeat.issueId !== promotion.delegatedFromIssueId) {
      throw new Error("workproduct_selector_heartbeat_mismatch");
    }
  } else {
    const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, p.heartbeatRunId));
    const heartbeatGenerationHolds = heartbeat
      && heartbeat.workflowExecutionGeneration === (rebind ? rebind.fromGeneration : s.executionGeneration);
    if (!heartbeat || heartbeat.companyId !== p.companyId || heartbeat.issueId !== s.issueId
      || heartbeat.workflowStepRunId !== s.id || !heartbeatGenerationHolds) {
      throw new Error("workproduct_selector_heartbeat_mismatch");
    }
    try {
      // [producer provenance rebind] 유효한 재바인딩 표시가 있으면 시도증명의 세대 기준만
      //   fromGeneration(실제 생산 세대)으로 평가한다. retry/iteration 은 현재 값 그대로 비교된다.
      const attempt = await producerAttempt(db, heartbeat,
        rebind ? { ...s, executionGeneration: rebind.fromGeneration } : s);
      if (attempt.retryCount !== p.retryCount || attempt.iterationIndex !== p.iterationIndex) throw new Error("attempt mismatch");
    } catch { throw new Error("workproduct_selector_stale_producer"); }
  }
  const file = resolveWorkProductLocalFilePath(product);
  if (!file || !["local", "local_file"].includes(product.provider)) throw new Error("workproduct_selector_not_local");
  const authorityMarker = promotion ?? rebind;
  if (authorityMarker) {
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== authorityMarker.sha256 || bytes.byteLength !== authorityMarker.byteSize) {
      throw new Error(promotion ? "workproduct_selector_promotion_bytes_mismatch" : "workproduct_selector_rebind_bytes_mismatch");
    }
  }
  return { product, producer: p, file };
}
