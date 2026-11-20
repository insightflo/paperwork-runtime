import {
  evaluateWorkflowConditionGroup,
  readRestrictedJsonPath,
} from "./control-flow/condition-evaluator.js";
import { WorkProductConditionWaitableError } from "./control-flow/waitable-condition-error.js";
import {
  appendRetryAttempt,
  buildWorkflowRetryMetadata,
  classifyWorkflowStepRetry,
  normalizeWorkflowRetryPolicy,
  sanitizeErrorSummary,
  type WorkflowRetryMetadata,
  type WorkflowRetryPolicy,
  type WorkflowRetryPolicySource,
  type WorkflowStepRetryDecision,
} from "./retry-policy.js";
import { runWithNodeFallback, WorkflowCoreContractError } from "./workflow-core-client.js";
import type { WorkflowConditionGroup, WorkflowConditionSource } from "@paperclipai/shared";

/**
 * [목적] Stage 4A 서브커맨드(evaluate-conditions · classify-retry-batch)의 Node 브리지.
 *   workflow-core-client.ts 의 runWithNodeFallback/게이트/warn-once 계약을 그대로 재사용한다.
 * [주의] 시맨틱 에러는 절대 fallback 하지 않는다 — Rust 의 {error:{code,message,…}} 봉투는
 *   TS 가 던졌을 동일 에러로 재구성해 그대로 전파한다(어느 팔에서 왔는지 증명 불가가 정상).
 *   evaluate-conditions: waitable_type_mismatch → WorkProductConditionWaitableError
 *   (sourceStepId/sourceTitle 보존 — grace-wait 판정이 메시지 파싱이 아니라 타입을 읽는다),
 *   evaluation_failed → 동일 메시지의 일반 Error. 소스 해소·readRestrictedJsonPath·
 *   grace-wait·CAS/이벤트/run-reopen 같은 DB 부수효과는 전부 TS 책임으로 남는다.
 *   F4: 서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] 호출처: control-node-executor.ts(IF 평가), workflow-step-retry-pass.ts(재시도
 *   분류). 응답 shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

// ── evaluate-conditions ──────────────────────────────────────────────
// 계약: {combinator, conditions:[{source,dataType,operator,rightValue,left}]} →
//   {outcome,results} | {error:{code,message,sourceStepId?,sourceTitle?}}.
// `left` 는 TS 가 resolveSource + readRestrictedJsonPath 로 미리 해소해 넘긴다 —
//   경로 문법/prototype 검사는 TS 에만 존재하므로 payload() 안의 throw 는 그대로 전파된다.

export function evaluateConditionsWithNodeFallback(input: {
  group: WorkflowConditionGroup;
  resolveSource: (source: WorkflowConditionSource) => unknown;
}): Promise<{ outcome: boolean; results: boolean[] }> {
  return runWithNodeFallback({
    subcommand: "evaluate-conditions",
    payload: () => ({
      combinator: input.group.combinator,
      conditions: input.group.conditions.map((condition) => ({
        source: condition.source,
        dataType: condition.dataType,
        operator: condition.operator,
        rightValue: condition.rightValue,
        left: readRestrictedJsonPath(input.resolveSource(condition.source), condition.source.path),
      })),
    }),
    fallback: () => evaluateWorkflowConditionGroup(input),
    interpret: (response) => {
      const r = response as {
        outcome?: unknown;
        results?: unknown;
        error?: { code?: unknown; message?: unknown; sourceStepId?: unknown; sourceTitle?: unknown };
      };
      if (r && typeof r === "object" && r.error && typeof r.error === "object") {
        const e = r.error;
        if (e.code === "waitable_type_mismatch" && typeof e.message === "string"
          && typeof e.sourceStepId === "string" && typeof e.sourceTitle === "string") {
          throw new WorkProductConditionWaitableError(e.message, {
            stepId: e.sourceStepId,
            title: e.sourceTitle,
          });
        }
        if (e.code === "evaluation_failed" && typeof e.message === "string") {
          throw new Error(e.message);
        }
        throw new WorkflowCoreContractError("workflow_core_evaluate_conditions_bad_error");
      }
      if (!r || typeof r !== "object" || typeof r.outcome !== "boolean"
        || !Array.isArray(r.results)
        || r.results.length !== input.group.conditions.length
        || !r.results.every((value) => typeof value === "boolean")) {
        throw new WorkflowCoreContractError("workflow_core_evaluate_conditions_bad_shape");
      }
      return { outcome: r.outcome, results: r.results as boolean[] };
    },
  });
}

// ── classify-retry-batch ─────────────────────────────────────────────
// 계약: {nowIso, items:[…]} → {items:[{id,eligible,reason?} | {id,eligible,retryNumber,
//   maxRetries,delaySeconds,retryMetadata,metadata}]}. eligible item 은 TS
//   buildRetryMetadataPatch(step-retry-scheduler.ts)와 동일한 patch 를 실어 보낸다.
//   반환 순서·id 는 입력과 1:1 대응(Rust 가 echo) — 어긋나면 계약 위반으로 fallback.

const STALE_METADATA_KEYS = [
  "toolResult",
  "toolInvocation",
  "toolQueue",
  "cacheHit",
  "controlFlowSkipped",
  "workflowRetryExhaustion",
] as const;

export interface WorkflowRetryBatchClassifyItem {
  id: string;
  /** 이미 정규화된 policy — 있으면 그대로, 없으면 policySource 를 normalize 한다. */
  policy?: WorkflowRetryPolicy;
  policySource?: WorkflowRetryPolicySource;
  stepRunStatus: unknown;
  retryCount: number;
  isControlNode: boolean;
  stepTypeSupported: boolean;
  isQaStep: boolean;
  qaRequestChanges: boolean;
  recoveryActive: boolean;
  /** Rust 는 RNG 를 소유하지 않는다 — 생산자(TS Math.random())가 item 마다 주입한다. */
  jitterRandom?: number;
  /** metadata patch 재료 — 없으면 빈 스프레드로 근사(scheduler 와 동일). */
  metadata?: unknown;
  sourceRequestId?: string | null;
  sourceCompletedAt?: string | null;
  errorSummary?: unknown;
}

export type WorkflowRetryBatchClassifyResult =
  | {
      id: string;
      eligible: true;
      retryNumber: number;
      maxRetries: number;
      delaySeconds: number;
      retryMetadata: WorkflowRetryMetadata;
      metadata: Record<string, unknown>;
    }
  | {
      id: string;
      eligible: false;
      reason: Extract<WorkflowStepRetryDecision, { eligible: false }>["reason"];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** TS 팔: classify → eligible 시 buildRetryMetadataPatch 와 같은 metadata 갱신. */
function classifyRetryItemNode(
  item: WorkflowRetryBatchClassifyItem,
  nowIso: string,
): WorkflowRetryBatchClassifyResult {
  const policy = item.policy ?? normalizeWorkflowRetryPolicy(item.policySource ?? {});
  // Rust 기본 jitterRandom 은 0.5 — 부재 시 양 팔이 같은 고정 표본을 쓴다.
  const jitter = typeof item.jitterRandom === "number" && Number.isFinite(item.jitterRandom)
    ? () => item.jitterRandom as number
    : () => 0.5;
  const decision = classifyWorkflowStepRetry(
    {
      policy,
      // Rust 는 JS-permissive Value 로 받는다 — 비문자열은 TS 도 !== "failed" 로 흘러
      //   malformed_state 가 된다(캐스트는 타입 정합용일 뿐 런타임 값은 그대로다).
      stepRunStatus: item.stepRunStatus as string,
      retryCount: item.retryCount,
      isControlNode: item.isControlNode,
      stepTypeSupported: item.stepTypeSupported,
      isQaStep: item.isQaStep,
      qaRequestChanges: item.qaRequestChanges,
      recoveryActive: item.recoveryActive,
    },
    jitter,
  );
  if (!decision.eligible) {
    return { id: item.id, eligible: false, reason: decision.reason };
  }
  const cleaned: Record<string, unknown> = { ...(isPlainObject(item.metadata) ? item.metadata : {}) };
  for (const key of STALE_METADATA_KEYS) delete cleaned[key];
  const retryMetadata = buildWorkflowRetryMetadata({
    retryNumber: decision.retryNumber,
    maxRetries: decision.maxRetries,
    delaySeconds: decision.delaySeconds,
    now: new Date(nowIso),
    sourceRequestId: item.sourceRequestId ?? null,
    sourceCompletedAt: item.sourceCompletedAt ?? null,
    lastErrorSummary: (item.errorSummary ?? null) as string | null,
  });
  cleaned.workflowRetry = retryMetadata;
  cleaned.workflowRetryAttempts = appendRetryAttempt(cleaned.workflowRetryAttempts, {
    retryNumber: decision.retryNumber - 1,
    failedAt: item.sourceCompletedAt ?? null,
    errorSummary: sanitizeErrorSummary(item.errorSummary),
  });
  return {
    id: item.id,
    eligible: true,
    retryNumber: decision.retryNumber,
    maxRetries: decision.maxRetries,
    delaySeconds: decision.delaySeconds,
    retryMetadata,
    metadata: cleaned,
  };
}

function interpretRetryItem(raw: unknown, expectedId: string): WorkflowRetryBatchClassifyResult {
  const r = raw as {
    id?: unknown;
    eligible?: unknown;
    reason?: unknown;
    retryNumber?: unknown;
    maxRetries?: unknown;
    delaySeconds?: unknown;
    retryMetadata?: unknown;
    metadata?: unknown;
  };
  if (!r || typeof r !== "object" || r.id !== expectedId || typeof r.eligible !== "boolean") {
    throw new WorkflowCoreContractError("workflow_core_classify_retry_batch_bad_item");
  }
  if (!r.eligible) {
    if (typeof r.reason !== "string") {
      throw new WorkflowCoreContractError("workflow_core_classify_retry_batch_bad_reason");
    }
    return {
      id: expectedId,
      eligible: false,
      reason: r.reason as Extract<WorkflowStepRetryDecision, { eligible: false }>["reason"],
    };
  }
  if (typeof r.retryNumber !== "number" || !Number.isFinite(r.retryNumber)
    || typeof r.maxRetries !== "number" || !Number.isFinite(r.maxRetries)
    || typeof r.delaySeconds !== "number" || !Number.isFinite(r.delaySeconds)
    || !isPlainObject(r.retryMetadata) || !isPlainObject(r.metadata)) {
    throw new WorkflowCoreContractError("workflow_core_classify_retry_batch_bad_eligible");
  }
  return {
    id: expectedId,
    eligible: true,
    retryNumber: r.retryNumber,
    maxRetries: r.maxRetries,
    delaySeconds: r.delaySeconds,
    retryMetadata: r.retryMetadata as unknown as WorkflowRetryMetadata,
    metadata: r.metadata,
  };
}

export function classifyRetryBatchWithNodeFallback(input: {
  items: WorkflowRetryBatchClassifyItem[];
  nowIso?: string;
}): Promise<WorkflowRetryBatchClassifyResult[]> {
  if (input.items.length === 0) return Promise.resolve([]);
  const nowIso = input.nowIso ?? new Date().toISOString();
  // nowIso 불량은 양 팔에서 같은 에러로 fail — fallback 이 판정을 갈아끼우지 않게 조기 거부.
  if (!Number.isFinite(new Date(nowIso).getTime())) {
    return Promise.reject(new Error("classify-retry-batch requires a valid ISO-8601 nowIso"));
  }
  return runWithNodeFallback({
    subcommand: "classify-retry-batch",
    payload: () => ({ nowIso, items: input.items }),
    fallback: () => input.items.map((item) => classifyRetryItemNode(item, nowIso)),
    interpret: (response) => {
      const r = response as { items?: unknown };
      if (!r || typeof r !== "object" || !Array.isArray(r.items)
        || r.items.length !== input.items.length) {
        throw new WorkflowCoreContractError("workflow_core_classify_retry_batch_bad_shape");
      }
      return r.items.map((raw, index) => interpretRetryItem(raw, input.items[index]!.id));
    },
  });
}
