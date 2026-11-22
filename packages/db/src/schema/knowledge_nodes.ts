// [파일 목적] 계층형(PageIndex 트리) + 온톨로지(nodeType/certified) + 근거 바인딩(sourceRefs) 지식 노드 테이블.
//   기존 knowledge_bases + agent_kb_grants 위에 얹혀 L0 목차 주입, L1 Vectorless FTS 검색, 1-hop 조회를 지원한다.
// [수정시 주의] 스키마 변경 시 수기 마이그레이션 규약 준수(journal drift — 0096 참조).
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { knowledgeBases } from "./knowledge_bases.js";

export interface KnowledgeNodeSourceRef {
  type: "mission" | "url" | "file" | "pr" | "issue" | "manual";
  id?: string;
  label?: string;
  url?: string;
  updatedAt?: string;
}

export const knowledgeNodes = pgTable(
  "knowledge_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id").notNull().references(() => knowledgeBases.id, { onDelete: "cascade" }),
    // Same-KB parent guard is enforced at the service layer (upsertKbNode).
    parentId: uuid("parent_id").references((): AnyPgColumn => knowledgeNodes.id, { onDelete: "set null" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    content: text("content").notNull().default(""),
    // concept | entity | glossary | fact | index
    nodeType: text("node_type").notNull().default("concept"),
    certified: boolean("certified").notNull().default(false),
    // active | retired
    status: text("status").notNull().default("active"),
    tags: text("tags").array().notNull().default([]),
    // Lightweight 1-hop [[wikilink]] edge list (normalized UUID strings).
    linkedNodeIds: text("linked_node_ids").array().notNull().default([]),
    sourceRefs: jsonb("source_refs").$type<KnowledgeNodeSourceRef[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // App-maintained on every upsert; DB default covers initial insert.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKbIdx: index("idx_knowledge_nodes_company_kb").on(table.companyId, table.kbId),
    kbParentIdx: index("idx_knowledge_nodes_kb_parent").on(table.kbId, table.parentId),
    kbSlugUq: uniqueIndex("knowledge_nodes_kb_id_slug_uq").on(table.kbId, table.slug),
  }),
);
