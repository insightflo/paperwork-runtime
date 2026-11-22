// [파일 목적] 계층형 KB 트리·검색·노드 상세·lint·공인 토글 API 클라이언트.
// [외부 연결] ui/src/components/KbTreePanel.tsx, server/src/routes/knowledge-bases.ts.
import { api } from "./client";

export interface KbSourceRefDto {
  type: string;
  id: string;
  label: string;
  url?: string;
  updatedAt: string;
}

export interface KbTreeNodeDto {
  id: string;
  kbId: string;
  parentId: string | null;
  slug: string;
  title: string;
  summary: string;
  nodeType: string;
  certified: boolean;
  status: string;
  tags: string[];
  linkedNodeIds: string[];
  updatedAt: string;
}

export interface KbTreeItemDto {
  id: string;
  name: string;
  type: string;
  description: string;
  grantCount: number;
  nodes: KbTreeNodeDto[];
}

export interface CompanyKbTreeDto {
  knowledgeBases: KbTreeItemDto[];
  totalNodes: number;
  truncated: boolean;
}

export interface KbSearchHitDto {
  id: string;
  kbId: string;
  kbName: string;
  slug: string;
  title: string;
  summary: string;
  nodeType: string;
  certified: boolean;
  snippet: string;
  sourceRefs: KbSourceRefDto[];
  score: number;
}

export interface KbNeighborDto {
  id: string;
  title: string;
  summary: string;
  nodeType: string;
  certified: boolean;
}

export interface KbNodeDetailDto {
  id: string;
  kbId: string;
  kbName: string;
  parentId: string | null;
  slug: string;
  title: string;
  summary: string;
  content: string;
  nodeType: string;
  certified: boolean;
  tags: string[];
  sourceRefs: KbSourceRefDto[];
  updatedAt: string;
  children: KbNeighborDto[];
  linkedNodes: KbNeighborDto[];
}

export interface KbLintFindingDto {
  nodeId: string;
  kbId: string;
  code: string;
  detail: string;
}

export interface KbLintResultDto {
  scannedCount: number;
  truncated?: boolean;
  findings: KbLintFindingDto[];
  staleRetireCandidateIds: string[];
  retiredIds: string[];
}

export const knowledgeBasesApi = {
  tree: (companyId: string): Promise<CompanyKbTreeDto> =>
    api.get<CompanyKbTreeDto>(`/companies/${companyId}/knowledge-bases/tree`),
  search: (companyId: string, q: string, limit = 8): Promise<{ hits: KbSearchHitDto[] }> =>
    api.get<{ hits: KbSearchHitDto[] }>(
      `/companies/${companyId}/knowledge-bases/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  readNode: (companyId: string, nodeId: string): Promise<KbNodeDetailDto> =>
    api.get<KbNodeDetailDto>(`/companies/${companyId}/knowledge-bases/nodes/${nodeId}`),
  lint: (companyId: string, opts?: { staleDays?: number; autoRetire?: boolean }): Promise<KbLintResultDto> =>
    api.post<KbLintResultDto>(`/companies/${companyId}/knowledge-bases/lint`, opts ?? { autoRetire: false }),
  setCertified: (companyId: string, nodeId: string, certified: boolean): Promise<{ id: string; certified: boolean }> =>
    api.patch<{ id: string; certified: boolean }>(
      `/companies/${companyId}/knowledge-bases/nodes/${nodeId}/certified`,
      { certified },
    ),
};
