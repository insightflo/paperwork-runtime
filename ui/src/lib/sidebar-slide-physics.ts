import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** st.-aurelia 2.5D adaptive sidebar physics — Paperclip 72px rail + 0..256px nav. */
export const RAIL_WIDTH_PX = 72;
export const NAV_EXPANDED_WIDTH_PX = 256;
export const NAV_PEEK_WIDTH_PX = 184;
export const NAV_COMPACT_WIDTH_PX = 88;
export const NAV_COLLAPSED_WIDTH_PX = 0;
export const CONVERSATION_MIN_WIDTH_PX = 424;
export const NAV_WIDTH_STORAGE_KEY = "paperclip.navWidth";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type SidebarSnapMode = "collapsed" | "compact" | "peek" | "expanded";
export interface SidebarSnapTarget {
  mode: SidebarSnapMode;
  targetWidth: number;
}

export function resolveSnapTarget(currentNavWidth: number, velocityPxPerMs = 0): SidebarSnapTarget {
  const projected = clamp(currentNavWidth + velocityPxPerMs * 140, 0, NAV_EXPANDED_WIDTH_PX);
  if (velocityPxPerMs < -0.45 && currentNavWidth < 210) return { mode: "collapsed", targetWidth: 0 };
  if (velocityPxPerMs > 0.45 && currentNavWidth > 60) return { mode: "expanded", targetWidth: NAV_EXPANDED_WIDTH_PX };
  if (projected < 72) return { mode: "collapsed", targetWidth: 0 };
  if (projected < 136) return { mode: "compact", targetWidth: NAV_COMPACT_WIDTH_PX };
  if (projected < 224) return { mode: "peek", targetWidth: NAV_PEEK_WIDTH_PX };
  return { mode: "expanded", targetWidth: NAV_EXPANDED_WIDTH_PX };
}

/** Narrow-viewport transient 88px compaction — never mutates the saved width. */
export function shouldAutoCompactSidebar(windowWidth: number, railWidth: number, expandedPanelWidth: number): boolean {
  return windowWidth >= 768 && windowWidth - railWidth - expandedPanelWidth < CONVERSATION_MIN_WIDTH_PX;
}

export type CanvasDensityTier = "standard" | "expanded" | "ultra-wide";
export interface SidebarSlideMetrics {
  collapseProgress: number;
  subNavBlurPx: number;
  subNavScale: number;
  subNavOpacity: number;
  sheetShadowAlpha: number;
  canvasDensityTier: CanvasDensityTier;
  visibleKpiColumns: number;
}

export function calculateSidebarSlideMetrics(
  rawNavWidth: number,
  opts?: { isHoveringSubNav?: boolean; depthBlurEnabled?: boolean },
): SidebarSlideMetrics {
  const navVisibleWidth = clamp(rawNavWidth, 0, NAV_EXPANDED_WIDTH_PX);
  const collapseProgress = clamp(Number((1 - navVisibleWidth / NAV_EXPANDED_WIDTH_PX).toFixed(4)), 0, 1);
  const depthBlurEnabled = opts?.depthBlurEnabled ?? true;
  const isHoveringSubNav = opts?.isHoveringSubNav ?? false;
  const isSnappedCompact = navVisibleWidth <= NAV_COMPACT_WIDTH_PX && navVisibleWidth >= NAV_COMPACT_WIDTH_PX - 2;
  const subNavBlurPx =
    !depthBlurEnabled || isHoveringSubNav || isSnappedCompact || collapseProgress <= 0.04
      ? 0
      : Number(clamp(collapseProgress * 6.2, 1.4, 6.0).toFixed(2));
  return {
    collapseProgress,
    subNavBlurPx,
    subNavScale: isSnappedCompact ? 1 : Number((1 - collapseProgress * 0.035).toFixed(4)),
    subNavOpacity: isSnappedCompact ? 1 : Number(clamp(1 - Math.pow(collapseProgress, 1.35) * 0.65, 0.2, 1).toFixed(3)),
    sheetShadowAlpha: Number(clamp(0.065 + collapseProgress * 0.065, 0.05, 0.14).toFixed(3)),
    canvasDensityTier: navVisibleWidth <= 88 ? "ultra-wide" : navVisibleWidth <= 205 ? "expanded" : "standard",
    visibleKpiColumns: navVisibleWidth <= 88 ? 5 : navVisibleWidth <= 205 ? 4 : 3,
  };
}

export interface SidebarDensity {
  width: number;
  compact: boolean;
}
export const SidebarDensityContext = createContext<SidebarDensity>({ width: NAV_EXPANDED_WIDTH_PX, compact: false });
export const useSidebarDensity = () => useContext(SidebarDensityContext);

export function readRememberedNavWidth(): number {
  if (typeof window === "undefined") return NAV_EXPANDED_WIDTH_PX;
  try {
    const raw = window.localStorage.getItem(NAV_WIDTH_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed, 0, NAV_EXPANDED_WIDTH_PX) : NAV_EXPANDED_WIDTH_PX;
  } catch {
    return NAV_EXPANDED_WIDTH_PX;
  }
}

export function writeNavWidthPreference(width: number) {
  try {
    window.localStorage.setItem(NAV_WIDTH_STORAGE_KEY, String(Math.round(clamp(width, 0, NAV_EXPANDED_WIDTH_PX))));
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

export interface SidebarSlideController {
  navWidth: number;
  effectiveNavWidth: number;
  metrics: SidebarSlideMetrics;
  density: SidebarDensity;
  autoCompacted: boolean;
  setHoveringSubNav: (hovering: boolean) => void;
  previewNavWidth: (width: number) => void;
  commitNavWidth: (width: number, velocityPxPerMs: number) => SidebarSnapTarget;
  toggleNav: () => void;
  toggleCompact: () => void;
}

export function useSidebarSlideController(opts: {
  isMobile: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  rightPanelWidth: number;
}): SidebarSlideController {
  const [navWidth, setNavWidth] = useState<number>(readRememberedNavWidth);
  const [hovering, setHovering] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  const lastExpanded = useRef(NAV_EXPANDED_WIDTH_PX);

  useEffect(() => {
    if (typeof window === "undefined" || opts.isMobile) return;
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [opts.isMobile]);

  const autoCompacted =
    !opts.isMobile && opts.sidebarOpen && shouldAutoCompactSidebar(windowWidth, RAIL_WIDTH_PX, opts.rightPanelWidth);
  const effectiveNavWidth = opts.isMobile
    ? opts.sidebarOpen
      ? NAV_EXPANDED_WIDTH_PX
      : 0
    : opts.sidebarOpen
      ? autoCompacted
        ? NAV_COMPACT_WIDTH_PX
        : navWidth
      : 0;

  const metrics = useMemo(
    () => calculateSidebarSlideMetrics(effectiveNavWidth, { isHoveringSubNav: hovering, depthBlurEnabled: !opts.isMobile }),
    [effectiveNavWidth, hovering, opts.isMobile],
  );

  const applyWidth = useCallback(
    (width: number, persist: boolean) => {
      if (width > 0) {
        lastExpanded.current = width;
        opts.setSidebarOpen(true);
      } else if (persist) {
        opts.setSidebarOpen(false);
      }
      setNavWidth(width);
      if (persist) writeNavWidthPreference(width);
    },
    [opts],
  );

  const previewNavWidth = useCallback((w: number) => applyWidth(clamp(w, 0, NAV_EXPANDED_WIDTH_PX), false), [applyWidth]);
  const commitNavWidth = useCallback(
    (w: number, velocity: number) => {
      const target = resolveSnapTarget(w, velocity);
      applyWidth(target.targetWidth, true);
      return target;
    },
    [applyWidth],
  );
  const toggleNav = useCallback(() => {
    const isCurrentlyOpen = opts.sidebarOpen && effectiveNavWidth > 0;
    applyWidth(isCurrentlyOpen ? 0 : lastExpanded.current || NAV_EXPANDED_WIDTH_PX, true);
  }, [applyWidth, effectiveNavWidth, opts.sidebarOpen]);

  const toggleCompact = useCallback(() => {
    if (opts.isMobile || autoCompacted) return;
    const shouldExpand = !opts.sidebarOpen || effectiveNavWidth <= NAV_COMPACT_WIDTH_PX;
    applyWidth(shouldExpand ? NAV_EXPANDED_WIDTH_PX : NAV_COMPACT_WIDTH_PX, true);
  }, [applyWidth, autoCompacted, effectiveNavWidth, opts.isMobile, opts.sidebarOpen]);

  const density = useMemo(
    () => ({ width: effectiveNavWidth, compact: !opts.isMobile && effectiveNavWidth <= NAV_COMPACT_WIDTH_PX }),
    [effectiveNavWidth, opts.isMobile],
  );

  return { navWidth, effectiveNavWidth, metrics, density, autoCompacted, setHoveringSubNav: setHovering, previewNavWidth, commitNavWidth, toggleNav, toggleCompact };
}
