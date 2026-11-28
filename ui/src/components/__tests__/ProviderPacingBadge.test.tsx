import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatProviderPacingLabel, ProviderPacingBadge } from "../ProviderPacingBadge";

describe("formatProviderPacingLabel", () => {
  it.each([
    ["ok", 4, undefined, "정상 (4)"],
    ["provider_throttled", 2, undefined, "슬롯 축소 (2)"],
    ["at_slot_limit", 6, undefined, "슬롯 한도 (6)"],
    ["cooldown_active", 1, undefined, "쿨다운 대기"],
    ["cooldown_active", 1, 0, "쿨다운 대기"],
    ["cooldown_active", 1, 1_500, "쿨다운 2초"],
    ["cooldown_active", 1, 2_000, "쿨다운 2초"],
  ] as const)("formats pacing label case %#", (reason, effectiveSlots, retryAfterMs, expected) => {
    expect(formatProviderPacingLabel(reason, effectiveSlots, retryAfterMs)).toBe(expected);
  });
});

describe("ProviderPacingBadge", () => {
  it("renders the provider, formatted label, and accessible aria-label", () => {
    const markup = renderToStaticMarkup(
      <ProviderPacingBadge provider="anthropic" effectiveSlots={2} reason="provider_throttled" />,
    );

    expect(markup).toContain("anthropic");
    expect(markup).toContain("슬롯 축소 (2)");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="프로바이더 anthropic 실행 슬롯 상태: 슬롯 축소 (2)"');
    expect(markup).toContain("tabular-nums");
  });

  it("renders cooldown timing in the visible label and aria-label", () => {
    const markup = renderToStaticMarkup(
      <ProviderPacingBadge provider="openai" effectiveSlots={1} reason="cooldown_active" retryAfterMs={1_500} />,
    );

    expect(markup).toContain("쿨다운 2초");
    expect(markup).toContain('aria-label="프로바이더 openai 실행 슬롯 상태: 쿨다운 2초"');
  });
});
