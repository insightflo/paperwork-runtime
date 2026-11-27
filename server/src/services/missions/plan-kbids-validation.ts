// server/src/services/missions/plan-kbids-validation.ts
//
// [파일 목적] Pre-PLAN kbIds 가드(RES-12846 예방). 동적 계획 단위의 kbIds 에
//   knowledge_bases.id 대신 knowledge_nodes.id 이 들어오면 PLAN 승인
//   (mission-plan-materialization-preflight)에서 조기 거부한다. 기존에는 이 실수가
//   런타임 step 실행까지 heap-workflow knowledge contract 검사에서야
//   workflow_step_kb_contract_invalid 로 드러났다.
// [수정시 주의] 런타임 검사(heartbeat-workflow-knowledge-context.ts)는 에이전트 KB
//   grant 까지 검사하지만, 이 가드는 계획 시점에 검증 가능한 회사 범위 존재 여부만
//   본다. 메시지 원문 형식(planner 안내문)은 테스트가 고정한다.

import type { Db } from "@paperclipai/db";
import { knowledgeBases, knowledgeNodes } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { readSelectedUnitKnowledgeBaseIds } from "./paqo-workflow-step-helpers.js";

export type PlanStepKbIdsDiagnostic = {
  code: "plan_kbids_node_id" | "plan_kbids_unknown_kb";
  severity: "invalid";
  message: string;
  details: { unitId: string; kbId: string; knowledgeBaseId?: string };
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUnitLabel(unit: Record<string, unknown>): string {
  const id = typeof unit.id === "string" && unit.id.trim() ? unit.id.trim() : null;
  const unitId = typeof unit.unitId === "string" && unit.unitId.trim() ? unit.unitId.trim() : null;
  return id ?? unitId ?? "?";
}

/**
 * Plan-time KB reference validation over declared plan units. Units declaring kbIds
 * (or knowledgeBaseIds/kbRefs variants — same reader the PAQO step generator uses)
 * must reference existing knowledge_bases.id rows of the same company. Only uuid-form
 * references are validated: knowledge_bases.id and knowledge_nodes.id are both uuids
 * (the RES-12846 confusion), while non-uuid symbolic refs ("kb-research-policy") are
 * a legacy reference form that stays pass-through as before this guard:
 * - a knowledge_nodes.id is rejected with the parent knowledgeBaseId so the planner
 *   can fix the reference in one pass;
 * - an id that is neither a KB nor a node (including cross-company ids, which are
 *   invisible to the company-scoped lookups) is rejected as an unknown KB without
 *   disclosing any other company's ownership.
 * Empty result means every declared KB reference is resolvable.
 */
export async function findKnowledgeBaseReferenceErrors(input: {
  db: Db;
  companyId: string;
  units: readonly Record<string, unknown>[];
}): Promise<PlanStepKbIdsDiagnostic[]> {
  const references = input.units
    .map((unit) => ({ unitId: readUnitLabel(unit), kbIds: readSelectedUnitKnowledgeBaseIds(unit) }))
    .filter((reference) => reference.kbIds.length > 0);
  if (references.length === 0) return [];

  const allKbIds = Array.from(new Set(references.flatMap((reference) => reference.kbIds)));
  const queryableKbIds = allKbIds.filter((kbId) => UUID_PATTERN.test(kbId));
  const kbRows = queryableKbIds.length === 0
    ? []
    : await input.db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.companyId, input.companyId), inArray(knowledgeBases.id, queryableKbIds)));
  const knownKbIds = new Set(kbRows.map((row) => row.id));
  const unresolvedKbIds = queryableKbIds.filter((kbId) => !knownKbIds.has(kbId));
  if (unresolvedKbIds.length === 0) return [];

  const nodeRows = await input.db
      .select({ id: knowledgeNodes.id, kbId: knowledgeNodes.kbId })
      .from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.companyId, input.companyId), inArray(knowledgeNodes.id, unresolvedKbIds)));
  const parentKbIdByNodeId = new Map(nodeRows.map((row) => [row.id, row.kbId]));

  const diagnostics: PlanStepKbIdsDiagnostic[] = [];
  for (const { unitId, kbIds } of references) {
    for (const kbId of kbIds) {
      if (knownKbIds.has(kbId)) continue;
      const parentKnowledgeBaseId = parentKbIdByNodeId.get(kbId);
      if (parentKnowledgeBaseId) {
        diagnostics.push({
          code: "plan_kbids_node_id",
          severity: "invalid",
          message: `Step "${unitId}" kbIds must contain knowledge_bases.id, not knowledge_nodes.id `
            + `(found node ${kbId} belonging to knowledge_base ${parentKnowledgeBaseId}). `
            + "Remove the node id from kbIds and reference its owning knowledge_bases.id instead, then resubmit.",
          details: { unitId, kbId, knowledgeBaseId: parentKnowledgeBaseId },
        });
        continue;
      }
      diagnostics.push({
        code: "plan_kbids_unknown_kb",
        severity: "invalid",
        message: `Step "${unitId}" kbIds must contain knowledge_bases.id, but "${kbId}" `
          + "is not an existing knowledge_bases.id for this company. "
          + "Verify the reference and agent KB grants, then resubmit.",
        details: { unitId, kbId },
      });
    }
  }
  return diagnostics;
}
