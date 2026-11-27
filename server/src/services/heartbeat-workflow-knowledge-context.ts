import type { Db } from "@paperclipai/db";
import { knowledgeService } from "./knowledge/base.js";
import { buildAgentKbTocContext } from "./knowledge/kb-nodes.js";
import { buildWorkflowStepGraphContext } from "./data-graph/workflow-context-adapter.js";
import type { LogicalGraphNodeKind } from "./data-graph/logical-graph.js";

export type WorkflowStepKnowledgeContext = {
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  knowledgeBaseIds: string[];
  entries: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    tokenCount: number;
    content: string;
    error?: string;
  }>;
};

export function buildWorkflowKnowledgeQuery(input: {
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
  taskKey: string | null;
  stepName: string;
}) {
  return [
    input.stepName ? `Workflow step: ${input.stepName}` : null,
    input.issueTitle ? `Issue title: ${input.issueTitle}` : null,
    input.issueDescription ? `Issue description: ${input.issueDescription}` : null,
    input.note ? `Operator note: ${input.note}` : null,
    input.taskKey ? `Task key: ${input.taskKey}` : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

export async function resolveWorkflowStepKnowledgeContext(input: {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string | null;
  taskKey: string | null;
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
}): Promise<WorkflowStepKnowledgeContext | null> {
  if (!input.issueId) return null;

  const { workflowService } = await import("./workflow/engine.js");
  const contract = await workflowService.getStepExecutionContractForIssue(input.db, input.issueId);
  if (!contract || contract.knowledgeBaseIds.length === 0) return null;

  const accessibleKnowledgeBases = await knowledgeService.listAccessible(
    input.db,
    input.agentId,
    input.companyId,
  );
  const knowledgeBaseById = new Map(accessibleKnowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]));
  const missingKnowledgeBaseIds = contract.knowledgeBaseIds.filter((knowledgeBaseId) => !knowledgeBaseById.has(knowledgeBaseId));

  if (missingKnowledgeBaseIds.length > 0) {
    throw Object.assign(
      new Error(
        `Workflow step "${contract.stepName}" has an invalid knowledge contract (missing or inaccessible KBs: ${missingKnowledgeBaseIds.join(", ")})`,
      ),
      {
        code: "workflow_step_kb_contract_invalid",
      },
    );
  }

  const query = buildWorkflowKnowledgeQuery({
    issueTitle: input.issueTitle,
    issueDescription: input.issueDescription,
    note: input.note,
    taskKey: input.taskKey,
    stepName: contract.stepName,
  });

  const entries = await Promise.all(
    contract.knowledgeBaseIds.map(async (knowledgeBaseId) => {
      const knowledgeBase = knowledgeBaseById.get(knowledgeBaseId)!;
      const retrieval = await knowledgeService.retrieve(input.db, {
        kbId: knowledgeBaseId,
        agentId: input.agentId,
        query,
        maxTokens: knowledgeBase.maxTokenBudget,
      });

      return {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        type: knowledgeBase.type,
        source: retrieval.source,
        tokenCount: retrieval.tokenCount,
        content: retrieval.content,
        ...(retrieval.error ? { error: retrieval.error } : {}),
      };
    }),
  );

  return {
    workflowRunId: contract.workflowRunId,
    workflowId: contract.workflowId,
    stepId: contract.stepId,
    stepName: contract.stepName,
    knowledgeBaseIds: contract.knowledgeBaseIds,
    entries,
  };
}

export type AppendOptionalDataGraphContextOptions = {
  companyId: string;
  seedKind: LogicalGraphNodeKind;
  seedId: string;
  existingMarkdown: string;
  /** 명시적 opt-in. false(기본)면 그래프 질의 없이 existingMarkdown을 그대로 돌려준다. */
  enabled?: boolean;
  maxHops?: number;
  maxChars?: number;
};

/**
 * 워크플로 스텝 마크다운 뒤에 데이터 그래프 관련 컨텍스트 블록을 선택적으로 덧붙인다.
 * [계약] enabled=false(기본)는 질의 없이 existingMarkdown을 그대로 반환한다(기존 동작 보존).
 *   opt-in이어도 그래프 fact가 0이면 블록이 비어 fail-open으로 existingMarkdown을
 *   byte-for-byte 그대로 돌려준다(zero prompt bloat). 붙일 때는 adapter가 만든
 *   provenance 인용 블록을 재가공 없이 "\n\n" 구분자로 덧붙이며 블록 예산(maxChars)은
 *   adapter 계약을 따른다. 그래프 질의의 DB 오류는 삼키지 않고 전파한다.
 */
export async function appendOptionalDataGraphContext(
  db: Db,
  options: AppendOptionalDataGraphContextOptions,
): Promise<string> {
  if (!options.enabled) return options.existingMarkdown;
  const graph = await buildWorkflowStepGraphContext(db, {
    companyId: options.companyId,
    seedKind: options.seedKind,
    seedId: options.seedId,
    maxHops: options.maxHops,
    maxChars: options.maxChars,
  });
  if (graph.markdown.length === 0) return options.existingMarkdown;
  return `${options.existingMarkdown}\n\n${graph.markdown}`;
}

/** Lightweight L0 Tree TOC briefing for agents with KB grants (avoids dumping full static blobs or list-all). */
export async function resolveAgentKbTocBriefing(input: {
  db: Db;
  companyId: string;
  agentId: string;
  maxTokens?: number;
}) {
  const toc = await buildAgentKbTocContext(input.db, {
    companyId: input.companyId,
    agentId: input.agentId,
    maxTokens: input.maxTokens ?? 380,
  });
  return toc.nodeCount > 0 ? toc : null;
}
