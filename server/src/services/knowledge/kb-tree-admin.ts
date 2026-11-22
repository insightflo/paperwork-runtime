// [파일 목적] 보드 전용 KB 트리 조회·노드 공인 토글·미션 완료 후 비동기 자동 컴파일 스케줄러.
// [외부 연결] server/src/routes/knowledge-bases.ts, server/src/services/missions/terminal-cleanup-fence.ts.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { activityLog, agentKbGrants, knowledgeBases, knowledgeNodes, type Db } from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { compileCompletedMissionToKb } from "./kb-auto-compile.js";

const MAX_TREE_NODES = 200;

export interface KbTreeNodeSummary {
  id: string; kbId: string; parentId: string | null; slug: string; title: string;
  summary: string; nodeType: string; certified: boolean; status: string;
  tags: string[]; linkedNodeIds: string[]; updatedAt: string;
}

export interface KbTreeItem {
  id: string; name: string; type: string; description: string;
  grantCount: number; nodes: KbTreeNodeSummary[];
}

export interface CompanyKbTreeResponse {
  knowledgeBases: KbTreeItem[];
  totalNodes: number;
  truncated: boolean;
}

/** 보드 대시보드 전용: 회사의 KB 목록·권한 수·노드 트리 메타데이터(최대 200개 + truncated 플래그) 반환. */
export async function listCompanyKbTree(db: Db, companyId: string): Promise<CompanyKbTreeResponse> {
  const [kbs, grantCounts, rawNodes] = await Promise.all([
    db.select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      type: knowledgeBases.type,
      description: knowledgeBases.description,
    })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.companyId, companyId))
      .orderBy(asc(knowledgeBases.name)),
    db.select({
      kbId: agentKbGrants.kbId,
      count: sql<number>`count(*)::int`,
    })
      .from(agentKbGrants)
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, agentKbGrants.kbId))
      .where(eq(knowledgeBases.companyId, companyId))
      .groupBy(agentKbGrants.kbId),
    db.select({
      id: knowledgeNodes.id,
      kbId: knowledgeNodes.kbId,
      parentId: knowledgeNodes.parentId,
      slug: knowledgeNodes.slug,
      title: knowledgeNodes.title,
      summary: knowledgeNodes.summary,
      nodeType: knowledgeNodes.nodeType,
      certified: knowledgeNodes.certified,
      status: knowledgeNodes.status,
      tags: knowledgeNodes.tags,
      linkedNodeIds: knowledgeNodes.linkedNodeIds,
      updatedAt: knowledgeNodes.updatedAt,
    })
      .from(knowledgeNodes)
      .where(eq(knowledgeNodes.companyId, companyId))
      .orderBy(desc(knowledgeNodes.certified), desc(knowledgeNodes.updatedAt), asc(knowledgeNodes.title))
      .limit(MAX_TREE_NODES + 1),
  ]);

  const truncated = rawNodes.length > MAX_TREE_NODES;
  const nodes = rawNodes.slice(0, MAX_TREE_NODES);
  const grantsByKb = new Map(grantCounts.map((g) => [g.kbId, Number(g.count ?? 0)]));
  const nodesByKb = new Map<string, KbTreeNodeSummary[]>();

  for (const n of nodes) {
    const list = nodesByKb.get(n.kbId) ?? [];
    list.push({
      id: n.id,
      kbId: n.kbId,
      parentId: n.parentId,
      slug: n.slug,
      title: n.title,
      summary: n.summary,
      nodeType: n.nodeType,
      certified: n.certified,
      status: n.status,
      tags: Array.isArray(n.tags) ? n.tags : [],
      linkedNodeIds: Array.isArray(n.linkedNodeIds) ? n.linkedNodeIds : [],
      updatedAt: n.updatedAt.toISOString(),
    });
    nodesByKb.set(n.kbId, list);
  }

  return {
    knowledgeBases: kbs.map((kb) => ({
      ...kb,
      grantCount: grantsByKb.get(kb.id) ?? 0,
      nodes: nodesByKb.get(kb.id) ?? [],
    })),
    totalNodes: nodes.length,
    truncated,
  };
}

/** 보드 전용: 지식 노드의 공인(★ certified) 상태를 트랜잭션으로 변경하고 감사 로그를 남긴다. */
export async function setKbNodeCertified(
  db: Db,
  input: { companyId: string; nodeId: string; certified: boolean; actorId: string },
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(knowledgeNodes)
      .set({ certified: input.certified, updatedAt: new Date() })
      .where(and(eq(knowledgeNodes.id, input.nodeId), eq(knowledgeNodes.companyId, input.companyId)))
      .returning();
    if (!updated) throw notFound("Knowledge node not found in company");

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorId,
      action: "knowledge_node.certified_updated",
      entityType: "knowledge_node",
      entityId: updated.id,
      details: { kbId: updated.kbId, slug: updated.slug, certified: input.certified },
    });
    return updated;
  });
}

/** 미션이 completed로 확정(post-commit)된 경우에만 비동기·fail-open으로 KB 자동 컴파일을 실행한다. */
export function scheduleMissionKbAutoCompileIfCompleted(
  db: Db,
  input: { companyId: string; missionId: string; status: "completed" | "cancelled" },
  compiler: typeof compileCompletedMissionToKb = compileCompletedMissionToKb,
): Promise<void> | null {
  if (input.status !== "completed") return null;
  const p = Promise.resolve()
    .then(() => compiler(db, {
      companyId: input.companyId,
      missionId: input.missionId,
      actorId: "system:mission-auto-compile",
    }))
    .then(() => undefined)
    .catch((err) => {
      logger.warn(
        { err, companyId: input.companyId, missionId: input.missionId },
        "non-blocking mission KB auto-compile failed",
      );
    });
  void p;
  return p;
}
