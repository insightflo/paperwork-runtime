// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractMissionDocumentFacts, mergeDedupedTags } from "../services/knowledge/kb-document-extractor.js";
import { compileMissionViaRust } from "../services/knowledge/kb-core-client.js";

const tempDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-extract-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("extractMissionDocumentFacts & compile integration", () => {
  it("extracts real content.json facts, strips PNGs/precheck/boilerplate, and keeps stable slug on re-compile", async () => {
    const dir = makeTmp();
    const contentPath = path.join(dir, "content.json");
    writeFileSync(contentPath, JSON.stringify({
      title: "Windows 작업 관리자를 대체하는 오픈 소스, GoodGood 사용법",
      summary: "GoodGood은 프로세스와 하드웨어 상태를 한 창에서 보여 주는 Rust 오픈 소스 도구다.",
      tags: ["GoodGood", "Rust 데스크톱 앱", "goodgood"],
      blocks: [
        { type: "section", heading: "핵심 기능", text: "7일 리소스 히스토리와 코어별 온도 모니터링 지원" },
      ],
      sources: [{ title: "GitHub", url: "https://github.com/acc0mplish/GoodGood" }],
    }));

    const facts = await extractMissionDocumentFacts(
      [
        { type: "artifact", title: "diagram-1.png", summary: null, url: null, metadata: { path: path.join(dir, "diagram-1.png") } },
        { type: "document", title: "security-precheck.json", summary: null, url: null, metadata: { path: path.join(dir, "security-precheck.json") } },
        { type: "document", title: "content.json", summary: null, url: null, metadata: { path: contentPath } },
      ],
      "Created automatically for workflow run: service-onboarding",
    );

    expect(facts.titleOverride).toBe("Windows 작업 관리자를 대체하는 오픈 소스, GoodGood 사용법");
    expect(facts.url).toBe("https://github.com/acc0mplish/GoodGood");
    expect(facts.highlights.join("\n")).toContain("7일 리소스 히스토리");
    expect(facts.highlights.join("\n")).not.toContain("diagram-1.png");
    expect(facts.highlights.join("\n")).not.toContain("Created automatically for workflow run");

    const missionTitle = "2026-11-23 service-onboarding — GoodGood";
    const first = await compileMissionViaRust({
      schemaVersion: 1,
      missionId: "11111111-1111-4111-8111-111111111111",
      missionTitle: facts.titleOverride ?? missionTitle,
      slugHint: missionTitle,
      completedAt: "2026-11-23T00:00:00.000Z",
      url: facts.url,
      highlights: facts.highlights,
    });
    const second = await compileMissionViaRust({
      schemaVersion: 1,
      missionId: "11111111-1111-4111-8111-111111111111",
      missionTitle: facts.titleOverride ?? missionTitle,
      slugHint: missionTitle,
      completedAt: "2026-11-23T00:00:00.000Z",
      url: facts.url,
      highlights: facts.highlights,
    });

    expect(first.slug).toBe("2026-11-23-service-onboarding-goodgood");
    expect(second.slug).toBe(first.slug);
    expect(first.content).toContain("Rust 오픈 소스 도구");
    expect(first.content).not.toContain("diagram-1.png");
    expect(mergeDedupedTags(first.tags, facts.extraTags)).toContain("Rust 데스크톱 앱");
  });

  it("extracts headings and bullets from Markdown documents", async () => {
    const dir = makeTmp();
    const mdPath = path.join(dir, "report.md");
    writeFileSync(mdPath, "# Market Thesis\n\n```ts\nignore()\n```\n\n- AI infra CapEx remains strong\n- Power grid bottleneck persists\n");

    const facts = await extractMissionDocumentFacts([
      { type: "document", title: "report.md", summary: null, url: null, metadata: { path: mdPath } },
    ]);
    expect(facts.titleOverride).toBe("Market Thesis");
    expect(facts.highlights).toEqual(["AI infra CapEx remains strong", "Power grid bottleneck persists"]);
  });
});
