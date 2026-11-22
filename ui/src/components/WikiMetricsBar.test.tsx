import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WikiMetricsBar } from "./WikiMetricsBar";
import type { KnowledgePatternCardDto } from "../api/knowledgePatterns";
import type { AgentWikiEntryDto } from "../api/agentWiki";

// [목적] WikiMetricsBar가 patterns/entries DTO만으로 지표를 집계하는지 검증 —
//   kind/status/supersededById 분기, files/symbols 커버리지, 빈 상태.

function makeCard(overrides: Partial<KnowledgePatternCardDto>): KnowledgePatternCardDto {
  return {
    id: "card-x", companyId: "co-1", kind: "failure_mode", title: "t", summary: "s",
    evidence: [], symptoms: null, rootCause: null, whatWorked: null, scopeTags: [],
    source: "auto_rework_draft", status: "active", audience: "ops",
    defectSignature: null, createdByAgentId: null, supersededById: null,
    createdAt: "2026-11-01T00:00:00.000Z", ...overrides,
  };
}

function makeEntry(overrides: Partial<AgentWikiEntryDto>): AgentWikiEntryDto {
  return {
    id: "entry-x", companyId: "co-1", agentId: "agent-1", missionId: null,
    pattern: "p", cause: "c", solution: "s", errorCode: null, stepId: null,
    frequency: 3, status: "active",
    createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z", ...overrides,
  };
}

const patterns = [
  makeCard({ id: "c1", files: ["src/a.ts"] }),                          // live failure + entity
  makeCard({ id: "c2" }),                                              // live failure
  makeCard({ id: "c3" }),                                              // live failure
  makeCard({ id: "c4", kind: "constraint", symbols: ["foo"] }),          // durable + entity
  makeCard({ id: "c5", kind: "success_recipe" }),                      // durable
  makeCard({ id: "c6", supersededById: "c1" }),                        // retired (supersededById)
  makeCard({ id: "c7", kind: "constraint", status: "retired" }),       // retired (status)
  makeCard({ id: "c8", status: "draft" }),                             // draft: live/retired 양쪽 아님
];

const entries = [makeEntry({ id: "e1" }), makeEntry({ id: "e2" }), makeEntry({ id: "e3", status: "resolved" })];

describe("WikiMetricsBar", () => {
  const html = renderToStaticMarkup(<WikiMetricsBar patterns={patterns} entries={entries} />);

  it("aggregates live failure_mode (30d TTL), durable, retired, and entity coverage counts", () => {
    expect(html).toContain("활성 오답 (failure_mode)");
    expect(html).toContain("30d TTL");
    expect(html).toContain(">3<");      // live failure_mode (c8 draft 제외)
    expect(html).toContain("내구 규약·레시피");
    expect(html).toContain("폐기·대체됨");
    expect(html).toContain(">2<");      // durable=2, retired=2
    expect(html).toContain("엔터티 결합 커버리지");
    expect(html).toContain("2/8");      // files/symbols 붙은 카드 2장 / 전체 8장
  });

  it("counts only active wiki entries and never renders an empty state over data", () => {
    expect(html).toContain("활성 Wiki 교훈");
    expect(html).not.toContain("아직 수집된 기록이 없습니다");
  });

  it("renders a clean empty state when both arrays are empty", () => {
    const empty = renderToStaticMarkup(<WikiMetricsBar patterns={[]} entries={[]} />);
    expect(empty).toContain("아직 수집된 기록이 없습니다");
    expect(empty).not.toContain("30d TTL");
    expect(empty).not.toContain("엔터티 결합 커버리지");
  });
});
