// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FallbackRouteIndicator,
  formatFallbackSkipReason,
  type FallbackSkipReason,
} from "../FallbackRouteIndicator";

const REASON_CASES: ReadonlyArray<[FallbackSkipReason, string]> = [
  ["auth_fatal", "인증 오류"],
  ["circuit_open", "서킷 차단"],
  ["cooling_down", "쿨다운 대기"],
];

describe("formatFallbackSkipReason", () => {
  it.each(REASON_CASES)("formats %s as %s", (reason, label) => {
    expect(formatFallbackSkipReason(reason)).toBe(label);
  });
});

describe("FallbackRouteIndicator", () => {
  it("returns null when no fallback route was used", () => {
    const html = renderToStaticMarkup(
      <FallbackRouteIndicator usedFallback={false} selectedAdapter="openai" selectedModel="gpt-5" />,
    );

    expect(html).toBe("");
  });

  it("renders the fallback model and primary skip reason", () => {
    const html = renderToStaticMarkup(
      <FallbackRouteIndicator
        usedFallback
        selectedAdapter="anthropic"
        selectedModel="claude-sonnet-4.5"
        skippedCount={2}
        primarySkipReason="circuit_open"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("폴백 전환 · claude-sonnet-4.5");
    expect(html).toContain("(서킷 차단)");
    expect(html).toContain("anthropic");
    expect(html).toContain("+2 생략");
  });
});
