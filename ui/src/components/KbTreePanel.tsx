// [파일 목적] 에이전트 지식베이스(KB) 트리 탐색·Rust 근거 검색·lint 점검·노드 공인 토글 패널.
// [외부 연결] ui/src/pages/AgentWiki.tsx, ui/src/api/knowledgeBases.ts.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookMarked, CheckCircle2, FolderTree, Search, ShieldCheck, Star } from "lucide-react";
import {
  knowledgeBasesApi,
  type KbLintResultDto,
  type KbTreeNodeDto,
} from "../api/knowledgeBases";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface KbTreePanelProps {
  companyId: string;
}

export function KbTreePanel({ companyId }: KbTreePanelProps) {
  const lang = useCompanyLanguage();
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [lintResult, setLintResult] = useState<KbLintResultDto | null>(null);
  const [lintError, setLintError] = useState<string | null>(null);
  const [certError, setCertError] = useState<string | null>(null);

  const trimmedQuery = searchText.trim();
  const { data: tree, isLoading, isError, error } = useQuery({
    queryKey: ["kb-tree", companyId],
    queryFn: () => knowledgeBasesApi.tree(companyId),
    enabled: Boolean(companyId),
  });

  const { data: searchData, isFetching: isSearching, isError: isSearchError, error: searchError } = useQuery({
    queryKey: ["kb-search", companyId, trimmedQuery],
    queryFn: () => knowledgeBasesApi.search(companyId, trimmedQuery, 8),
    enabled: Boolean(companyId) && trimmedQuery.length >= 2,
  });

  const { data: nodeDetail, isLoading: isNodeLoading, isError: isNodeError, error: nodeError } = useQuery({
    queryKey: ["kb-node", companyId, selectedNodeId],
    queryFn: () => knowledgeBasesApi.readNode(companyId, selectedNodeId!),
    enabled: Boolean(companyId && selectedNodeId),
  });

  const lintMutation = useMutation({
    mutationFn: () => knowledgeBasesApi.lint(companyId, { autoRetire: false }),
    onMutate: () => setLintError(null),
    onSuccess: (res) => setLintResult(res),
    onError: (err) => setLintError((err as Error)?.message ?? "Lint failed"),
  });

  const certifyMutation = useMutation({
    mutationFn: (vars: { nodeId: string; certified: boolean }) =>
      knowledgeBasesApi.setCertified(companyId, vars.nodeId, vars.certified),
    onMutate: () => setCertError(null),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["kb-tree", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["kb-node", companyId, vars.nodeId] });
      void queryClient.invalidateQueries({ queryKey: ["kb-search", companyId] });
    },
    onError: (err) => setCertError((err as Error)?.message ?? "Update failed"),
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{L(lang, { en: "Loading KB tree…", ko: "KB 트리 불러오는 중…" })}</p>;
  }
  if (isError) {
    return (
      <p className="text-sm text-red-400">
        {L(lang, { en: "Failed to load KB tree", ko: "KB 트리 조회 실패" })}: {(error as Error)?.message ?? "unknown"}
      </p>
    );
  }

  const kbs = tree?.knowledgeBases ?? [];
  const renderNodes = (nodes: KbTreeNodeDto[], parentId: string | null, depth: number, visited = new Set<string>()) =>
    nodes
      .filter((n) => n.parentId === parentId && !visited.has(n.id))
      .map((node) => {
        const nextVisited = new Set(visited);
        nextVisited.add(node.id);
        return (
          <div key={node.id} style={{ paddingLeft: depth * 14 }}>
            <button
              type="button"
              onClick={() => setSelectedNodeId(node.id)}
              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs transition hover:bg-muted/60 ${
                selectedNodeId === node.id ? "bg-muted font-medium" : ""
              }`}
            >
              <span className="flex items-center gap-1.5 truncate">
                {node.certified ? <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" /> : <BookMarked className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="truncate">{node.title}</span>
              </span>
              <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{node.nodeType}</span>
            </button>
            {renderNodes(nodes, node.id, depth + 1, nextVisited)}
          </div>
        );
      });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={L(lang, { en: "Search KB nodes (min 2 chars)…", ko: "KB 근거 검색 (2글자 이상)…" })}
            className="h-8 w-72 pl-7"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={lintMutation.isPending}
            onClick={() => lintMutation.mutate()}
          >
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            {lintMutation.isPending
              ? L(lang, { en: "Linting…", ko: "점검 중…" })
              : L(lang, { en: "Run KB Lint", ko: "KB Lint 점검" })}
          </Button>
        </div>
      </div>

      {lintError && <p className="text-xs text-red-400">{L(lang, { en: "Lint failed", ko: "Lint 점검 실패" })}: {lintError}</p>}

      {lintResult && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="flex items-center gap-2 font-medium">
            {lintResult.findings.length === 0 ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            )}
            <span>
              {L(lang, {
                en: `Lint scanned ${lintResult.scannedCount} nodes · ${lintResult.findings.length} findings · ${lintResult.staleRetireCandidateIds.length} stale`,
                ko: `점검 ${lintResult.scannedCount}개 노드 · 발견 ${lintResult.findings.length}건 · 노후 후보 ${lintResult.staleRetireCandidateIds.length}건`,
              })}
            </span>
          </div>
          {lintResult.findings.length > 0 && (
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {lintResult.findings.slice(0, 8).map((f, idx) => (
                <li key={`${f.nodeId}-${f.code}-${idx}`}>
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => setSelectedNodeId(f.nodeId)}
                  >
                    [{f.code}] {f.detail}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {trimmedQuery.length >= 2 && (
        <div className="rounded-md border p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            {isSearching
              ? L(lang, { en: "Searching…", ko: "검색 중…" })
              : L(lang, {
                  en: `Search results (${searchData?.hits.length ?? 0})`,
                  ko: `근거 검색 결과 (${searchData?.hits.length ?? 0}건)`,
                })}
          </div>
          {isSearchError ? (
            <p className="text-xs text-red-400">{L(lang, { en: "Search failed", ko: "검색 실패" })}: {(searchError as Error)?.message ?? "unknown"}</p>
          ) : !isSearching && (searchData?.hits.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">{L(lang, { en: "No matching nodes.", ko: "일치하는 노드가 없습니다." })}</p>
          ) : (
            <div className="space-y-1.5">
              {(searchData?.hits ?? []).map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => setSelectedNodeId(hit.id)}
                  className="block w-full rounded border px-2.5 py-2 text-left text-xs hover:bg-muted/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{hit.certified ? "★ " : ""}{hit.title}</span>
                    <span className="text-[10px] text-muted-foreground">{hit.kbName} · score {hit.score}</span>
                  </div>
                  {hit.snippet && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{hit.snippet}</p>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {kbs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {L(lang, { en: "No knowledge bases yet for this company.", ko: "이 회사에 등록된 지식베이스가 아직 없습니다." })}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="space-y-3 rounded-md border p-3 lg:col-span-5">
            {tree?.truncated && (
              <p className="text-[11px] text-amber-500">
                {L(lang, { en: "Showing first 200 nodes. Use search for full coverage.", ko: "상위 200개 노드만 표시됩니다. 전체 탐색은 검색을 이용하세요." })}
              </p>
            )}
            {kbs.map((kb) => (
              <div key={kb.id} className="space-y-1">
                <div className="flex items-center justify-between border-b pb-1 text-xs font-semibold">
                  <span className="flex items-center gap-1.5">
                    <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
                    {kb.name}
                  </span>
                  <span className="text-[10px] font-normal text-muted-foreground">
                    {kb.type} · {kb.nodes.length} {L(lang, { en: "nodes", ko: "노드" })} · {kb.grantCount} {L(lang, { en: "agents", ko: "에이전트" })}
                  </span>
                </div>
                {kb.nodes.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">{L(lang, { en: "Empty", ko: "비어 있음" })}</p>
                ) : (
                  renderNodes(kb.nodes, null, 0)
                )}
              </div>
            ))}
          </div>

          <div className="rounded-md border p-4 lg:col-span-7">
            {!selectedNodeId ? (
              <p className="text-xs text-muted-foreground">
                {L(lang, { en: "Select a node from the tree or search results to inspect.", ko: "트리 또는 검색 결과에서 노드를 선택하면 상세 내용을 볼 수 있습니다." })}
              </p>
            ) : isNodeError ? (
              <p className="text-xs text-red-400">
                {L(lang, { en: "Failed to load node", ko: "노드 조회 실패" })}: {(nodeError as Error)?.message ?? "unknown"}
              </p>
            ) : isNodeLoading || !nodeDetail ? (
              <p className="text-xs text-muted-foreground">{L(lang, { en: "Loading node…", ko: "노드 불러오는 중…" })}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{nodeDetail.title}</h3>
                    <p className="text-[11px] text-muted-foreground">
                      {nodeDetail.kbName} · <code>{nodeDetail.slug}</code> · {nodeDetail.nodeType}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={nodeDetail.certified ? "default" : "outline"}
                    disabled={certifyMutation.isPending}
                    onClick={() => certifyMutation.mutate({ nodeId: nodeDetail.id, certified: !nodeDetail.certified })}
                  >
                    <Star className={`mr-1 h-3.5 w-3.5 ${nodeDetail.certified ? "fill-current" : ""}`} />
                    {nodeDetail.certified
                      ? L(lang, { en: "Certified", ko: "공인됨" })
                      : L(lang, { en: "Certify", ko: "공인 지정" })}
                  </Button>
                </div>
                {certError && <p className="text-xs text-red-400">{certError}</p>}
                {nodeDetail.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {nodeDetail.tags.map((t) => (
                      <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">#{t}</span>
                    ))}
                  </div>
                )}
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs leading-relaxed">
                  {nodeDetail.content || nodeDetail.summary}
                </pre>
                {nodeDetail.linkedNodes.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {L(lang, { en: "Linked Nodes", ko: "연결된 노드" })}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {nodeDetail.linkedNodes.map((ln) => (
                        <Button key={ln.id} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setSelectedNodeId(ln.id)}>
                          {ln.certified ? "★ " : ""}{ln.title}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
