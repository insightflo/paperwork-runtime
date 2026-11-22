// [파일 목적] 계층형 KB 노드(knowledge_nodes) 서비스:
//   - L0 목차(TOC) 경량 생성 (토큰 예산 엄격 제한, 전체조회 방지)
//   - L1 Vectorless 근거 검색 (SAG-Wiki 스타일 증거 점수 + 공인 boost, limit <= 8)
//   - 1-hop 노드 조회 (children/linkedNodes 각 12개 상한)
//   - 안전한 소유권 검증 기반 upsert + activityLog 감사 기록
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { activityLog, agentKbGrants, knowledgeBases, knowledgeNodes, type Db, type KnowledgeNodeSourceRef } from "@paperclipai/db";
import { badRequest, notFound } from "../../errors.js";

const MAX_SEARCH_LIMIT = 8;
const MAX_ONE_HOP_NEIGHBORS = 12;
const MAX_TOP_LEVEL_PER_KB = 12;
const MAX_SUMMARY_CHARS = 100;
const MAX_SNIPPET_CHARS = 180;

export interface KbSearchHit {
  id: string; kbId: string; kbName: string; slug: string; title: string;
  summary: string; nodeType: string; certified: boolean; snippet: string;
  sourceRefs: KnowledgeNodeSourceRef[]; score: number;
}

export interface KbNodeDetail {
  id: string; kbId: string; kbName: string; parentId: string | null; slug: string;
  title: string; summary: string; content: string; nodeType: string; certified: boolean;
  tags: string[]; sourceRefs: KnowledgeNodeSourceRef[]; updatedAt: string;
  children: Array<{ id: string; title: string; summary: string; nodeType: string; certified: boolean }>;
  linkedNodes: Array<{ id: string; title: string; summary: string; nodeType: string; certified: boolean }>;
}

export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  for (const part of query.toLowerCase().split(/[\s,./:;!?()[\]{}"'`|_-]+/)) {
    if (part.length >= 2) seen.add(part);
  }
  return Array.from(seen).slice(0, 12);
}

export function scoreKbNode(
  node: { slug: string; title: string; summary: string; content: string; tags: string[]; nodeType: string; certified: boolean },
  queryTokens: string[],
): { score: number; snippet: string } {
  if (queryTokens.length === 0) return { score: 0, snippet: "" };
  const titleL = node.title.toLowerCase();
  const slugL = node.slug.toLowerCase();
  const summaryL = node.summary.toLowerCase();
  const contentL = node.content.toLowerCase();
  const tagsL = node.tags.map((t) => t.toLowerCase());

  let matchScore = 0;
  let firstHitIdx = -1;
  for (const tok of queryTokens) {
    if (titleL.includes(tok) || slugL.includes(tok)) matchScore += 4;
    if (tagsL.some((t) => t.includes(tok))) matchScore += 3;
    if (summaryL.includes(tok)) matchScore += 2;
    const idx = contentL.indexOf(tok);
    if (idx !== -1) {
      matchScore += 1;
      if (firstHitIdx === -1) firstHitIdx = idx;
    }
  }
  if (matchScore === 0) return { score: 0, snippet: "" };
  const boost = (node.certified ? 2 : 0) + (node.nodeType === "glossary" ? 1 : 0);
  const start = firstHitIdx > 30 ? firstHitIdx - 30 : 0;
  const rawSnippet = node.content
    ? node.content.slice(start, start + MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim()
    : node.summary.slice(0, MAX_SNIPPET_CHARS);
  return { score: matchScore + boost, snippet: rawSnippet };
}

export function renderAgentKbToc(
  kbs: Array<{ id: string; name: string; nodes: Array<{ id: string; title: string; summary: string; certified: boolean }> }>,
  companyId: string,
  maxTokens = 380,
): { kbCount: number; nodeCount: number; tokenCount: number; content: string } {
  if (kbs.length === 0) return { kbCount: 0, nodeCount: 0, tokenCount: 0, content: "" };
  const maxChars = Math.max(200, maxTokens * 4);
  const lines: string[] = [
    "## Knowledge Base Index (L0 TOC)",
    `Use \`GET /api/companies/${companyId}/knowledge-bases/search?q=<terms>\` or \`/nodes/<id>\` (never list-all).`,
  ];
  let usedChars = lines.join("\n").length;
  let nodeCount = 0;
  let kbCount = 0;

  for (const kb of kbs) {
    const header = `\n### ${kb.name}`;
    if (usedChars + header.length > maxChars) break;
    lines.push(header);
    usedChars += header.length;
    kbCount += 1;
    for (const n of kb.nodes.slice(0, MAX_TOP_LEVEL_PER_KB)) {
      const sum = n.summary.trim().slice(0, MAX_SUMMARY_CHARS);
      const badge = n.certified ? "★" : "•";
      const line = `- ${badge} [${n.id}] ${n.title}${sum ? ` — ${sum}` : ""}`;
      if (usedChars + line.length + 1 > maxChars) break;
      lines.push(line);
      usedChars += line.length + 1;
      nodeCount += 1;
    }
  }
  const content = lines.join("\n").trim();
  return { kbCount, nodeCount, tokenCount: Math.ceil(content.length / 4), content };
}

async function resolveAccessibleKbs(db: Db, companyId: string, agentId?: string) {
  if (agentId) {
    const rows = await db
      .select({ id: knowledgeBases.id, name: knowledgeBases.name })
      .from(agentKbGrants)
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, agentKbGrants.kbId))
      .where(and(eq(agentKbGrants.agentId, agentId), eq(knowledgeBases.companyId, companyId)))
      .orderBy(asc(knowledgeBases.name));
    return rows;
  }
  return db
    .select({ id: knowledgeBases.id, name: knowledgeBases.name })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.companyId, companyId))
    .orderBy(asc(knowledgeBases.name));
}

export async function searchKbNodes(
  db: Db,
  input: { companyId: string; agentId?: string; query: string; kbId?: string; limit?: number },
): Promise<KbSearchHit[]> {
  const tokens = tokenizeQuery(input.query);
  if (tokens.length === 0) throw badRequest("q must contain at least one search term (min 2 chars)");
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 5), 1), MAX_SEARCH_LIMIT);

  const accessible = await resolveAccessibleKbs(db, input.companyId, input.agentId);
  const filteredKbs = input.kbId ? accessible.filter((k) => k.id === input.kbId) : accessible;
  if (filteredKbs.length === 0) return [];

  const kbNameById = new Map(filteredKbs.map((k) => [k.id, k.name]));
  const rows = await db
    .select()
    .from(knowledgeNodes)
    .where(and(
      eq(knowledgeNodes.companyId, input.companyId),
      inArray(knowledgeNodes.kbId, filteredKbs.map((k) => k.id)),
      eq(knowledgeNodes.status, "active"),
    ))
    .orderBy(desc(knowledgeNodes.certified), desc(knowledgeNodes.updatedAt))
    .limit(200);

  return rows
    .map((r) => {
      const { score, snippet } = scoreKbNode(r, tokens);
      return {
        id: r.id, kbId: r.kbId, kbName: kbNameById.get(r.kbId) ?? "", slug: r.slug, title: r.title,
        summary: r.summary, nodeType: r.nodeType, certified: r.certified, snippet,
        sourceRefs: Array.isArray(r.sourceRefs) ? r.sourceRefs : [], score,
      };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function readKbNode(
  db: Db,
  input: { companyId: string; agentId?: string; nodeId: string },
): Promise<KbNodeDetail | null> {
  const accessible = await resolveAccessibleKbs(db, input.companyId, input.agentId);
  if (accessible.length === 0) return null;
  const kbNameById = new Map(accessible.map((k) => [k.id, k.name]));

  const [node] = await db.select().from(knowledgeNodes).where(and(
    eq(knowledgeNodes.id, input.nodeId),
    eq(knowledgeNodes.companyId, input.companyId),
    inArray(knowledgeNodes.kbId, accessible.map((k) => k.id)),
    eq(knowledgeNodes.status, "active"),
  )).limit(1);
  if (!node) return null;

  const neighborCols = {
    id: knowledgeNodes.id, title: knowledgeNodes.title, summary: knowledgeNodes.summary,
    nodeType: knowledgeNodes.nodeType, certified: knowledgeNodes.certified,
  };
  const [children, linkedNodes] = await Promise.all([
    db.select(neighborCols).from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.companyId, input.companyId), eq(knowledgeNodes.kbId, node.kbId), eq(knowledgeNodes.parentId, node.id), eq(knowledgeNodes.status, "active")))
      .orderBy(desc(knowledgeNodes.certified), asc(knowledgeNodes.title)).limit(MAX_ONE_HOP_NEIGHBORS),
    node.linkedNodeIds.length > 0
      ? db.select(neighborCols).from(knowledgeNodes)
          .where(and(eq(knowledgeNodes.companyId, input.companyId), inArray(knowledgeNodes.kbId, accessible.map((k) => k.id)), inArray(knowledgeNodes.id, node.linkedNodeIds.slice(0, MAX_ONE_HOP_NEIGHBORS)), eq(knowledgeNodes.status, "active")))
          .limit(MAX_ONE_HOP_NEIGHBORS)
      : Promise.resolve([]),
  ]);

  return {
    id: node.id, kbId: node.kbId, kbName: kbNameById.get(node.kbId) ?? "", parentId: node.parentId,
    slug: node.slug, title: node.title, summary: node.summary, content: node.content,
    nodeType: node.nodeType, certified: node.certified, tags: node.tags,
    sourceRefs: Array.isArray(node.sourceRefs) ? node.sourceRefs : [],
    updatedAt: node.updatedAt.toISOString(), children, linkedNodes,
  };
}

export async function buildAgentKbTocContext(
  db: Db,
  input: { companyId: string; agentId?: string; maxTokens?: number },
) {
  const accessible = await resolveAccessibleKbs(db, input.companyId, input.agentId);
  if (accessible.length === 0) return { kbCount: 0, nodeCount: 0, tokenCount: 0, content: "" };

  const roots = await db
    .select({ id: knowledgeNodes.id, kbId: knowledgeNodes.kbId, title: knowledgeNodes.title, summary: knowledgeNodes.summary, certified: knowledgeNodes.certified })
    .from(knowledgeNodes)
    .where(and(
      eq(knowledgeNodes.companyId, input.companyId),
      inArray(knowledgeNodes.kbId, accessible.map((k) => k.id)),
      isNull(knowledgeNodes.parentId),
      eq(knowledgeNodes.status, "active"),
    ))
    .orderBy(desc(knowledgeNodes.certified), asc(knowledgeNodes.title))
    .limit(100);

  const byKb = new Map<string, typeof roots>();
  for (const r of roots) {
    const list = byKb.get(r.kbId) ?? [];
    list.push(r);
    byKb.set(r.kbId, list);
  }
  return renderAgentKbToc(
    accessible.map((k) => ({ id: k.id, name: k.name, nodes: byKb.get(k.id) ?? [] })),
    input.companyId,
    input.maxTokens ?? 380,
  );
}

export async function upsertKbNode(
  db: Db,
  input: {
    companyId: string; kbId: string; slug: string; title: string; summary?: string; content?: string;
    parentId?: string | null; nodeType?: string; certified?: boolean; tags?: string[];
    linkedNodeIds?: string[]; sourceRefs?: KnowledgeNodeSourceRef[]; actorId: string;
  },
) {
  const slug = input.slug.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || !input.title.trim()) throw badRequest("slug and title are required");

  return db.transaction(async (tx) => {
    const [kb] = await tx.select({ id: knowledgeBases.id }).from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, input.kbId), eq(knowledgeBases.companyId, input.companyId))).limit(1);
    if (!kb) throw notFound("Knowledge base not found in company");

    if (input.parentId) {
      const [parent] = await tx.select({ id: knowledgeNodes.id }).from(knowledgeNodes)
        .where(and(eq(knowledgeNodes.id, input.parentId), eq(knowledgeNodes.kbId, input.kbId), eq(knowledgeNodes.companyId, input.companyId))).limit(1);
      if (!parent) throw badRequest("parentId must belong to the same knowledge base and company");
    }

    const [existing] = await tx.select({ id: knowledgeNodes.id }).from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.companyId, input.companyId), eq(knowledgeNodes.kbId, input.kbId), eq(knowledgeNodes.slug, slug))).limit(1);

    const now = new Date();
    const values = {
      title: input.title.trim(), summary: (input.summary ?? "").trim(), content: input.content ?? "",
      parentId: input.parentId ?? null, nodeType: input.nodeType ?? "concept",
      certified: input.certified ?? false, tags: input.tags ?? [],
      linkedNodeIds: input.linkedNodeIds ?? [], sourceRefs: input.sourceRefs ?? [], updatedAt: now,
    };

    const [saved] = existing
      ? await tx.update(knowledgeNodes).set(values)
          .where(and(eq(knowledgeNodes.companyId, input.companyId), eq(knowledgeNodes.kbId, input.kbId), eq(knowledgeNodes.id, existing.id)))
          .returning()
      : await tx.insert(knowledgeNodes).values({ companyId: input.companyId, kbId: input.kbId, slug, ...values }).returning();

    await tx.insert(activityLog).values({
      companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "knowledge_node.upserted", entityType: "knowledge_node", entityId: saved.id,
      details: { kbId: input.kbId, slug, mode: existing ? "updated" : "created" },
    });
    return { node: saved, created: !existing };
  });
}
