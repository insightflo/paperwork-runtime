// [파일 목적] 보드 전용 KB 트리 조회·노드 공인 토글·미션 완료 후 비동기 자동 컴파일 스케줄러.
// [외부 연결] server/src/routes/knowledge-bases.ts, server/src/services/missions/terminal-cleanup-fence.ts.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { activityLog, agentKbGrants, knowledgeBases, knowledgeNodes, type Db } from "@paperclipai/db";
import { badRequest, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { ensureDefaultCompanyKb } from "./kb-auto-compile.js";
import { upsertKbNode } from "./kb-nodes.js";

const MAX_TREE_NODES = 200;
const QUALITY_ROOT_SLUG = "quality-standards-and-pitfalls";

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
      .where(and(eq(knowledgeNodes.companyId, companyId), eq(knowledgeNodes.status, "active")))
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

/** 보드 전용: 활성 지식 노드의 공인(★ certified) 상태를 트랜잭션으로 변경하고 감사 로그를 남긴다. */
export async function setKbNodeCertified(
  db: Db,
  input: { companyId: string; nodeId: string; certified: boolean; actorId: string },
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.id, input.nodeId), eq(knowledgeNodes.companyId, input.companyId)))
      .limit(1);
    if (!existing) throw notFound("Knowledge node not found in company");
    if (existing.status !== "active") {
      throw badRequest("Only active knowledge nodes can be certified or uncertified");
    }
    if (existing.certified === input.certified) return existing;

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

export function canonNodeSlugFor(code: string): string {
  const norm = code.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `canon-${norm || "rule"}`;
}

/** Quality RSI에서 ★ 표준 규약으로 승격된 품질 기준/주의사항을 회사 KB 트리에 단방향·fail-open 반영한다. */
export async function syncPromotedCanonToKb(
  db: Db,
  input: {
    companyId: string;
    patternId: string;
    code: string;
    title: string;
    summary: string;
    whatWorked?: string | null;
    tags?: string[];
  },
): Promise<{ synced: boolean; skippedCertified?: boolean }> {
  try {
    const kb = await ensureDefaultCompanyKb(db, {
      companyId: input.companyId,
      actorId: "system:quality-rsi",
    });

    const [existingRoot] = await db
      .select({ id: knowledgeNodes.id })
      .from(knowledgeNodes)
      .where(and(
        eq(knowledgeNodes.companyId, input.companyId),
        eq(knowledgeNodes.kbId, kb.id),
        eq(knowledgeNodes.slug, QUALITY_ROOT_SLUG),
      ))
      .limit(1);

    const rootId = existingRoot?.id ?? (await upsertKbNode(db, {
      companyId: input.companyId,
      kbId: kb.id,
      slug: QUALITY_ROOT_SLUG,
      title: "품질 기준 및 주의사항 (Quality Standards & Pitfalls)",
      summary: "반복 검증되어 표준 규약으로 확정된 품질 기준·통과 조건·주의사항",
      content: "# 품질 기준 및 주의사항\n\nQuality RSI 및 운영 검증을 통해 확정된 재사용 기준 모음입니다.",
      nodeType: "policy",
      certified: true,
      tags: ["quality-standards", "policy"],
      actorId: "system:quality-rsi",
    })).node.id;

    const slug = canonNodeSlugFor(input.code);
    const lines = [`# ${input.title}`, "", input.summary];
    if (input.whatWorked?.trim()) lines.push("", "## 적용 기준", `- ${input.whatWorked.trim()}`);
    const out = await upsertKbNode(db, {
      companyId: input.companyId,
      kbId: kb.id,
      parentId: rootId,
      slug,
      title: input.title,
      summary: input.summary.slice(0, 180),
      content: lines.join("\n"),
      nodeType: "policy",
      certified: false,
      preserveCertified: true,
      tags: Array.from(new Set(["quality-rsi", "canon", ...(input.tags ?? [])])).slice(0, 8),
      sourceRefs: [{ type: "manual", id: input.patternId, label: input.title, updatedAt: new Date().toISOString() }],
      actorId: "system:quality-rsi",
    });
    return out.skippedCertified ? { synced: false, skippedCertified: true } : { synced: true };
  } catch (err) {
    logger.warn({ err, companyId: input.companyId, patternId: input.patternId }, "non-blocking Quality RSI canon KB sync failed");
    return { synced: false };
  }
}
