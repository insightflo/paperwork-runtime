// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { dataGraphApi } from "./data-graph";

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

function setFetchMock(impl: FetchMock) {
  Object.defineProperty(globalThis, "fetch", {
    value: impl,
    configurable: true,
  });
}

describe("dataGraphApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts recommend-mode with url-encoded companyId and typed passthrough", async () => {
    const recommendation = {
      mode: "two_graph" as const,
      rationale: "Q1·Q2 모두 예 — 투그래프",
    };
    const fetchMock = vi.fn(async () => mockResponse(200, recommendation));
    setFetchMock(fetchMock);

    const payload = {
      requiresStructuralPause: true,
      requiresDeterministicBranching: false,
      requiresMultiHopContext: true,
      estimatedHops: 2,
    };
    await expect(dataGraphApi.recommendMode("company/a b", payload)).resolves.toEqual(
      recommendation,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/company%2Fa%20b/data-graph/recommend-mode",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });

  it("posts context-pack with url-encoded companyId and typed passthrough", async () => {
    const pack = {
      seed: { nodeType: "mission", nodeId: "m-1" },
      facts: ["mission:m-1 (via seed)"],
      provenance: [{ nodeType: "mission", nodeId: "m-1", hop: 0, viaEdge: "seed" }],
      truncated: false,
      charCount: 21,
    };
    const fetchMock = vi.fn(async () => mockResponse(200, pack));
    setFetchMock(fetchMock);

    const payload = {
      seed: { nodeType: "mission", nodeId: "m-1" },
      nodes: [{ nodeType: "mission", nodeId: "m-1", hop: 0 }],
      edges: [
        {
          kind: "references",
          from: { nodeType: "mission", nodeId: "m-1" },
          to: { nodeType: "issue", nodeId: "i-2" },
          viaEdge: "issues.mission_id",
        },
      ],
      maxFacts: 10,
    };
    await expect(dataGraphApi.buildContextPack("co:x/y", payload)).resolves.toEqual(pack);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/companies/co%3Ax%2Fy/data-graph/context-pack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  });
});
