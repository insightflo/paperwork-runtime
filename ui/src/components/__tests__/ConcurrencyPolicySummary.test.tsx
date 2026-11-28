/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConcurrencyPolicySummary,
  type ConcurrencyPolicyView,
} from "../ConcurrencyPolicySummary";

const config: ConcurrencyPolicyView = {
  maxConcurrentRuns: 4,
  reserveInteractiveHeadroom: true,
  coalesceWindowMs: 7_500,
  starvationWarningMs: 120_000,
  maxDelegationDepth: 3,
  maxActiveChildren: 8,
};

function parseHtml(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

function policyRows(html: string) {
  return Array.from(parseHtml(html).querySelectorAll("dl > div")).map((tile) => ({
    label: tile.querySelector("dt")?.textContent,
    value: tile.querySelector("dd")?.textContent,
  }));
}

function alertWarnings(html: string) {
  return Array.from(parseHtml(html).querySelectorAll('[role="alert"] li')).map((item) => item.textContent);
}

describe("ConcurrencyPolicySummary", () => {
  it("renders all six policy fields in Korean", () => {
    const html = renderToStaticMarkup(<ConcurrencyPolicySummary config={config} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="동시 실행 정책 요약"');
    expect(html).toContain('data-testid="concurrency-policy-summary"');
    expect(html).toContain("tabular-nums");
    expect(policyRows(html)).toEqual([
      { label: "동시 슬롯", value: "4" },
      { label: "대화형 여유 슬롯", value: "예약" },
      { label: "중복 병합", value: "8초" },
      { label: "장기 대기 경보", value: "2분" },
      { label: "위임 깊이", value: "3" },
      { label: "최대 자식", value: "8" },
    ]);
  });

  it("renders the unreserved interactive headroom state", () => {
    const html = renderToStaticMarkup(
      <ConcurrencyPolicySummary config={{ ...config, reserveInteractiveHeadroom: false }} />,
    );

    expect(policyRows(html)).toContainEqual({ label: "대화형 여유 슬롯", value: "미예약" });
  });

  it("omits the alert block when warnings are empty or omitted", () => {
    const omitted = renderToStaticMarkup(<ConcurrencyPolicySummary config={config} />);
    const empty = renderToStaticMarkup(<ConcurrencyPolicySummary config={config} warnings={[]} />);

    expect(omitted).not.toContain('role="alert"');
    expect(empty).not.toContain('role="alert"');
  });

  it("renders validation warnings inside an alert region", () => {
    const warnings = [
      "최대 동시 실행 수가 하한으로 조정되었습니다.",
      "위임 깊이가 허용 범위를 벗어났습니다.",
    ] as const;
    const html = renderToStaticMarkup(<ConcurrencyPolicySummary config={config} warnings={warnings} />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("정책 검증 경고");
    expect(alertWarnings(html)).toEqual([...warnings]);
  });
});
