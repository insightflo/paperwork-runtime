import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdapterCapabilityBadges,
  type AdapterCapabilityView,
} from "../AdapterCapabilityBadges";

function render(profile: AdapterCapabilityView | null | undefined) {
  return renderToStaticMarkup(<AdapterCapabilityBadges profile={profile} />);
}

const devinLocalProfile: AdapterCapabilityView = {
  adapterType: "devin_local",
  displayName: "Devin Local",
  supportsSessionResume: true,
  supportsMultiSlot: true,
  requiresWorkspaceTrustBypass: true,
  defaultMaxConcurrentRuns: 3,
  maxRecommendedSlots: 4,
};

const singleSlotProfile: AdapterCapabilityView = {
  adapterType: "pi_local",
  displayName: "Pi Local",
  supportsSessionResume: false,
  supportsMultiSlot: false,
  requiresWorkspaceTrustBypass: false,
  defaultMaxConcurrentRuns: 1,
  maxRecommendedSlots: 1,
};

describe("AdapterCapabilityBadges", () => {
  it("renders nothing when the profile is empty", () => {
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("renders devin_local multi-slot, session-resume, and trust-bypass capabilities", () => {
    const html = render(devinLocalProfile);

    expect(html).toContain('data-testid="adapter-capability-badges"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Devin Local 실행 역량"');
    expect(html).toContain("멀티 슬롯 (최대 4)");
    expect(html).toContain("세션 재개 지원");
    expect(html).toContain("비대화형 신뢰 우회 적용");
    expect(html).not.toContain("단일 슬롯");
    expect(html).not.toContain("세션 재개 미지원");
  });

  it("renders a single-slot non-resumable adapter without the trust-bypass pill", () => {
    const html = render(singleSlotProfile);

    expect(html).toContain('aria-label="Pi Local 실행 역량"');
    expect(html).toContain("단일 슬롯");
    expect(html).toContain("세션 재개 미지원");
    expect(html).not.toContain("멀티 슬롯");
    expect(html).not.toContain("비대화형 신뢰 우회 적용");
  });
});
