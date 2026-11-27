// server/src/__tests__/graphrag-context-pack.test.ts
//
// [범위] GraphRAG 컨텍스트 팩 빌더(출처 보존·결정론·예산 절단·비밀 가림)와
//   문제-우선 라우팅 가드의 덱 결정 표 4케이스. 순수 단위 테스트 — DB·네트워크 없음.

import { describe, expect, it } from "vitest";
import {
  buildGraphRagContextPack,
  recommendGraphMode,
  type BuildGraphRagContextPackInput,
  type GraphRagEdge,
  type GraphRagNode,
} from "../services/data-graph/graphrag-context-pack.js";

const BASE_NODES: GraphRagNode[] = [
  { nodeType: "mission", nodeId: "m1", hop: 0, label: "Migrate billing pipeline", status: "running" },
  { nodeType: "issue", nodeId: "i1", hop: 1, label: "Split payment step" },
  { nodeType: "work_product", nodeId: "wp1", hop: 2, summary: "PR draft #42" },
  { nodeType: "knowledge_node", nodeId: "k1", hop: 1, label: "Billing glossary" },
];

const BASE_EDGES: GraphRagEdge[] = [
  { kind: "mission_issue", from: { nodeType: "mission", nodeId: "m1" }, to: { nodeType: "issue", nodeId: "i1" }, viaEdge: "issues.mission_id" },
  { kind: "issue_work_product", from: { nodeType: "issue", nodeId: "i1" }, to: { nodeType: "work_product", nodeId: "wp1" }, viaEdge: "issue_work_products.issue_id" },
  { kind: "knowledge_source", from: { nodeType: "knowledge_node", nodeId: "k1" }, to: { nodeType: "mission", nodeId: "m1" }, viaEdge: "knowledge_nodes.source_refs" },
];

function baseInput(): BuildGraphRagContextPackInput {
  return { seed: { nodeType: "mission", nodeId: "m1" }, nodes: BASE_NODES, edges: BASE_EDGES };
}

describe("buildGraphRagContextPack — provenance", () => {
  it("preserves provenance for every cited node, with seed at hop 0", () => {
    const pack = buildGraphRagContextPack(baseInput());
    expect(pack.seed).toEqual({ nodeType: "mission", nodeId: "m1" });
    expect(pack.provenance).toEqual([
      { nodeType: "mission", nodeId: "m1", hop: 0, viaEdge: "seed" },
      { nodeType: "issue", nodeId: "i1", hop: 1, viaEdge: "issues.mission_id" },
      { nodeType: "knowledge_node", nodeId: "k1", hop: 1, viaEdge: "knowledge_nodes.source_refs" },
      { nodeType: "work_product", nodeId: "wp1", hop: 2, viaEdge: "issue_work_products.issue_id" },
    ]);
    expect(pack.truncated).toBe(false);
  });

  it("cites the via edge column inside node and edge facts", () => {
    const pack = buildGraphRagContextPack(baseInput());
    expect(pack.facts).toContainEqual(
      "mission:m1 (hop 0, via seed) \"Migrate billing pipeline\" [status=running]",
    );
    expect(pack.facts).toContainEqual(
      "mission_issue: mission:m1 → issue:i1 (via issues.mission_id)",
    );
    expect(pack.facts).toContainEqual(
      "issue_work_product: issue:i1 → work_product:wp1 (via issue_work_products.issue_id)",
    );
    // 4 node facts + 3 edge facts.
    expect(pack.facts).toHaveLength(7);
  });

  it("never cites dangling edges whose endpoints are outside the node set", () => {
    const input = baseInput();
    input.edges = [
      ...input.edges,
      { kind: "mission_issue", from: { nodeType: "mission", nodeId: "m1" }, to: { nodeType: "issue", nodeId: "ghost" }, viaEdge: "issues.mission_id" },
    ];
    const pack = buildGraphRagContextPack(input);
    expect(pack.facts.some((fact) => fact.includes("issue:ghost"))).toBe(false);
    expect(pack.truncated).toBe(false);
  });

  it("synthesizes the seed node when the traversal omitted it", () => {
    const pack = buildGraphRagContextPack({
      seed: { nodeType: "mission", nodeId: "m1" },
      nodes: [{ nodeType: "issue", nodeId: "i1", hop: 1 }],
      edges: [{ kind: "mission_issue", from: { nodeType: "mission", nodeId: "m1" }, to: { nodeType: "issue", nodeId: "i1" }, viaEdge: "issues.mission_id" }],
    });
    expect(pack.provenance.map((p) => p.nodeId).sort()).toEqual(["i1", "m1"]);
    expect(pack.facts.some((fact) => fact.startsWith("mission:m1 (hop 0, via seed)"))).toBe(true);
  });

  it("rejects an empty seed deterministically", () => {
    expect(() => buildGraphRagContextPack({ ...baseInput(), seed: { nodeType: "mission", nodeId: " " } }))
      .toThrow(TypeError);
  });
});

describe("buildGraphRagContextPack — determinism & budgets", () => {
  it("returns the identical pack regardless of input array order", () => {
    const a = buildGraphRagContextPack(baseInput());
    const b = buildGraphRagContextPack({
      seed: baseInput().seed,
      nodes: [...BASE_NODES].reverse(),
      edges: [...BASE_EDGES].reverse(),
    });
    expect(b).toEqual(a);
  });

  it("truncates to maxFacts as a deterministic prefix and flags truncated", () => {
    const full = buildGraphRagContextPack(baseInput());
    const pack = buildGraphRagContextPack({ ...baseInput(), maxFacts: 4 });
    expect(pack.facts).toHaveLength(4);
    expect(pack.facts).toEqual(full.facts.slice(0, 4));
    expect(pack.truncated).toBe(true);
    // Provenance covers only the nodes actually cited by the kept facts.
    expect(pack.provenance.map((p) => p.nodeId)).toEqual(["m1", "i1", "k1", "wp1"]);
  });

  it("honors maxChars without partial fact lines", () => {
    const full = buildGraphRagContextPack(baseInput());
    const firstLen = full.facts[0].length;
    const pack = buildGraphRagContextPack({ ...baseInput(), maxChars: firstLen });
    expect(pack.facts).toEqual([full.facts[0]]);
    expect(pack.charCount).toBe(firstLen);
    expect(pack.charCount).toBeLessThanOrEqual(firstLen);
    expect(pack.truncated).toBe(true);

    const empty = buildGraphRagContextPack({ ...baseInput(), maxChars: 1 });
    expect(empty.facts).toEqual([]);
    expect(empty.charCount).toBe(0);
    expect(empty.truncated).toBe(true);
    expect(empty.provenance).toEqual([]);
  });

  it("keeps full packs under default budgets without truncation", () => {
    const pack = buildGraphRagContextPack(baseInput());
    expect(pack.truncated).toBe(false);
    expect(pack.charCount).toBe(pack.facts.join("\n").length);
  });

  it("redacts secret-shaped text and never re-exposes the raw value", () => {
    const pack = buildGraphRagContextPack({
      seed: { nodeType: "issue", nodeId: "sec1" },
      nodes: [
        { nodeType: "issue", nodeId: "sec1", hop: 0, label: "api_key = sk-abcdefghijklmnop1234" },
        { nodeType: "work_product", nodeId: "wp9", hop: 1, summary: "Authorization: Bearer abc123XYZ.def", status: "ghp_abcdefghijklmnopqrstuvwxyz1234" },
        { nodeType: "knowledge_node", nodeId: "k9", hop: 1, label: "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQss" },
      ],
      edges: [
        { kind: "issue_work_product", from: { nodeType: "issue", nodeId: "sec1" }, to: { nodeType: "work_product", nodeId: "wp9" }, viaEdge: "issue_work_products.issue_id" },
      ],
    });
    const dumped = JSON.stringify(pack);
    expect(dumped).not.toContain("sk-abcdefghijklmnop1234");
    expect(dumped).not.toContain("abc123XYZ.def");
    expect(dumped).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
    expect(dumped).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(dumped).toContain("[REDACTED]");
  });
});

describe("recommendGraphMode — deck decision table", () => {
  it("routes to single_agent when neither question applies", () => {
    const rec = recommendGraphMode({ estimatedHops: 1 });
    expect(rec.mode).toBe("single_agent");
    expect(rec.rationale.length).toBeGreaterThan(0);
  });

  it("routes to workflow_graph for structural pause only", () => {
    expect(recommendGraphMode({ requiresStructuralPause: true }).mode).toBe("workflow_graph");
  });

  it("routes to workflow_graph for deterministic branching only", () => {
    expect(recommendGraphMode({ requiresDeterministicBranching: true }).mode).toBe("workflow_graph");
  });

  it("routes to data_graph_rag for scattered multi-hop context only", () => {
    expect(recommendGraphMode({ requiresMultiHopContext: true }).mode).toBe("data_graph_rag");
    // estimatedHops >= 2 alone satisfies Q2.
    expect(recommendGraphMode({ estimatedHops: 2 }).mode).toBe("data_graph_rag");
    expect(recommendGraphMode({ estimatedHops: 3 }).mode).toBe("data_graph_rag");
  });

  it("routes to two_graph when both questions apply", () => {
    const rec = recommendGraphMode({ requiresStructuralPause: true, requiresMultiHopContext: true });
    expect(rec.mode).toBe("two_graph");
    expect(recommendGraphMode({ requiresDeterministicBranching: true, estimatedHops: 3 }).mode).toBe("two_graph");
    expect(rec.rationale).toContain("data_graph_query");
  });
});
