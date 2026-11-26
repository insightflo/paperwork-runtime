// [파일 목적] 에이전트 지식베이스(KB) 트리 탐색·Rust 근거 검색·lint 점검·노드 공인 토글 패널.
// [외부 연결] ui/src/pages/AgentWiki.tsx, ui/src/api/knowledgeBases.ts.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookMarked, CheckCircle2, FolderTree, Search, ShieldCheck, Star } from "lucide-react";
import { knowledgeBasesApi, type KbLintResultDto, type KbTreeNodeDto } from "../api/knowledgeBases";
import { L, useCompanyLanguage } from "../lib/companyLanguage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface KbTreePanelProps {
  companyId: string;
}

const PANEL =
  "tactile-card rounded-[12px] border border-slate-200/90 bg-white text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const INSET =
  "rounded-[10px] border border-slate-200/80 bg-slate-50/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const CONTROL =
  "h-8 rounded-lg border-slate-200/90 bg-white text-xs text-slate-900 placeholder:text-slate-400 focus-visible:border-blue-500 focus-visible:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:placeholder:text-[#627089] dark:focus-visible:border-[#60a5fa] dark:focus-visible:ring-[#60a5fa]/25";
const OUTLINE_BUTTON =
  "border-slate-200/90 bg-white text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";
const MUTED = "text-slate-500 dark:text-[#8b97ad]";
const ERROR_TEXT = "text-rose-700 dark:text-[#fb7185]";

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
    queryKey: ["kb-tree", companyId], queryFn: () => knowledgeBasesApi.tree(companyId), enabled: Boolean(companyId),
  });

  const { data: searchData, isFetching: isSearching, isError: isSearchError, error: searchError } = useQuery({
    queryKey: ["kb-search", companyId, trimmedQuery], queryFn: () => knowledgeBasesApi.search(companyId, trimmedQuery, 8),
    enabled: Boolean(companyId) && trimmedQuery.length >= 2,
  });

  const { data: nodeDetail, isLoading: isNodeLoading, isError: isNodeError, error: nodeError } = useQuery({
    queryKey: ["kb-node", companyId, selectedNodeId], queryFn: () => knowledgeBasesApi.readNode(companyId, selectedNodeId!),
    enabled: Boolean(companyId && selectedNodeId),
  });

  const lintMutation = useMutation({
    mutationFn: () => knowledgeBasesApi.lint(companyId, { autoRetire: false }), onMutate: () => setLintError(null),
    onSuccess: (res) => setLintResult(res), onError: (err) => setLintError((err as Error)?.message ?? "Lint failed"),
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
    return <p className={cn(PANEL, "px-4 py-3 text-sm", MUTED)}>{L(lang, { en: "Loading KB tree…", ko: "KB 트리 불러오는 중…" })}</p>;
  }
  if (isError) {
    return <p className={cn(PANEL, "px-4 py-3 text-sm", ERROR_TEXT)}>{L(lang, { en: "Failed to load KB tree", ko: "KB 트리 조회 실패" })}: {(error as Error)?.message ?? "unknown"}</p>;
  }

  const kbs = tree?.knowledgeBases ?? [];
  const renderNodes = (nodes: KbTreeNodeDto[], parentId: string | null, depth: number, visited = new Set<string>(), nodeIds = new Set(nodes.map((n) => n.id))) =>
    nodes
      .filter((n) => (parentId === null ? (n.parentId === null || !nodeIds.has(n.parentId)) : n.parentId === parentId) && !visited.has(n.id))
      .map((node) => {
        const nextVisited = new Set(visited);
        nextVisited.add(node.id);
        const selected = selectedNodeId === node.id;
        return (
          <div key={node.id} style={{ paddingLeft: depth * 14 }}>
            <button
              type="button"
              onClick={() => setSelectedNodeId(node.id)}
              className={cn(
                "flex w-full items-center justify-between rounded-[8px] border border-transparent px-2 py-1.5 text-left text-xs transition-[background-color,border-color,color] duration-150 hover:border-slate-200/90 hover:bg-white dark:hover:border-white/[0.08] dark:hover:bg-white/[0.04]",
                selected
                  ? "border-blue-600/25 bg-blue-500/10 font-medium text-blue-800 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#bfdbfe]"
                  : "text-slate-700 dark:text-[#b8c2d6]",
              )}
            >
              <span className="flex items-center gap-1.5 truncate">
                {node.certified ? <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" /> : <BookMarked className="h-3 w-3 shrink-0 text-slate-400 dark:text-[#627089]" />}
                <span className="truncate">{node.title}</span>
              </span>
              <span className={cn("ml-2 shrink-0 rounded-full border border-slate-200/70 bg-white px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] dark:border-white/[0.07] dark:bg-[#07090d]", MUTED)}>{node.nodeType}</span>
            </button>
            {renderNodes(nodes, node.id, depth + 1, nextVisited, nodeIds)}
          </div>
        );
      });

  return (
    <div className="space-y-3 tabular-nums text-slate-900 dark:text-[#edf2fb]">
      <div className={cn(PANEL, "flex flex-wrap items-center justify-between gap-2 px-3 py-2")}>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-[#627089]" />
          <Input
            value={searchText} onChange={(e) => setSearchText(e.target.value)} className={cn(CONTROL, "w-72 pl-7")}
            placeholder={L(lang, { en: "Search KB nodes (min 2 chars)…", ko: "KB 근거 검색 (2글자 이상)…" })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm" variant="outline" className={OUTLINE_BUTTON}
            disabled={lintMutation.isPending} onClick={() => lintMutation.mutate()}
          >
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />
            {lintMutation.isPending
              ? L(lang, { en: "Linting…", ko: "점검 중…" })
              : L(lang, { en: "Run KB Lint", ko: "KB Lint 점검" })}
          </Button>
        </div>
      </div>

      {lintError && <p className={cn("px-1 text-xs", ERROR_TEXT)}>{L(lang, { en: "Lint failed", ko: "Lint 점검 실패" })}: {lintError}</p>}

      {lintResult && (
        <div className={cn(INSET, "border-l-[3px] p-3 text-xs", lintResult.findings.length === 0 ? "border-lime-500/60 dark:border-lime-400/50" : "border-amber-500/60 dark:border-amber-400/50")}>
          <div className="flex items-center gap-2 font-medium text-slate-800 dark:text-[#dbe4f0]">
            {lintResult.findings.length === 0 ? (
              <CheckCircle2 className="h-4 w-4 text-lime-600 dark:text-[#a3e635]" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-[#f59e0b]" />
            )}
            <span>
              {L(lang, {
                en: `Lint scanned ${lintResult.scannedCount} nodes · ${lintResult.findings.length} findings · ${lintResult.staleRetireCandidateIds.length} stale`,
                ko: `점검 ${lintResult.scannedCount}개 노드 · 발견 ${lintResult.findings.length}건 · 노후 후보 ${lintResult.staleRetireCandidateIds.length}건`,
              })}
            </span>
          </div>
          {lintResult.findings.length > 0 && (
            <ul className={cn("mt-2 space-y-1", MUTED)}>
              {lintResult.findings.slice(0, 8).map((f, idx) => (
                <li key={`${f.nodeId}-${f.code}-${idx}`}>
                  <button
                    type="button"
                    className="text-left text-blue-700 underline-offset-2 transition-colors hover:text-blue-600 hover:underline dark:text-[#60a5fa] dark:hover:text-[#93c5fd]"
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
        <div className={cn(PANEL, "p-3")}>
          <div className={cn("mb-2 text-[10px] font-semibold uppercase tracking-[0.12em]", MUTED)}>
            {isSearching
              ? L(lang, { en: "Searching…", ko: "검색 중…" })
              : L(lang, {
                  en: `Search results (${searchData?.hits.length ?? 0})`,
                  ko: `근거 검색 결과 (${searchData?.hits.length ?? 0}건)`,
                })}
          </div>
          {isSearchError ? (
            <p className={cn("text-xs", ERROR_TEXT)}>{L(lang, { en: "Search failed", ko: "검색 실패" })}: {(searchError as Error)?.message ?? "unknown"}</p>
          ) : !isSearching && (searchData?.hits.length ?? 0) === 0 ? (
            <p className={cn("text-xs", MUTED)}>{L(lang, { en: "No matching nodes.", ko: "일치하는 노드가 없습니다." })}</p>
          ) : (
            <div className="space-y-1.5">
              {(searchData?.hits ?? []).map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => setSelectedNodeId(hit.id)}
                  className={cn(INSET, "block w-full px-2.5 py-2 text-left text-xs transition-[background-color,border-color] duration-150 hover:border-blue-500/35 hover:bg-white dark:hover:border-[#60a5fa]/35 dark:hover:bg-[#101724]")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900 dark:text-[#edf2fb]">{hit.certified ? "★ " : ""}{hit.title}</span>
                    <span className={cn("shrink-0 text-[10px] tabular-nums", MUTED)}>{hit.kbName} · score {hit.score}</span>
                  </div>
                  {hit.snippet && <p className={cn("mt-0.5 line-clamp-2", MUTED)}>{hit.snippet}</p>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {kbs.length === 0 ? (
        <p className={cn(PANEL, "px-4 py-3 text-sm", MUTED)}>
          {L(lang, { en: "No knowledge bases yet for this company.", ko: "이 회사에 등록된 지식베이스가 아직 없습니다." })}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-12">
          <div className={cn(PANEL, "space-y-3 p-3 lg:col-span-5")}>
            {tree?.truncated && (
              <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:border-[#f59e0b]/25 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
                {L(lang, { en: "Showing first 200 nodes. Use search for full coverage.", ko: "상위 200개 노드만 표시됩니다. 전체 탐색은 검색을 이용하세요." })}
              </p>
            )}
            {kbs.map((kb) => (
              <div key={kb.id} className={cn(INSET, "space-y-1 p-2")}>
                <div className="flex items-center justify-between border-b border-slate-200/80 pb-1.5 text-xs font-semibold text-slate-900 dark:border-white/[0.07] dark:text-[#edf2fb]">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <FolderTree className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-[#60a5fa]" />
                    <span className="truncate">{kb.name}</span>
                  </span>
                  <span className={cn("ml-2 shrink-0 text-[10px] font-normal tabular-nums", MUTED)}>
                    {kb.type} · {kb.nodes.length} {L(lang, { en: "nodes", ko: "노드" })} · {kb.grantCount} {L(lang, { en: "agents", ko: "에이전트" })}
                  </span>
                </div>
                {kb.nodes.length === 0 ? (
                  <p className={cn("px-2 py-1 text-xs", MUTED)}>{L(lang, { en: "Empty", ko: "비어 있음" })}</p>
                ) : (
                  renderNodes(kb.nodes, null, 0)
                )}
              </div>
            ))}
          </div>

          <div className={cn(PANEL, "p-4 lg:col-span-7")}>
            {!selectedNodeId ? (
              <p className={cn("text-xs", MUTED)}>
                {L(lang, { en: "Select a node from the tree or search results to inspect.", ko: "트리 또는 검색 결과에서 노드를 선택하면 상세 내용을 볼 수 있습니다." })}
              </p>
            ) : isNodeError ? (
              <p className={cn("text-xs", ERROR_TEXT)}>
                {L(lang, { en: "Failed to load node", ko: "노드 조회 실패" })}: {(nodeError as Error)?.message ?? "unknown"}
              </p>
            ) : isNodeLoading || !nodeDetail ? (
              <p className={cn("text-xs", MUTED)}>{L(lang, { en: "Loading node…", ko: "노드 불러오는 중…" })}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200/80 pb-3 dark:border-white/[0.07]">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">{nodeDetail.title}</h3>
                    <p className={cn("mt-0.5 text-[11px]", MUTED)}>
                      {nodeDetail.kbName} · <code className="font-mono text-blue-700 dark:text-[#60a5fa]">{nodeDetail.slug}</code> · {nodeDetail.nodeType}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={nodeDetail.certified ? "default" : "outline"}
                    disabled={certifyMutation.isPending}
                    onClick={() => certifyMutation.mutate({ nodeId: nodeDetail.id, certified: !nodeDetail.certified })}
                    className={nodeDetail.certified
                      ? "border border-lime-700/25 bg-lime-700 text-white hover:bg-lime-600 dark:border-[#a3e635]/45 dark:bg-[#a3e635] dark:text-[#0b0f05] dark:hover:bg-[#bef264]"
                      : OUTLINE_BUTTON}
                  >
                    <Star className={`mr-1 h-3.5 w-3.5 ${nodeDetail.certified ? "fill-current" : "text-amber-500 dark:text-[#f59e0b]"}`} />
                    {nodeDetail.certified
                      ? L(lang, { en: "Certified", ko: "공인됨" })
                      : L(lang, { en: "Certify", ko: "공인 지정" })}
                  </Button>
                </div>
                {certError && <p className={cn("text-xs", ERROR_TEXT)}>{certError}</p>}
                {nodeDetail.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {nodeDetail.tags.map((t) => (
                      <span key={t} className="rounded-md border border-slate-200/80 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:border-white/[0.08] dark:bg-[#07090d] dark:text-[#8b97ad]">#{t}</span>
                    ))}
                  </div>
                )}
                <pre className={cn(INSET, "max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-slate-700 dark:text-[#c6d0df]")}>
                  {nodeDetail.content || nodeDetail.summary}
                </pre>
                {nodeDetail.linkedNodes.length > 0 && (
                  <div className="space-y-1.5 border-t border-slate-200/80 pt-2.5 dark:border-white/[0.07]">
                    <div className={cn("text-[10px] font-semibold uppercase tracking-[0.12em]", MUTED)}>
                      {L(lang, { en: "Linked Nodes", ko: "연결된 노드" })}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {nodeDetail.linkedNodes.map((ln) => (
                        <Button key={ln.id} size="sm" variant="outline" className={cn(OUTLINE_BUTTON, "h-6 px-2 text-[11px]")} onClick={() => setSelectedNodeId(ln.id)}>
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
