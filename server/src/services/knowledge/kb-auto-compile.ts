// [파일 목적] 완료 미션 → KB 자동 컴파일(Rust kb-core 경유) + 회사 단위 kb lint + heartbeat TOC 폴백 헬퍼.
// [외부 연결] server/src/routes/knowledge-bases.ts, server/src/services/heartbeat.ts.
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  activityLog,
  agentKbGrants,
  agents,
  issues,
  issueWorkProducts,
  knowledgeBases,
  knowledgeNodes,
  missions,
  type Db,
} from "@paperclipai/db";
import { badRequest, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { compileMissionViaRust, lintNodesViaRust } from "./kb-core-client.js";
import { upsertKbNode } from "./kb-nodes.js";
import { resolveAgentKbTocBriefing } from "../heartbeat-workflow-knowledge-context.js";

const DEFAULT_KB_NAME = "Company Knowledge Base";
const MAX_LINT_NODES = 1000;

function normalizeKbSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** 회사 기본 온톨로지 KB를 보장하고 활성 에이전트 전원에게 읽기 권한(agent_kb_grants)을 멱등 부여한다. */
export async function ensureDefaultCompanyKb(
  db: Db,
  input: { companyId: string; actorId: string; defaultName?: string },
): Promise<{ id: string; name: string; created: boolean }> {
  const [existing] = await db
    .select({ id: knowledgeBases.id, name: knowledgeBases.name })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.companyId, input.companyId), eq(knowledgeBases.type, "ontology")))
    .orderBy(asc(knowledgeBases.createdAt))
    .limit(1);

  let kb = existing;
  let created = false;
  if (!kb) {
    const name = input.defaultName?.trim() || DEFAULT_KB_NAME;
    const [inserted] = await db
      .insert(knowledgeBases)
      .values({
        companyId: input.companyId,
        name,
        type: "ontology",
        description: "Auto-compiled company ontology knowledge base",
      })
      .onConflictDoNothing()
      .returning({ id: knowledgeBases.id, name: knowledgeBases.name });
    if (inserted) {
      kb = inserted;
      created = true;
    } else {
      const [fallback] = await db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.companyId, input.companyId), eq(knowledgeBases.type, "ontology")))
        .orderBy(asc(knowledgeBases.createdAt))
        .limit(1);
      if (!fallback) throw notFound("Unable to resolve company ontology knowledge base");
      kb = fallback;
    }
  }

  const activeAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), ne(agents.status, "terminated")));

  if (activeAgents.length > 0) {
    await db
      .insert(agentKbGrants)
      .values(activeAgents.map((a) => ({
        agentId: a.id,
        kbId: kb.id,
        grantedBy: input.actorId,
      })))
      .onConflictDoNothing();
  }

  return { id: kb.id, name: kb.name, created };
}

/** 완료 미션의 제목·요약·산출물 하이라이트를 Rust kb-core로 결정론 컴파일하여 knowledge_nodes에 upsert한다. */
export async function compileCompletedMissionToKb(
  db: Db,
  input: { companyId: string; missionId: string; kbId?: string; actorId: string },
) {
  const [mission] = await db
    .select({ id: missions.id, title: missions.title, description: missions.description, status: missions.status, completedAt: missions.completedAt, updatedAt: missions.updatedAt })
    .from(missions)
    .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)))
    .limit(1);
  if (!mission) throw notFound("Mission not found in company");
  if (mission.status !== "completed") {
    throw badRequest(`Only completed missions can be compiled to KB (current status: ${mission.status})`);
  }

  const targetKb = input.kbId
    ? await db
        .select({ id: knowledgeBases.id, name: knowledgeBases.name })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, input.kbId), eq(knowledgeBases.companyId, input.companyId)))
        .limit(1)
        .then((rows) => {
          if (!rows[0]) throw notFound("Knowledge base not found in company");
          return rows[0];
        })
    : await ensureDefaultCompanyKb(db, { companyId: input.companyId, actorId: input.actorId });

  const workProducts = await db
    .select({
      title: issueWorkProducts.title,
      summary: issueWorkProducts.summary,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
    .where(and(eq(issues.companyId, input.companyId), eq(issues.missionId, mission.id)))
    .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt))
    .limit(12);

  const highlights: string[] = [];
  if (mission.description?.trim()) {
    highlights.push(mission.description.trim().slice(0, 260));
  }
  for (const wp of workProducts) {
    const line = wp.summary?.trim() ? `${wp.title}: ${wp.summary.trim()}` : wp.title;
    if (line.trim()) highlights.push(line.trim().slice(0, 240));
  }

  const existingNodes = await db
    .select({ id: knowledgeNodes.id, title: knowledgeNodes.title, tags: knowledgeNodes.tags })
    .from(knowledgeNodes)
    .where(and(
      eq(knowledgeNodes.companyId, input.companyId),
      eq(knowledgeNodes.kbId, targetKb.id),
      eq(knowledgeNodes.status, "active"),
    ))
    .orderBy(desc(knowledgeNodes.certified), desc(knowledgeNodes.updatedAt))
    .limit(100);

  const compiled = await compileMissionViaRust({
    schemaVersion: 1,
    missionId: mission.id,
    missionTitle: mission.title,
    completedAt: (mission.completedAt ?? mission.updatedAt).toISOString(),
    url: workProducts.find((w) => w.url)?.url ?? null,
    highlights,
    existingNodes: existingNodes.map((n) => ({
      id: n.id,
      title: n.title,
      tags: Array.isArray(n.tags) ? n.tags : [],
    })),
  });

  // 공인(certified=true) 노드는 자동 컴파일로 덮어쓰지 않는다(upsertKbNode와 동일한 정규화 슬러그로 조회).
  const normalizedSlug = normalizeKbSlug(compiled.slug);
  const [existingSlug] = await db
    .select()
    .from(knowledgeNodes)
    .where(and(
      eq(knowledgeNodes.companyId, input.companyId),
      eq(knowledgeNodes.kbId, targetKb.id),
      eq(knowledgeNodes.slug, normalizedSlug),
    ))
    .limit(1);
  if (existingSlug?.certified) {
    return { kbId: targetKb.id, kbName: targetKb.name, created: false, skippedCertified: true, node: existingSlug };
  }

  const out = await upsertKbNode(db, {
    companyId: input.companyId,
    kbId: targetKb.id,
    slug: compiled.slug,
    title: compiled.title,
    summary: compiled.summary,
    content: compiled.content,
    nodeType: compiled.nodeType,
    certified: false,
    tags: compiled.tags,
    linkedNodeIds: compiled.linkedNodeIds,
    sourceRefs: compiled.sourceRefs,
    actorId: input.actorId,
  });
  return { kbId: targetKb.id, kbName: targetKb.name, created: out.created, skippedCertified: false, node: out.node };
}

/** 회사 전체 knowledge_nodes를 Rust kb-core로 lint하고, autoRetire=true일 때만 미공인 stale 노드를 은퇴시킨다. */
export async function runCompanyKbLint(
  db: Db,
  input: { companyId: string; staleDays?: number; autoRetire?: boolean; actorId: string },
) {
  const rawRows = await db
    .select({
      id: knowledgeNodes.id,
      kbId: knowledgeNodes.kbId,
      parentId: knowledgeNodes.parentId,
      title: knowledgeNodes.title,
      status: knowledgeNodes.status,
      certified: knowledgeNodes.certified,
      linkedNodeIds: knowledgeNodes.linkedNodeIds,
      updatedAt: knowledgeNodes.updatedAt,
    })
    .from(knowledgeNodes)
    .where(eq(knowledgeNodes.companyId, input.companyId))
    .orderBy(desc(knowledgeNodes.updatedAt))
    .limit(MAX_LINT_NODES + 1);

  const truncated = rawRows.length > MAX_LINT_NODES;
  const rows = rawRows.slice(0, MAX_LINT_NODES);

  const linted = await lintNodesViaRust({
    schemaVersion: 1,
    nowEpochMs: Date.now(),
    staleDays: input.staleDays ?? 90,
    nodes: rows.map((r) => ({
      id: r.id,
      kbId: r.kbId,
      parentId: r.parentId,
      title: r.title,
      status: r.status,
      certified: r.certified,
      linkedNodeIds: Array.isArray(r.linkedNodeIds) ? r.linkedNodeIds : [],
      updatedAtEpochMs: r.updatedAt.getTime(),
    })),
  });

  let retiredIds: string[] = [];
  if (input.autoRetire === true && linted.staleRetireCandidateIds.length > 0) {
    retiredIds = await db.transaction(async (tx) => {
      const updated = await tx
        .update(knowledgeNodes)
        .set({ status: "retired", updatedAt: new Date() })
        .where(and(
          eq(knowledgeNodes.companyId, input.companyId),
          inArray(knowledgeNodes.id, linted.staleRetireCandidateIds),
          eq(knowledgeNodes.status, "active"),
          eq(knowledgeNodes.certified, false),
        ))
        .returning({ id: knowledgeNodes.id });
      const ids = updated.map((u) => u.id);
      if (ids.length > 0) {
        await tx.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "user",
          actorId: input.actorId,
          action: "knowledge_node.auto_retired",
          entityType: "knowledge_base",
          entityId: input.companyId,
          details: { count: ids.length, retiredIds: ids, staleDays: input.staleDays ?? 90 },
        });
      }
      return ids;
    });
  }

  return {
    scannedCount: rows.length,
    truncated,
    findings: linted.findings,
    staleRetireCandidateIds: linted.staleRetireCandidateIds,
    retiredIds,
  };
}

/** Heartbeat 실행 컨텍스트에 워크플로 스텝 KB 또는 경량 L0 TOC를 fail-open으로 부착한다. */
export async function applyWorkflowAndAgentKbContext(
  context: Record<string, unknown>,
  workflowStepKnowledgeContext: unknown,
  db: Db,
  companyId: string,
  agentId: string,
  resolver: typeof resolveAgentKbTocBriefing = resolveAgentKbTocBriefing,
): Promise<void> {
  if (workflowStepKnowledgeContext) {
    context.paperclipWorkflowStepKnowledgeContext = workflowStepKnowledgeContext;
    delete context.paperclipAgentKbToc;
    return;
  }
  delete context.paperclipWorkflowStepKnowledgeContext;
  try {
    const briefing = await resolver({ db, companyId, agentId });
    if (briefing) context.paperclipAgentKbToc = briefing;
    else delete context.paperclipAgentKbToc;
  } catch (err) {
    logger.warn({ err, companyId, agentId }, "non-blocking agent KB TOC briefing failed");
    delete context.paperclipAgentKbToc;
  }
}
