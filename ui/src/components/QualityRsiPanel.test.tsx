import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import { QualityRsiMetrics, QualityRsiPanel } from "./QualityRsiPanel";
import type { QualityRsiOverview } from "../api/quality";

const SAMPLE_OVERVIEW: QualityRsiOverview = {
  stats: {
    pass30d: 18,
    requestChanges30d: 2,
    passRate30d: 90,
    passAllTime: 154,
    requestChangesAllTime: 65,
    passRateAllTime: 70,
    passedMissionsTotal: 114,
    escapedMissionsCount: 35,
    escapedDefectRate: 31,
    autoInjectedCount: 3,
    canonCount: 1,
    openReviewItemsCount: 0,
    staleReviewItemsCount: 49,
  },
  clusters: [
    {
      axis: "qa_self",
      code: "qa_escaped_final_qa_failure",
      signature: "quality-rsi:qa_escaped_final_qa_failure",
      canonSignature: "quality-rsi-canon:qa_escaped_final_qa_failure",
      title: "Plan QA blind spot (final_qa_failure)",
      summary: "Missions passed Plan QA but later hit final_qa_failure.",
      count: 13,
      recentCount30d: 2,
      latestAt: "2026-11-15T00:00:00Z",
      samples: [{ missionTitle: "2026-11-15 youtube-report", detail: "plan_goal_mismatch", createdAt: "2026-11-15T00:00:00Z" }],
      rsiStatus: "auto_injected",
      wikiPatternId: "p1",
    },
    {
      axis: "worker",
      code: "action_contract_gap",
      signature: "quality-rsi:action_contract_gap",
      canonSignature: "quality-rsi-canon:action_contract_gap",
      title: "Plan QA recurring failure: action_contract_gap",
      summary: "Missing toolArgs.url",
      count: 8,
      recentCount30d: 1,
      latestAt: "2026-11-10T00:00:00Z",
      samples: [{ missionTitle: "2026-11-10 news", detail: "Missing toolArgs.url", createdAt: "2026-11-10T00:00:00Z" }],
      rsiStatus: "canon",
      wikiPatternId: "p2",
    },
  ],
  recentVerdicts: [],
  openReviewItems: [],
};

describe("QualityRsiPanel", () => {
  it("renders Korean metrics and dual-axis RSI clusters when language is ko", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="ko">
        <QualityRsiMetrics stats={SAMPLE_OVERVIEW.stats} />
        <QualityRsiPanel overview={SAMPLE_OVERVIEW} onPromoteCanon={() => {}} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("Plan QA 통과율 (30일)");
    expect(html).toContain("90%");
    expect(html).toContain("QA 미탐률 (통과 후 실패)");
    expect(html).toContain("31%");
    expect(html).toContain("QA 자체 개선 (미탐·구멍 보강)");
    expect(html).toContain("작업자 개선 (반복 반려 패턴)");
    expect(html).toContain("Wiki 자동 주입 중");
    expect(html).toContain("★ 표준 규약 (100% 주입)");
    expect(html).toContain("★ 표준 규약으로 고정");
  });

  it("renders English metrics and dual-axis RSI clusters when language is en", () => {
    const html = renderToStaticMarkup(
      <CompanyLanguageProvider language="en">
        <QualityRsiMetrics stats={SAMPLE_OVERVIEW.stats} />
        <QualityRsiPanel overview={SAMPLE_OVERVIEW} onPromoteCanon={() => {}} />
      </CompanyLanguageProvider>,
    );
    expect(html).toContain("Plan QA Pass Rate (30d)");
    expect(html).toContain("QA Escaped Defect Rate");
    expect(html).toContain("QA Self-Improvement (Blind Spots)");
    expect(html).toContain("Worker Self-Improvement (Recurring Rejections)");
    expect(html).toContain("Auto-injected to Wiki");
    expect(html).toContain("★ Standard Rule (100% injected)");
    expect(html).toContain("Pin as ★ Standard Rule");
  });

  it("renders localized empty state when no clusters exist", () => {
    const empty: QualityRsiOverview = { ...SAMPLE_OVERVIEW, clusters: [] };
    const htmlKo = renderToStaticMarkup(<QualityRsiPanel overview={empty} language="ko" />);
    const htmlEn = renderToStaticMarkup(<QualityRsiPanel overview={empty} language="en" />);
    expect(htmlKo).toContain("아직 반복되는 Plan QA 반려나 QA 미탐 패턴이 없습니다");
    expect(htmlEn).toContain("No recurring Plan QA rejections or QA blind spots detected yet");
  });
});
