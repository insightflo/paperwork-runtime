// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  compileMissionViaRust,
  lintNodesViaRust,
  resolveKbCoreBin,
  runKbCoreSubcommand,
  scoreNodesViaRust,
} from "../services/knowledge/kb-core-client.js";
import { applyWorkflowAndAgentKbContext } from "../services/knowledge/kb-auto-compile.js";

const savedBin = process.env.PAPERCLIP_KB_CORE_BIN;
const hasRustBin = Boolean(resolveKbCoreBin());

afterEach(() => {
  if (savedBin === undefined) delete process.env.PAPERCLIP_KB_CORE_BIN;
  else process.env.PAPERCLIP_KB_CORE_BIN = savedBin;
});

describe.runIf(hasRustBin)("kb-core Rust binary parity", () => {
  it("scores Korean NFC vs NFD identically with deterministic tie-break", async () => {
    const res = await scoreNodesViaRust({
      schemaVersion: 1,
      query: "리서치 워크트리",
      limit: 5,
      nodes: [
        { id: "b", slug: "b", title: "리서치 워크트리 가이드", summary: "요약", content: "본문", tags: ["리서치"], certified: true },
        { id: "a", slug: "a", title: "리서치 워크트리 가이드", summary: "요약", content: "본문", tags: ["리서치"], certified: true },
      ],
    });
    expect(res.hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(res.hits[0]!.score).toBe(res.hits[1]!.score);
    expect(res.hits[0]!.score).toBeGreaterThan(0);
  });

  it("lints NFD vs NFC duplicate titles, broken links, orphans, and uncertified stale nodes", async () => {
    const now = 1_763_856_000_000;
    const old = now - 100 * 86_400_000;
    const res = await lintNodesViaRust({
      schemaVersion: 1,
      nowEpochMs: now,
      staleDays: 90,
      nodes: [
        { id: "n1", kbId: "kb1", parentId: null, title: "가이드", status: "active", certified: true, linkedNodeIds: ["missing"], updatedAtEpochMs: old },
        { id: "n2", kbId: "kb1", parentId: null, title: "가이드", status: "active", certified: false, linkedNodeIds: ["n3"], updatedAtEpochMs: old },
        { id: "n3", kbId: "kb1", parentId: null, title: "은퇴노드", status: "retired", certified: false, linkedNodeIds: [], updatedAtEpochMs: now },
      ],
    });
    const codes = res.findings.map((f) => `${f.nodeId}:${f.code}`);
    expect(codes).toContain("n1:broken_link_missing");
    expect(codes).toContain("n2:broken_link_retired");
    expect(codes).toContain("n2:orphan");
    expect(codes).toContain("n2:stale_uncertified");
    expect(codes).toContain("n2:duplicate_title");
    expect(codes).not.toContain("n1:duplicate_title");
    expect(res.staleRetireCandidateIds).toEqual(["n2"]);
  });

  it("compiles mission deterministically with grounded sourceRefs and top-3 wikilinks", async () => {
    const res = await compileMissionViaRust({
      schemaVersion: 1,
      missionId: "11111111-1111-4111-8111-111111111111",
      missionTitle: "KB Tree Ontology Rollout",
      completedAt: "2026-11-23T00:00:00.000Z",
      highlights: ["OpenKB tree indexing and SAG-Wiki evidence scoring"],
      existingNodes: [
        { id: "e1", title: "OpenKB Tree", tags: ["openkb", "tree"] },
        { id: "e2", title: "Ontology Graph", tags: ["ontology"] },
        { id: "e3", title: "Rollout Checklist", tags: ["rollout", "kb"] },
        { id: "e4", title: "Unrelated Topic", tags: ["other"] },
      ],
    });
    expect(res.slug).toBe("kb-tree-ontology-rollout");
    expect(res.linkedNodeIds.length).toBe(3);
    expect(res.linkedNodeIds).not.toContain("e4");
    expect(res.sourceRefs[0]).toMatchObject({ type: "mission", id: "11111111-1111-4111-8111-111111111111" });
  });

  it("fails closed when schemaVersion != 1", async () => {
    await expect(
      runKbCoreSubcommand("score-nodes", { schemaVersion: 2, query: "test", limit: 5, nodes: [] }),
    ).rejects.toThrow(/unsupported schemaVersion: 2/);
  });
});

describe("kb-core TS fallback & heartbeat TOC attachment", () => {
  it("falls back cleanly to TS when Rust binary path is absent", async () => {
    process.env.PAPERCLIP_KB_CORE_BIN = "/nonexistent/paperclip-kb-core";
    expect(resolveKbCoreBin()).toBeNull();

    const scored = await scoreNodesViaRust({
      schemaVersion: 1,
      query: "worktrees",
      limit: 5,
      nodes: [{ id: "1", slug: "worktrees", title: "Worktrees Policy", summary: "Git worktrees", content: "Use worktrees" }],
    });
    expect(scored.hits[0]?.id).toBe("1");

    const linted = await lintNodesViaRust({
      schemaVersion: 1,
      nowEpochMs: 1_763_856_000_000,
      staleDays: 90,
      nodes: [{ id: "u1", kbId: "k1", parentId: null, title: "Old", status: "active", certified: false, linkedNodeIds: [], updatedAtEpochMs: 1_000 }],
    });
    expect(linted.staleRetireCandidateIds).toEqual(["u1"]);

    const compiled = await compileMissionViaRust({
      schemaVersion: 1,
      missionId: "22222222-2222-4222-8222-222222222222",
      missionTitle: "Fallback Compile Test",
      completedAt: "2026-11-23T00:00:00.000Z",
      highlights: ["Verified TS fallback"],
    });
    expect(compiled.slug).toBe("fallback-compile-test");
    expect(compiled.sourceRefs[0]?.type).toBe("mission");
  });

  it("attaches paperclipAgentKbToc when workflowStepKnowledgeContext is null and fails open on error", async () => {
    const ctx: Record<string, unknown> = {};
    const sample = { kbCount: 1, nodeCount: 2, tokenCount: 80, content: "## Knowledge Base Index (L0 TOC)" };
    const fakeDb = {} as never;
    await applyWorkflowAndAgentKbContext(ctx, null, fakeDb, "c1", "a1", async () => sample);
    expect(ctx.paperclipAgentKbToc).toEqual(sample);
    expect(ctx.paperclipWorkflowStepKnowledgeContext).toBeUndefined();

    // Sets workflowStepKnowledgeContext and clears stale TOC when present
    await applyWorkflowAndAgentKbContext(ctx, { entries: [] }, fakeDb, "c1", "a1", async () => sample);
    expect(ctx.paperclipWorkflowStepKnowledgeContext).toEqual({ entries: [] });
    expect(ctx.paperclipAgentKbToc).toBeUndefined();

    // Fails open and clears stale TOC if resolver throws
    ctx.paperclipAgentKbToc = sample;
    await applyWorkflowAndAgentKbContext(ctx, null, fakeDb, "c1", "a1", async () => { throw new Error("db unavailable"); });
    expect(ctx.paperclipAgentKbToc).toBeUndefined();
  });
});
