// server/src/services/data-graph/graphrag-context-pack.ts
//
// [파일 목적] Two-Graph Pillar 2·3 순수 모듈 — traversal이 넘겨준 노드·엣지를 출처(provenance)
//   인용 컨텍스트 팩으로 직렬화하는 GraphRAG 빌더와 덱의 문제-우선 라우팅 결정 표 가드.
//   DB·기존 서비스 import 금지(순수 함수만) — 상위 계층(data-graph-query 등)이 수집해 넘긴다.
// [불변식]
//   - 결정론: 입력 배열 순서와 무관하게 동일 입력 → 동일 팩. 정렬 키는 노드 (hop, nodeType,
//     nodeId), 엣지 "from->to#kind#viaEdge" 문자열.
//   - 출처 보존: 모든 fact는 seed(hop 0, via "seed") 또는 유입 엣지의 viaEdge로 출처를 인용.
//     양 끝 노드가 팩 노드 집합에 없는 엣지는 인용 금지(댕글링 금지). hop 0 노드는 seed 외
//     탐색 루트로 취급해 via "seed"로 인용.
//   - 예산: maxFacts·maxChars 초과분은 통째로 버리고 truncated=true. 포함 집합은 결정론 순서의
//     접두사이며 fact 라인을 부분 절단하지 않는다(출처 라인 온전성).
//   - 비밀 미노출: 라벨·상태·요약·viaEdge의 토큰·JWT·Bearer·키-값 비밀 모양을 [REDACTED]로 가려 원문을 어떤 필드로도 재노출하지 않는다.
// [소비] data-graph-query(2-hop bounded traversal) 직렬화, 문제-우선 라우팅 힌트(Pillar 3).

export const DEFAULT_MAX_FACTS = 50;
export const DEFAULT_MAX_CHARS = 4_000;
export const MAX_TEXT_FIELD_CHARS = 120;
const REDACTED = "[REDACTED]";

export type GraphRagNodeRef = { nodeType: string; nodeId: string };

export type GraphRagNode = GraphRagNodeRef & {
  /** seed는 0, traversal 결과는 1..maxHops. 음수·비정수는 0으로 클램프. */
  hop: number;
  label?: string;
  status?: string;
  summary?: string;
};

export type GraphRagEdge = {
  kind: string;
  from: GraphRagNodeRef;
  to: GraphRagNodeRef;
  /** 근거 컬럼(예: "issues.mission_id") — 출처 인용에 그대로 인용된다. */
  viaEdge: string;
};

export type GraphRagProvenance = GraphRagNodeRef & { hop: number; viaEdge: string };

export type GraphRagContextPack = {
  seed: GraphRagNodeRef;
  /** 결정론 순서의 출처 인용 fact — 노드 fact 먼저, 엣지 fact가 뒤따른다. */
  facts: string[];
  /** 팩에 실제 포함된 fact가 인용한 노드의 출처 목록(hop·viaEdge 포함). */
  provenance: GraphRagProvenance[];
  truncated: boolean;
  charCount: number;
};

export type BuildGraphRagContextPackInput = {
  seed: GraphRagNodeRef;
  nodes: readonly GraphRagNode[];
  edges: readonly GraphRagEdge[];
  maxFacts?: number;
  maxChars?: number;
};

const SECRET_ASSIGNMENT_RE =
  /\b(pass(?:word|wd)?|secret|api[-_]?key|token|authorization|credential)s?\b\s*[:=]\s*\S+/gi;
const SECRET_TOKEN_RE =
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b|\bgh[pousr]_[A-Za-z0-9]{16,}\b|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** 공백 평탄화 + 비밀 가림 + 길이 상한(넘치면 … 접미). 원문 비밀은 반환되지 않는다. */
function sanitizeText(raw: string | undefined, limit: number): string {
  if (!raw) return "";
  const flat = String(raw).replace(/\s+/g, " ").trim()
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(SECRET_TOKEN_RE, REDACTED)
    .replace(SECRET_ASSIGNMENT_RE, REDACTED);
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + "…";
}

function cleanRef(value: string): string {
  return value.trim();
}

export function graphRagNodeKey(ref: GraphRagNodeRef): string {
  return `${cleanRef(ref.nodeType)}:${cleanRef(ref.nodeId)}`;
}

/** undefined·비유한수는 fallback, 음수는 0, 소수는 내림 — hop·예산 공용 클램프. */
function clampInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

type RankedRef = { hop: number; nodeType: string; nodeId: string };

/** (hop, nodeType, nodeId) 결정론 비교 — 노드 fact·provenance 정렬 공용. */
function compareRankedRef(a: RankedRef, b: RankedRef): number {
  if (a.hop !== b.hop) return a.hop - b.hop;
  if (a.nodeType !== b.nodeType) return a.nodeType < b.nodeType ? -1 : 1;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

export type GraphMode = "single_agent" | "workflow_graph" | "data_graph_rag" | "two_graph";

export type RecommendGraphModeInput = {
  requiresStructuralPause?: boolean;
  requiresDeterministicBranching?: boolean;
  requiresMultiHopContext?: boolean;
  estimatedHops?: number;
};

export type GraphModeRecommendation = {
  mode: GraphMode;
  /** 간결한 한국어+영문 근거 — 표시용이며 실행 권위로 파싱되지 않는다. */
  rationale: string;
};

/**
 * 문제-우선 라우팅 가드(Pillar 3) — 덱 결정 표의 직접 구현.
 * Q1 멈춤·분기·순서 보장을 앱 구조로 강제해야 하는가? (structural)
 * Q2 필요한 정보가 2 hop 이상 떨어진 여러 기록에 흩어져 있는가? (multiHop)
 * 둘 다 아니오 → single_agent, Q1만 → workflow_graph, Q2만 → data_graph_rag, 둘 다 → two_graph.
 * requiresMultiHopContext 플래그가 estimatedHops 판정보다 우선하며, estimatedHops ≥ 2면
 * 플래그 없이도 multiHop으로 판정한다.
 */
export function recommendGraphMode(input: RecommendGraphModeInput): GraphModeRecommendation {
  const structural = Boolean(input.requiresStructuralPause || input.requiresDeterministicBranching);
  const multiHop = Boolean(input.requiresMultiHopContext) || clampInt(input.estimatedHops, 0) >= 2;
  if (structural && multiHop) {
    return {
      mode: "two_graph",
      rationale:
        "구조 강제(멈춤·분기·순서)와 2hop 이상 분산 맥락이 모두 필요하다 — 워크플로 그래프가 제어하고 " +
        "data_graph_query 질의가 출처 포함 맥락을 공급한다. Control + context across both graphs.",
    };
  }
  if (structural) {
    return {
      mode: "workflow_graph",
      rationale:
        "멈춤·분기·순서 보장을 앱 구조로 강제해야 한다 — human_wait 게이트·dependsOn 간선을 쓴다. " +
        "필요 정보는 1hop 이내라 데이터 그래프 질의 불필요. Structural enforcement, context within 1 hop.",
    };
  }
  if (multiHop) {
    return {
      mode: "data_graph_rag",
      rationale:
        "필요한 정보가 여러 기록에 2hop 이상 흩어져 있다 — bounded 2-hop 데이터 그래프 질의로 " +
        "출처 포함 컨텍스트 팩을 구성한다. Scattered records, no structural control.",
    };
  }
  return {
    mode: "single_agent",
    rationale:
      "구조적 강제도 없고 필요한 정보도 1hop 이내다 — 단일 에이전트·도구 호출로 충분하다(그래프를 만들지 않는다). " +
      "No structural enforcement, no scattered records.",
  };
}

/**
 * GraphRAG 컨텍스트 팩 빌더(Pillar 2) — 탐색된 노드·엣지를 출처 인용 fact로 직렬화한다.
 * 순수·결정론: 같은 입력은 배열 순서와 무관하게 같은 팩을 반환한다.
 */
export function buildGraphRagContextPack(input: BuildGraphRagContextPackInput): GraphRagContextPack {
  const seed = {
    nodeType: cleanRef(input.seed?.nodeType ?? ""),
    nodeId: cleanRef(input.seed?.nodeId ?? ""),
  };
  if (seed.nodeType.length === 0 || seed.nodeId.length === 0) {
    throw new TypeError("seed.nodeType and seed.nodeId must be non-empty");
  }
  const seedKey = graphRagNodeKey(seed);

  const nodesByKey = new Map<string, NodeEntry>();
  const remember = (entry: NodeEntry) => {
    const key = graphRagNodeKey(entry);
    const prev = nodesByKey.get(key);
    if (!prev || entry.hop < prev.hop) nodesByKey.set(key, entry);
  };
  for (const node of input.nodes ?? []) {
    const nodeType = cleanRef(node.nodeType);
    const nodeId = cleanRef(node.nodeId);
    if (nodeType.length === 0 || nodeId.length === 0) continue;
    remember({
      nodeType,
      nodeId,
      hop: clampInt(node.hop, 0),
      label: sanitizeText(node.label, MAX_TEXT_FIELD_CHARS),
      status: sanitizeText(node.status, MAX_TEXT_FIELD_CHARS),
      summary: sanitizeText(node.summary, MAX_TEXT_FIELD_CHARS),
    });
  }
  // seed가 노드 목록에 없어도 hop 0 루트로 팩에 참여한다(있으면 hop을 0으로 강제).
  const seedEntry = nodesByKey.get(seedKey);
  if (seedEntry) nodesByKey.set(seedKey, { ...seedEntry, hop: 0 });
  else remember({ nodeType: seed.nodeType, nodeId: seed.nodeId, hop: 0, label: "", status: "", summary: "" });

  const edgeByKey = new Map<string, EdgeEntry>();
  for (const edge of input.edges ?? []) {
    const from = { nodeType: cleanRef(edge.from?.nodeType ?? ""), nodeId: cleanRef(edge.from?.nodeId ?? "") };
    const to = { nodeType: cleanRef(edge.to?.nodeType ?? ""), nodeId: cleanRef(edge.to?.nodeId ?? "") };
    const fromKey = graphRagNodeKey(from);
    const toKey = graphRagNodeKey(to);
    // 댕글링 출처 금지: 양 끝 노드가 팩 노드 집합에 있을 때만 인용한다.
    if (!nodesByKey.has(fromKey) || !nodesByKey.has(toKey)) continue;
    const kind = sanitizeText(edge.kind, MAX_TEXT_FIELD_CHARS);
    const viaEdge = sanitizeText(edge.viaEdge, MAX_TEXT_FIELD_CHARS) || "unknown";
    const sortKey = `${fromKey}->${toKey}#${kind}#${viaEdge}`;
    if (edgeByKey.has(sortKey)) continue;
    edgeByKey.set(sortKey, { kind, fromKey, toKey, viaEdge, sortKey });
  }
  const edges = [...edgeByKey.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  // 각 노드의 viaEdge: hop 0은 seed, 그 외엔 더 작은 hop 이웃으로 들어오는 엣지 중 정렬 키가 가장 앞선 것(다중 경로도 결정론).
  const viaByNodeKey = new Map<string, string>();
  for (const [key, entry] of nodesByKey) {
    if (entry.hop === 0) { viaByNodeKey.set(key, "seed"); continue; }
    let best: EdgeEntry | undefined;
    for (const edge of edges) {
      const otherKey = edge.fromKey === key ? edge.toKey : edge.toKey === key ? edge.fromKey : undefined;
      if (otherKey === undefined) continue;
      if ((nodesByKey.get(otherKey)?.hop ?? Number.MAX_SAFE_INTEGER) >= entry.hop) continue;
      if (!best || edge.sortKey < best.sortKey) best = edge;
    }
    viaByNodeKey.set(key, best ? best.viaEdge : "unlinked");
  }

  type Fact = { ranked: RankedRef; text: string; cites: string[] };
  const nodeFacts: Fact[] = [];
  for (const [key, entry] of nodesByKey) {
    const via = viaByNodeKey.get(key) ?? "unlinked";
    const parts = [`${key} (hop ${entry.hop}, via ${via})`];
    if (entry.label) parts.push(`"${entry.label}"`);
    if (entry.status) parts.push(`[status=${entry.status}]`);
    if (entry.summary) parts.push(`— ${entry.summary}`);
    nodeFacts.push({
      ranked: { hop: entry.hop, nodeType: entry.nodeType, nodeId: entry.nodeId },
      text: parts.join(" "),
      cites: [key],
    });
  }
  nodeFacts.sort((a, b) => compareRankedRef(a.ranked, b.ranked));

  // 엣지 fact는 노드 fact 뒤에 정렬 키 순으로 온다(hop은 MAX로 둬 노드 뒤로 밀어낸다).
  const edgeFacts: Fact[] = edges.map((edge) => ({
    ranked: { hop: Number.MAX_SAFE_INTEGER, nodeType: edge.sortKey, nodeId: "" },
    text: `${edge.kind}: ${edge.fromKey} → ${edge.toKey} (via ${edge.viaEdge})`,
    cites: [edge.fromKey, edge.toKey],
  }));
  edgeFacts.sort((a, b) => compareRankedRef(a.ranked, b.ranked));

  const allFacts = [...nodeFacts, ...edgeFacts];
  const factLimit = clampInt(input.maxFacts, DEFAULT_MAX_FACTS);
  const charLimit = clampInt(input.maxChars, DEFAULT_MAX_CHARS);

  const included: string[] = [];
  let used = 0;
  let index = 0;
  while (index < allFacts.length && included.length < factLimit) {
    const text = allFacts[index].text;
    const cost = included.length === 0 ? text.length : text.length + 1;
    if (used + cost > charLimit) break; // 접두사 유지: 부분 절단 없이 남은 fact를 모두 버린다.
    included.push(text);
    used += cost;
    index += 1;
  }
  const truncated = index < allFacts.length;

  const provenanceByKey = new Map<string, GraphRagProvenance>();
  for (let i = 0; i < index; i += 1) {
    for (const key of allFacts[i].cites) {
      const entry = nodesByKey.get(key);
      if (!entry || provenanceByKey.has(key)) continue;
      provenanceByKey.set(key, {
        nodeType: entry.nodeType,
        nodeId: entry.nodeId,
        hop: entry.hop,
        viaEdge: viaByNodeKey.get(key) ?? "unlinked",
      });
    }
  }
  const provenance = [...provenanceByKey.values()].sort(compareRankedRef);

  return { seed, facts: included, provenance, truncated, charCount: used };
}

type NodeEntry = {
  nodeType: string;
  nodeId: string;
  hop: number;
  label: string;
  status: string;
  summary: string;
};

type EdgeEntry = {
  kind: string;
  fromKey: string;
  toKey: string;
  viaEdge: string;
  sortKey: string;
};
