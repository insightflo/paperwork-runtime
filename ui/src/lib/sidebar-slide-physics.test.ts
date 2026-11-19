import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MIN_WIDTH_PX,
  NAV_COMPACT_WIDTH_PX,
  NAV_EXPANDED_WIDTH_PX,
  NAV_PEEK_WIDTH_PX,
  RAIL_WIDTH_PX,
  calculateSidebarSlideMetrics,
  resolveSnapTarget,
  shouldAutoCompactSidebar,
} from "./sidebar-slide-physics";

describe("resolveSnapTarget", () => {
  it("collapses on strong negative velocity below 210px", () => {
    expect(resolveSnapTarget(180, -0.6)).toEqual({ mode: "collapsed", targetWidth: 0 });
  });

  it("expands on strong positive velocity above 60px", () => {
    expect(resolveSnapTarget(120, 0.9)).toEqual({ mode: "expanded", targetWidth: NAV_EXPANDED_WIDTH_PX });
  });

  it("snaps into collapsed/compact/peek/expanded buckets without velocity", () => {
    expect(resolveSnapTarget(40, 0).mode).toBe("collapsed");
    expect(resolveSnapTarget(100, 0)).toEqual({ mode: "compact", targetWidth: NAV_COMPACT_WIDTH_PX });
    expect(resolveSnapTarget(200, 0)).toEqual({ mode: "peek", targetWidth: NAV_PEEK_WIDTH_PX });
    expect(resolveSnapTarget(240, 0)).toEqual({ mode: "expanded", targetWidth: NAV_EXPANDED_WIDTH_PX });
  });

  it("projects 140ms of velocity before bucket selection", () => {
    expect(resolveSnapTarget(200, 0.4).mode).toBe("expanded");
    expect(resolveSnapTarget(70, -0.4).mode).toBe("collapsed");
  });
});

describe("shouldAutoCompactSidebar", () => {
  it("compacts only on desktop widths that leave less than the conversation minimum", () => {
    expect(shouldAutoCompactSidebar(1000, RAIL_WIDTH_PX, 0)).toBe(false);
    expect(shouldAutoCompactSidebar(800, RAIL_WIDTH_PX, 360)).toBe(true);
    expect(shouldAutoCompactSidebar(600, RAIL_WIDTH_PX, 0)).toBe(false);
    expect(shouldAutoCompactSidebar(72 + 360 + CONVERSATION_MIN_WIDTH_PX, RAIL_WIDTH_PX, 360)).toBe(false);
  });
});

describe("calculateSidebarSlideMetrics", () => {
  it("returns zero blur while expanded or hovering, and bounded blur mid-collapse", () => {
    expect(calculateSidebarSlideMetrics(NAV_EXPANDED_WIDTH_PX).subNavBlurPx).toBe(0);
    const mid = calculateSidebarSlideMetrics(128);
    expect(mid.subNavBlurPx).toBeGreaterThanOrEqual(1.4);
    expect(mid.subNavBlurPx).toBeLessThanOrEqual(6);
    expect(calculateSidebarSlideMetrics(128, { isHoveringSubNav: true }).subNavBlurPx).toBe(0);
    expect(calculateSidebarSlideMetrics(128, { depthBlurEnabled: false }).subNavBlurPx).toBe(0);
  });

  it("maps width to density tiers and KPI columns", () => {
    expect(calculateSidebarSlideMetrics(60).canvasDensityTier).toBe("ultra-wide");
    expect(calculateSidebarSlideMetrics(60).visibleKpiColumns).toBe(5);
    expect(calculateSidebarSlideMetrics(160).canvasDensityTier).toBe("expanded");
    expect(calculateSidebarSlideMetrics(160).visibleKpiColumns).toBe(4);
    expect(calculateSidebarSlideMetrics(NAV_EXPANDED_WIDTH_PX).canvasDensityTier).toBe("standard");
    expect(calculateSidebarSlideMetrics(NAV_EXPANDED_WIDTH_PX).visibleKpiColumns).toBe(3);
  });

  it("keeps opacity within the floor and shadow alpha within range", () => {
    const collapsed = calculateSidebarSlideMetrics(0);
    expect(collapsed.subNavOpacity).toBeGreaterThanOrEqual(0.2);
    expect(collapsed.sheetShadowAlpha).toBeLessThanOrEqual(0.14);
    expect(calculateSidebarSlideMetrics(NAV_EXPANDED_WIDTH_PX).sheetShadowAlpha).toBeCloseTo(0.065, 2);
  });
});
