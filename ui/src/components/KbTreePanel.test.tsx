// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { KbTreePanel } from "./KbTreePanel";
import { knowledgeBasesApi } from "../api/knowledgeBases";

vi.mock("../lib/companyLanguage", () => ({
  useCompanyLanguage: () => "ko",
  L: (_lang: string, m: { en: string; ko: string }) => m.ko,
}));

vi.mock("../api/knowledgeBases", () => ({
  knowledgeBasesApi: {
    tree: vi.fn(),
    search: vi.fn(),
    readNode: vi.fn(),
    lint: vi.fn(),
    setCertified: vi.fn(),
  },
}));

describe("KbTreePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders KB tree, runs lint, and toggles node certification", async () => {
    vi.mocked(knowledgeBasesApi.tree).mockResolvedValue({
      knowledgeBases: [{
        id: "kb1", name: "Researched Services", type: "ontology", description: "", grantCount: 9,
        nodes: [{
          id: "n1", kbId: "kb1", parentId: null, slug: "goodgood", title: "GoodGood Onboarding",
          summary: "Summary", nodeType: "entity", certified: false, status: "active",
          tags: ["onboarding"], linkedNodeIds: [], updatedAt: "2026-11-23T00:00:00Z",
        }],
      }],
      totalNodes: 1,
      truncated: false,
    });
    vi.mocked(knowledgeBasesApi.readNode).mockResolvedValue({
      id: "n1", kbId: "kb1", kbName: "Researched Services", parentId: null, slug: "goodgood",
      title: "GoodGood Onboarding", summary: "Summary", content: "# GoodGood",
      nodeType: "entity", certified: false, tags: ["onboarding"], sourceRefs: [],
      updatedAt: "2026-11-23T00:00:00Z", children: [], linkedNodes: [],
    });
    vi.mocked(knowledgeBasesApi.lint).mockResolvedValue({
      scannedCount: 1, findings: [], staleRetireCandidateIds: [], retiredIds: [],
    });
    vi.mocked(knowledgeBasesApi.setCertified).mockResolvedValue({ id: "n1", certified: true });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <KbTreePanel companyId="c1" />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    expect(container.textContent).toContain("Researched Services");
    expect(container.textContent).toContain("GoodGood Onboarding");

    // Click node to inspect
    const nodeBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("GoodGood Onboarding"))!;
    await act(async () => { nodeBtn.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(container.textContent).toContain("# GoodGood");

    // Click certify button
    const certBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("공인 지정"))!;
    await act(async () => { certBtn.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(knowledgeBasesApi.setCertified).toHaveBeenCalledWith("c1", "n1", true);

    // Click lint button
    const lintBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("KB Lint 점검"))!;
    await act(async () => { lintBtn.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(container.textContent).toContain("점검 1개 노드");

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
