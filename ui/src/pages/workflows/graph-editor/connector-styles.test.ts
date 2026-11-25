import { describe, expect, it } from "vitest";
import {
  CONNECTOR_STATE_STYLES,
  buildLoopbackLanePath,
  buildRoundedElbowPath,
  buildTangentBezierPath,
  computePortOffsets,
  getConnectorVisualStyle,
  type ConnectorState,
} from "./connector-styles.js";

const coordinate = "-?\\d+(?:\\.\\d+)?,-?\\d+(?:\\.\\d+)?";
const svgPathPattern = new RegExp(
  `^M ${coordinate}(?: (?:L ${coordinate}|Q ${coordinate} ${coordinate}|C ${coordinate} ${coordinate} ${coordinate}))*$`,
);

function expectValidSvgPath(path: string) {
  expect(path).toMatch(svgPathPattern);
  expect(path).not.toContain("NaN");
  expect(path).not.toContain("Infinity");
}

describe("computePortOffsets", () => {
  it("returns centered symmetric spreads for counts 0, 1, 2, 3, and 5", () => {
    expect(computePortOffsets(0, 20)).toEqual([]);
    expect(computePortOffsets(1, 20)).toEqual([0]);
    expect(computePortOffsets(2, 20)).toEqual([-10, 10]);
    expect(computePortOffsets(3, 20)).toEqual([-10, 0, 10]);
    expect(computePortOffsets(5, 20)).toEqual([-10, -5, 0, 5, 10]);
  });

  it("keeps positive-span ports non-overlapping and clamped inside the span", () => {
    for (const count of [2, 3, 5]) {
      const offsets = computePortOffsets(count, 24);
      expect(new Set(offsets).size).toBe(count);
      expect(Math.min(...offsets)).toBeGreaterThanOrEqual(-12);
      expect(Math.max(...offsets)).toBeLessThanOrEqual(12);
      for (let index = 0; index < Math.floor(count / 2); index += 1) {
        expect(offsets[index]).toBeCloseTo(-offsets[count - 1 - index], 5);
      }
    }
  });
});

describe("buildTangentBezierPath", () => {
  it("builds a horizontal-tangent cubic with midpoint control x coordinates", () => {
    const path = buildTangentBezierPath(0, 10, 100, 30);
    expectValidSvgPath(path);
    expect(path).toBe("M 0,10 C 50,10 50,30 100,30");
  });

  it("applies lane offsets as a parallel vertical metro strand", () => {
    const base = buildTangentBezierPath(0, 10, 100, 30);
    const lane = buildTangentBezierPath(0, 10, 100, 30, 4);
    expectValidSvgPath(lane);
    expect(lane).toBe("M 0,14 C 50,14 50,34 100,34");
    expect(lane).not.toBe(base);
  });
});

describe("buildRoundedElbowPath", () => {
  it("uses quadratic corners and clamps oversized radii to half the shortest segment", () => {
    const path = buildRoundedElbowPath(0, 0, 8, 8, 999);
    expectValidSvgPath(path);
    expect(path).toBe("M 0,0 L 2,0 Q 4,0 4,2 L 4,6 Q 4,8 6,8 L 8,8");
  });

  it("never inverts corners on short or zero-delta segments", () => {
    const short = buildRoundedElbowPath(0, 0, 4, 4, 50);
    const horizontal = buildRoundedElbowPath(0, 0, 4, 0, 50);
    const empty = buildRoundedElbowPath(0, 0, 0, 0, 50);
    for (const path of [short, horizontal, empty]) expectValidSvgPath(path);
    expect(horizontal).toBe("M 0,0 L 4,0");
    expect(empty).toBe("M 0,0 L 0,0");
  });

  it("honors midpoint lane offsets without producing invalid geometry", () => {
    const centered = buildRoundedElbowPath(0, 0, 100, 60, 12);
    const shifted = buildRoundedElbowPath(0, 0, 100, 60, 12, 18);
    expectValidSvgPath(centered);
    expectValidSvgPath(shifted);
    expect(shifted).not.toBe(centered);
    expect(shifted).toContain("Q 68,0");
  });
});

describe("buildLoopbackLanePath", () => {
  it("centers labels and keeps lane zero above both endpoints", () => {
    const lane = buildLoopbackLanePath(120, 100, 40, 80, 0);
    expectValidSvgPath(lane.path);
    expect(lane.labelX).toBe(80);
    expect(lane.labelY).toBeLessThan(80);
    expect(lane.path.startsWith("M 120,100 ")).toBe(true);
    expect(lane.path.endsWith("40,80")).toBe(true);
  });

  it("staggers lanes into distinct non-overlapping label heights", () => {
    const first = buildLoopbackLanePath(120, 100, 40, 80, 0);
    const second = buildLoopbackLanePath(120, 100, 40, 80, 1);
    expect(second.labelY).toBeLessThan(first.labelY);
    expect(first.labelY - second.labelY).toBeGreaterThanOrEqual(20);
    expect(second.labelY).toBeLessThan(Math.min(100, 80));
    expect(second.path).not.toBe(first.path);
  });
});

describe("connector state visual styles", () => {
  it("uses colorblind-safe colors with a distinct dash pattern for every state", () => {
    const states = Object.keys(CONNECTOR_STATE_STYLES) as ConnectorState[];
    const strokes = states.map((state) => CONNECTOR_STATE_STYLES[state].stroke);
    const dashes = states.map((state) => CONNECTOR_STATE_STYLES[state].strokeDasharray);
    expect(new Set(strokes).size).toBe(states.length);
    expect(new Set(dashes).size).toBe(states.length);
    expect(CONNECTOR_STATE_STYLES.condition_true.stroke).toBe("#56b4e9");
    expect(CONNECTOR_STATE_STYLES.condition_false.stroke).toBe("#e69f00");
    expect(CONNECTOR_STATE_STYLES.rework.stroke).toBe("#cc79a7");
    expect(CONNECTOR_STATE_STYLES.blocked.stroke).toBe("#d55e00");
  });

  it("keeps conditional, blocked, and rework states distinguishable without relying on color", () => {
    const states: ConnectorState[] = ["condition_true", "condition_false", "rework", "blocked"];
    const patterns = states.map((state) => CONNECTOR_STATE_STYLES[state].strokeDasharray);
    expect(new Set(patterns).size).toBe(states.length);
    for (const pattern of patterns) expect(pattern).not.toBe("none");
  });

  it("exposes visible dimmed and highlighted hover transitions", () => {
    const normal = getConnectorVisualStyle("running");
    const dimmed = getConnectorVisualStyle("running", { dimmed: true });
    const highlighted = getConnectorVisualStyle("running", { highlighted: true });
    expect(dimmed.opacity).toBeLessThan(normal.opacity);
    expect(dimmed.animationClassName).toBe("wf-connector-motion-none");
    expect(highlighted.strokeWidth).toBeGreaterThan(normal.strokeWidth);
    expect(highlighted.opacity).toBeGreaterThanOrEqual(normal.opacity);
    expect(highlighted.stroke).toBe(normal.stroke);
  });

  it("returns a non-animated class when reduced motion is requested", () => {
    for (const state of Object.keys(CONNECTOR_STATE_STYLES) as ConnectorState[]) {
      const visual = getConnectorVisualStyle(state, { reducedMotion: true });
      expect(visual.animationClassName).toBe("wf-connector-motion-none");
    }
  });
});
