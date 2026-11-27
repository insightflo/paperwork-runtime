// ui/src/components/DataGraphContextPanel.tsx
//
// [파일 목적] Data Graph 2-hop 탐색 + GraphRAG 컨텍스트 팩 컴팩트 드로어 패널 — GET
//   /companies/:id/data-graph/query의 LogicalDataGraphResult(+ GraphRagContextPack)를
//   hop별 노드 목록과 출처(provenance) 인용 사실 목록으로 렌더링한다.
// [수정 주의] 읽기 전용 표시 전용. onSelectNode는 화면 내비게이션 콜백일 뿐이며 이 패널 출력을
//   실행 권한의 근거로 소비하는 경로를 만들지 않는다. 계약 변경 시 ui/src/api/data-graph.ts·
//   서버 라우트·서비스와 동기화.
import { useQuery } from "@tanstack/react-query";
import { dataGraphApi, type DataGraphQueryNode } from "../api/data-graph";

export interface DataGraphContextPanelProps {
  companyId: string;
  seedKind: string;
  seedId: string;
  maxHops?: 1 | 2;
  includeContextPack?: boolean;
  onSelectNode?: (node: { kind: string; id: string }) => void;
}

type SelectNodeHandler = DataGraphContextPanelProps["onSelectNode"];

const badgeStyle = {
  backgroundColor: "var(--pw-token-accent-soft)",
  color: "var(--pw-token-accent-text)",
} as const;
const statusStyle = {
  backgroundColor: "var(--pw-token-info-soft)",
  color: "var(--pw-token-info-text)",
} as const;
const warnBadgeStyle = {
  backgroundColor: "var(--pw-token-danger-soft)",
  color: "var(--pw-token-danger-text)",
} as const;
const surfaceStyle = {
  borderColor: "var(--pw-token-border)",
  backgroundColor: "var(--pw-token-bg-surface)",
} as const;

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
      style={badgeStyle}
    >
      {kind}
    </span>
  );
}

function NodeRow({ node, onSelectNode }: { node: DataGraphQueryNode; onSelectNode?: SelectNodeHandler }) {
  const label = node.label?.trim() ? node.label : node.id;
  const body = (
    <>
      <KindBadge kind={node.kind} />
      <span className="truncate font-mono text-xs">{label}</span>
      {node.status ? (
        <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={statusStyle}>
          {node.status}
        </span>
      ) : null}
    </>
  );
  if (!onSelectNode) {
    return (
      <div className="flex items-center gap-2 rounded border px-2 py-1" style={{ borderColor: "var(--pw-token-border)" }}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-2 rounded border px-2 py-1 text-left hover:bg-[var(--pw-token-bg-surface-raised)]"
      style={{ borderColor: "var(--pw-token-border)" }}
      onClick={() => onSelectNode({ kind: node.kind, id: node.id })}
    >
      {body}
    </button>
  );
}

function HopGroup({ title, nodes, onSelectNode }: { title: string; nodes: DataGraphQueryNode[]; onSelectNode?: SelectNodeHandler }) {
  if (nodes.length === 0) return null;
  return (
    <div className="mt-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="mt-1 flex flex-col gap-1">
        {nodes.map((node) => (
          <li key={`${node.kind}:${node.id}`}>
            <NodeRow node={node} onSelectNode={onSelectNode} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <section aria-busy="true" aria-label="Data Graph context loading" className="rounded-lg border p-3" style={surfaceStyle}>
      <div className="h-3 w-1/3 animate-pulse rounded" style={{ backgroundColor: "var(--pw-token-bg-surface-raised)" }} />
      <div className="mt-2 h-3 w-2/3 animate-pulse rounded" style={{ backgroundColor: "var(--pw-token-bg-surface-raised)" }} />
      <div className="mt-2 h-3 w-1/2 animate-pulse rounded" style={{ backgroundColor: "var(--pw-token-bg-surface-raised)" }} />
    </section>
  );
}

function EmptyPanel() {
  return (
    <section aria-label="Data Graph context empty" className="rounded-lg border p-3 text-xs text-muted-foreground" style={surfaceStyle}>
      연결된 2-hop 관계가 없습니다
    </section>
  );
}

export function DataGraphContextPanel({
  companyId,
  seedKind,
  seedId,
  maxHops = 2,
  includeContextPack = false,
  onSelectNode,
}: DataGraphContextPanelProps) {
  const disabled = !companyId || !seedKind || !seedId;
  const query = useQuery({
    queryKey: ["data-graph-query", companyId, seedKind, seedId, maxHops, includeContextPack],
    queryFn: () =>
      dataGraphApi.queryDataGraph(companyId, {
        seed: `${seedKind}:${seedId}`,
        maxHops,
        includeContextPack,
      }),
    enabled: !disabled,
  });

  if (disabled) return <EmptyPanel />;
  if (query.isPending) return <PanelSkeleton />;
  if (query.isError) {
    return (
      <section aria-label="Data Graph context error" className="rounded-lg border p-3" style={surfaceStyle}>
        <p className="text-xs text-muted-foreground">Data Graph 탐색에 실패했습니다.</p>
        <button
          type="button"
          className="mt-2 cursor-pointer rounded px-2 py-1 text-xs"
          style={badgeStyle}
          onClick={() => void query.refetch()}
        >
          다시 시도
        </button>
      </section>
    );
  }

  const data = query.data;
  if (!data) return <EmptyPanel />;
  const oneHop = data.nodes.filter((node) => node.hop === 1);
  const twoHop = data.nodes.filter((node) => node.hop === 2);
  const pack = data.contextPack;
  if (oneHop.length === 0 && twoHop.length === 0) return <EmptyPanel />;

  return (
    <section aria-label="Data Graph context" className="rounded-lg border p-3" style={surfaceStyle}>
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold">Data Graph 컨텍스트</h3>
        <span className="font-mono text-[10px] text-muted-foreground">
          {data.seed.kind}:{data.seed.id}
        </span>
        {data.truncated ? (
          <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={warnBadgeStyle}>
            탐색 생략 있음
          </span>
        ) : null}
      </header>
      <HopGroup title="1-hop" nodes={oneHop} onSelectNode={onSelectNode} />
      <HopGroup title="2-hop" nodes={twoHop} onSelectNode={onSelectNode} />
      {pack ? (
        <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--pw-token-border)" }}>
          <div className="flex items-center gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">컨텍스트 팩</h4>
            {pack.truncated ? (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={warnBadgeStyle}>
                일부 생략됨
              </span>
            ) : null}
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{pack.charCount}자</span>
          </div>
          {pack.facts.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {pack.facts.map((fact, index) => (
                <li key={`${index}:${fact.slice(0, 24)}`} className="text-muted-foreground">
                  {fact}
                </li>
              ))}
            </ul>
          ) : null}
          {pack.provenance.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {pack.provenance.map((entry, index) => (
                <li
                  key={`${entry.nodeType}:${entry.nodeId}:${index}`}
                  className="font-mono text-[10px] text-muted-foreground"
                >
                  출처[{index + 1}] {entry.nodeType}:{entry.nodeId} via {entry.viaEdge} (hop {entry.hop})
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
