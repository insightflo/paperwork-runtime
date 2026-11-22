import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  readKbNode,
  renderAgentKbToc,
  scoreKbNode,
  searchKbNodes,
  tokenizeQuery,
} from "../services/knowledge/kb-nodes.js";

describe("kb-nodes vectorless scoring & TOC", () => {
  it("scores title/tag/content matches with certified & glossary boosts and filters zero-match nodes", () => {
    const tokens = tokenizeQuery("worktree delivery policy");
    const certified = scoreKbNode(
      {
        slug: "github-delivery-policy",
        title: "GitHub Delivery Policy",
        summary: "Use isolated worktrees before merge",
        content: "Always create an isolated worktree.",
        tags: ["github", "worktree"],
        nodeType: "glossary",
        certified: true,
      },
      tokens,
    );
    const uncertified = scoreKbNode(
      {
        slug: "github-delivery-policy",
        title: "GitHub Delivery Policy",
        summary: "Use isolated worktrees before merge",
        content: "Always create an isolated worktree.",
        tags: ["github", "worktree"],
        nodeType: "concept",
        certified: false,
      },
      tokens,
    );
    const unrelated = scoreKbNode(
      {
        slug: "shorts-bgm",
        title: "Shorts BGM Guide",
        summary: "Audio mastering levels",
        content: "Keep LUFS at -14.",
        tags: ["audio"],
        nodeType: "concept",
        certified: true,
      },
      tokens,
    );

    expect(certified.score).toBeGreaterThan(uncertified.score);
    expect(certified.score - uncertified.score).toBe(3); // +2 certified, +1 glossary
    expect(unrelated.score).toBe(0);
  });

  it("enforces cumulative token budget cap in L0 TOC and includes no-list-all hint", () => {
    const manyNodes = Array.from({ length: 20 }, (_, i) => ({
      id: `n-${i}`,
      title: `Node Title ${i} with extra words`,
      summary: "A".repeat(140),
      certified: i === 0,
    }));
    const toc = renderAgentKbToc([{ id: "kb-1", name: "Core KB", nodes: manyNodes }], "comp-1", 120);
    expect(toc.tokenCount).toBeLessThanOrEqual(120);
    expect(toc.content).toContain("never list-all");
    expect(toc.content).toContain("★ [n-0]");
    expect(toc.nodeCount).toBeLessThan(20);
  });

  it("rejects empty search queries (blocks list-all)", async () => {
    const fakeDb = {} as Db;
    await expect(searchKbNodes(fakeDb, { companyId: "c1", query: "   " })).rejects.toThrow(/search term/i);
  });

  it("RBAC regression: agent with zero KB grants gets empty search results and null readKbNode", async () => {
    const emptyGrantDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: async () => [],
            }),
          }),
        }),
      }),
    } as unknown as Db;

    const hits = await searchKbNodes(emptyGrantDb, { companyId: "c1", agentId: "agent-ungranted", query: "delivery policy" });
    const detail = await readKbNode(emptyGrantDb, { companyId: "c1", agentId: "agent-ungranted", nodeId: "node-1" });
    expect(hits).toEqual([]);
    expect(detail).toBeNull();
  });
});
