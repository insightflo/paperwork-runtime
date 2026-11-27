// @vitest-environment node
//
// DataGraphContextPanel — node 환경 + renderToStaticMarkup 표시 검증.
// useQuery와 dataGraphApi는 모듈 mock으로 갈아끼워 로딩·빈·1/2-hop·컨텍스트 팩·오류 상태를 확인한다.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataGraphQueryNode, DataGraphQueryResponse } from "../api/data-graph";
import { DataGraphContextPanel } from "./DataGraphContextPanel";

const harness = vi.hoisted(() => ({
  result: { data: undefined, isPending: true, isError: false, refetch: vi.fn() } as Record<string, unknown>,
  queryOptions: null as null | { queryFn: () => Promise<unknown> },
  queryDataGraph: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryFn: () => Promise<unknown> }) => {
    harness.queryOptions = options;
    return harness.result;
  },
}));

vi.mock("../api/data-graph", () => ({
  dataGraphApi: { queryDataGraph: harness.queryDataGraph },
}));

function queryResult(data: DataGraphQueryResponse | undefined): Record<string, unknown> {
  return { data, isPending: data === undefined, isError: false, refetch: vi.fn() };
}

function node(kind: string, id: string, hop: number, extra?: Partial<DataGraphQueryNode>): DataGraphQueryNode {
  return { kind, id, hop, ...extra };
}

function response(partial: Partial<DataGraphQueryResponse>): DataGraphQueryResponse {
  return { seed: { kind: "issue", id: "seed-1" }, nodes: [], edges: [], truncated: false, ...partial };
}

function renderPanel(props?: { includeContextPack?: boolean; onSelectNode?: (node: { kind: string; id: string }) => void }) {
  return renderToStaticMarkup(
    <DataGraphContextPanel companyId="company-1" seedKind="issue" seedId="seed-1" {...props} />,
  );
}

beforeEach(() => {
  harness.queryOptions = null;
  harness.queryDataGraph.mockClear();
});

describe("DataGraphContextPanel", () => {
  it("renders a loading skeleton with aria-busy while pending", () => {
    harness.result = queryResult(undefined);
    const html = renderPanel();
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("1-hop");
  });

  it("builds the query with the <kind>:<id> seed contract", async () => {
    harness.result = queryResult(undefined);
    renderPanel({ includeContextPack: true });
    expect(harness.queryOptions).not.toBeNull();
    await harness.queryOptions!.queryFn();
    expect(harness.queryDataGraph).toHaveBeenCalledWith("company-1", {
      seed: "issue:seed-1",
      maxHops: 2,
      includeContextPack: true,
    });
  });

  it("renders the empty state when only the seed node exists", () => {
    harness.result = queryResult(response({ nodes: [node("issue", "seed-1", 0)] }));
    const html = renderPanel();
    expect(html).toContain("연결된 2-hop 관계가 없습니다");
  });

  it("renders 1-hop and 2-hop nodes grouped with kind badges and status", () => {
    harness.result = queryResult(
      response({
        nodes: [
          node("issue", "seed-1", 0),
          node("mission", "mission-9", 1, { label: "Mission 9", status: "running" }),
          node("agent", "agent-3", 2, { label: "Agent 3" }),
        ],
      }),
    );
    const html = renderPanel();
    expect(html).toContain("1-hop");
    expect(html).toContain("2-hop");
    expect(html).toContain("mission");
    expect(html).toContain("Mission 9");
    expect(html).toContain("running");
    expect(html).toContain("agent");
    expect(html).toContain("Agent 3");
    expect(html).not.toContain("<button");
  });

  it("renders node rows as buttons when onSelectNode is provided", () => {
    harness.result = queryResult(response({ nodes: [node("mission", "mission-9", 1, { label: "Mission 9" })] }));
    const html = renderPanel({ onSelectNode: vi.fn() });
    expect(html).toContain("<button");
    expect(html).toContain("Mission 9");
  });

  it("renders provenance-cited facts and the truncated badge when a context pack exists", () => {
    harness.result = queryResult(
      response({
        nodes: [node("mission", "mission-9", 1, { label: "Mission 9" })],
        truncated: true,
        contextPack: {
          seed: { nodeType: "issue", nodeId: "seed-1" },
          facts: ["Mission mission-9은 issue seed-1에서 파생됐다"],
          provenance: [{ nodeType: "mission", nodeId: "mission-9", hop: 1, viaEdge: "issue_id" }],
          truncated: true,
          charCount: 421,
        },
      }),
    );
    const html = renderPanel({ includeContextPack: true });
    expect(html).toContain("Mission mission-9은 issue seed-1에서 파생됐다");
    expect(html).toContain("via issue_id");
    expect(html).toContain("일부 생략됨");
    expect(html).toContain("421자");
  });

  it("renders an error state with a retry action on failure", () => {
    harness.result = { data: undefined, isPending: false, isError: true, refetch: vi.fn() };
    const html = renderPanel();
    expect(html).toContain("Data Graph 탐색에 실패했습니다.");
    expect(html).toContain("다시 시도");
    expect(html).toContain("<button");
  });
});
