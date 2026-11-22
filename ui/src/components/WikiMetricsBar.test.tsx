import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import { WikiMetricsBar } from "./WikiMetricsBar";
import type { KnowledgePatternCardDto } from "../api/knowledgePatterns";
import type { AgentWikiEntryDto } from "../api/agentWiki";

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
  makeCard({ id: "c1", files: ["src/a.ts"] }),
  makeCard({ id: "c2" }),
  makeCard({ id: "c3" }),
  makeCard({ id: "c4", kind: "constraint", symbols: ["foo"] }),
  makeCard({ id: "c5", kind: "success_recipe" }),
  makeCard({ id: "c6", supersededById: "c1" }),
  makeCard({ id: "c7", kind: "constraint", status: "retired" }),
  makeCard({ id: "c8", status: "draft" }),
];

const entries = [makeEntry({ id: "e1" }), makeEntry({ id: "e2" }), makeEntry({ id: "e3", status: "resolved" })];

describe("WikiMetricsBar (locale-aware)", () => {
  it("renders Korean metrics labels when company language is ko", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <WikiMetricsBar patterns={patterns} entries={entries} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("활성 오답 (failure_mode)");
    expect(html).toContain("30d TTL");
    expect(html).toContain(">3<");
    expect(html).toContain("내구 규약·레시피");
    expect(html).toContain("폐기·대체됨");
    expect(html).toContain(">2<");
    expect(html).toContain("활성 Wiki 교훈");
    expect(html).toContain("엔터티 결합 커버리지");
    expect(html).toContain("2/8");
    expect(html).toContain("read-only · 자동 수집");
    expect(html).not.toContain("아직 수집된 기록이 없습니다");
  });

  it("renders English metrics labels when company language is en", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en">
        <WikiMetricsBar patterns={patterns} entries={entries} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("Active Mistakes (failure_mode)");
    expect(html).toContain("Durable Rules &amp; Recipes");
    expect(html).toContain("Retired / Superseded");
    expect(html).toContain("Active Wiki Lessons");
    expect(html).toContain("Entity Coupling Coverage");
    expect(html).toContain("read-only · auto-collected");
    expect(html).toContain("2/8");
  });

  it("renders clean localized empty states for both ko and en", () => {
    const emptyKo = renderToStaticMarkup(<WikiMetricsBar patterns={[]} entries={[]} language="ko" />);
    expect(emptyKo).toContain("아직 수집된 기록이 없습니다");
    expect(emptyKo).not.toContain("30d TTL");
    const emptyEn = renderToStaticMarkup(<WikiMetricsBar patterns={[]} entries={[]} language="en" />);
    expect(emptyEn).toContain("No records yet");
    expect(emptyEn).not.toContain("30d TTL");
  });
});
