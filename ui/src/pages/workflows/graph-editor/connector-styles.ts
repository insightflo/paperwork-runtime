export type ConnectorState =
  | "default"
  | "running"
  | "completed"
  | "blocked"
  | "condition_true"
  | "condition_false"
  | "rework";

export type ConnectorVisualStyleOptions = {
  dimmed?: boolean;
  highlighted?: boolean;
  reducedMotion?: boolean;
};

export type ConnectorStateStyle = {
  stroke: string;
  strokeWidth: number;
  strokeDasharray: string;
  opacity: number;
  motionClassName: string;
  reducedMotionClassName: string;
};

export type ConnectorVisualStyle = {
  stroke: string;
  strokeWidth: number;
  strokeDasharray: string;
  opacity: number;
  animationClassName: string;
};

type Point = { x: number; y: number };

const EPSILON = 0.000001;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const rounded = Math.round(normalized * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function point(x: number, y: number): Point {
  return { x: finite(x), y: finite(y) };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function compressRoute(points: Point[]): Point[] {
  const compressed: Point[] = [];
  for (const next of points) {
    const previous = compressed[compressed.length - 1];
    if (previous && distance(previous, next) <= EPSILON) continue;
    compressed.push(next);
    while (compressed.length >= 3) {
      const a = compressed[compressed.length - 3];
      const b = compressed[compressed.length - 2];
      const c = compressed[compressed.length - 1];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const bcx = c.x - b.x;
      const bcy = c.y - b.y;
      const collinearForward = Math.abs(abx * bcy - aby * bcx) <= EPSILON && abx * bcx + aby * bcy > 0;
      if (!collinearForward) break;
      compressed.splice(compressed.length - 2, 1);
    }
  }
  return compressed;
}

function moveTo(start: Point): string {
  return `M ${formatNumber(start.x)},${formatNumber(start.y)}`;
}

function lineTo(end: Point): string {
  return `L ${formatNumber(end.x)},${formatNumber(end.y)}`;
}

export function computePortOffsets(count: number, span: number): number[] {
  const safeCount = Math.max(0, Math.floor(finite(count)));
  if (safeCount === 0) return [];
  if (safeCount === 1) return [0];
  const safeSpan = Math.abs(finite(span));
  if (safeSpan <= EPSILON) return Array.from({ length: safeCount }, () => 0);
  const half = safeSpan / 2;
  const step = safeSpan / (safeCount - 1);
  return Array.from({ length: safeCount }, (_, index) => {
    const raw = -half + step * index;
    return Math.round(clamp(raw, -half, half) * 1000) / 1000;
  });
}

export function buildTangentBezierPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  laneOffset = 0,
): string {
  const start = point(x1, y1 + finite(laneOffset));
  const end = point(x2, y2 + finite(laneOffset));
  const controlX = (start.x + end.x) / 2;
  return [
    moveTo(start),
    "C",
    `${formatNumber(controlX)},${formatNumber(start.y)}`,
    `${formatNumber(controlX)},${formatNumber(end.y)}`,
    `${formatNumber(end.x)},${formatNumber(end.y)}`,
  ].join(" ");
}

export function buildRoundedElbowPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius = 10,
  midXOffset = 0,
): string {
  const start = point(x1, y1);
  const end = point(x2, y2);
  if (distance(start, end) <= EPSILON) return `${moveTo(start)} ${lineTo(end)}`;
  const naturalMidX = (start.x + end.x) / 2 + finite(midXOffset);
  const route = compressRoute([
    start,
    { x: naturalMidX, y: start.y },
    { x: naturalMidX, y: end.y },
    end,
  ]);
  if (route.length < 2) return `${moveTo(start)} ${lineTo(end)}`;
  const segments = route.slice(0, -1).map((current, index) => distance(current, route[index + 1]));
  const shortestHalfSegment = Math.min(...segments.map((length) => length / 2));
  const cornerRadius = clamp(finite(radius), 0, Math.max(0, shortestHalfSegment));
  const commands = [moveTo(route[0])];
  for (let index = 1; index < route.length - 1; index += 1) {
    const beforeCorner = route[index - 1];
    const corner = route[index];
    const afterCorner = route[index + 1];
    const incomingLength = distance(beforeCorner, corner);
    const outgoingLength = distance(corner, afterCorner);
    const usableRadius = Math.min(cornerRadius, incomingLength / 2, outgoingLength / 2);
    if (usableRadius <= EPSILON) {
      commands.push(lineTo(corner));
      continue;
    }
    const approach = {
      x: corner.x - ((corner.x - beforeCorner.x) / incomingLength) * usableRadius,
      y: corner.y - ((corner.y - beforeCorner.y) / incomingLength) * usableRadius,
    };
    const departure = {
      x: corner.x + ((afterCorner.x - corner.x) / outgoingLength) * usableRadius,
      y: corner.y + ((afterCorner.y - corner.y) / outgoingLength) * usableRadius,
    };
    commands.push(
      lineTo(approach),
      `Q ${formatNumber(corner.x)},${formatNumber(corner.y)} ${formatNumber(departure.x)},${formatNumber(departure.y)}`,
    );
  }
  commands.push(lineTo(route[route.length - 1]));
  return commands.join(" ");
}

export function buildLoopbackLanePath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  laneIndex: number,
  topClearance = 36,
): { path: string; labelX: number; labelY: number } {
  const start = point(fromX, fromY);
  const end = point(toX, toY);
  const lane = Math.max(0, Math.floor(finite(laneIndex)));
  const clearance = Math.max(0, finite(topClearance, 36));
  const ceiling = Math.min(start.y, end.y) - clearance - lane * 36;
  const path = [
    moveTo(start),
    "C",
    `${formatNumber(start.x)},${formatNumber(ceiling)}`,
    `${formatNumber(end.x)},${formatNumber(ceiling)}`,
    `${formatNumber(end.x)},${formatNumber(end.y)}`,
  ].join(" ");
  return {
    path,
    labelX: Math.round(((start.x + end.x) / 2) * 1000) / 1000,
    labelY: Math.round((ceiling - 10) * 1000) / 1000,
  };
}

export const CONNECTOR_STATE_STYLES: Record<ConnectorState, ConnectorStateStyle> = {
  default: { stroke: "#64748b", strokeWidth: 2, strokeDasharray: "none", opacity: 0.88,
    motionClassName: "wf-connector-motion-none", reducedMotionClassName: "wf-connector-motion-none" },
  running: { stroke: "#0072b2", strokeWidth: 2.4, strokeDasharray: "14 6", opacity: 1,
    motionClassName: "wf-connector-motion-flow", reducedMotionClassName: "wf-connector-motion-none" },
  completed: { stroke: "#009e73", strokeWidth: 2, strokeDasharray: "24 3 1 3", opacity: 0.94,
    motionClassName: "wf-connector-motion-settled", reducedMotionClassName: "wf-connector-motion-none" },
  blocked: { stroke: "#d55e00", strokeWidth: 2.5, strokeDasharray: "5 5", opacity: 1,
    motionClassName: "wf-connector-motion-pulse", reducedMotionClassName: "wf-connector-motion-none" },
  condition_true: { stroke: "#56b4e9", strokeWidth: 2.2, strokeDasharray: "11 4 2 4", opacity: 0.98,
    motionClassName: "wf-connector-motion-flow-true", reducedMotionClassName: "wf-connector-motion-none" },
  condition_false: { stroke: "#e69f00", strokeWidth: 2.2, strokeDasharray: "2 4", opacity: 0.98,
    motionClassName: "wf-connector-motion-flow-false", reducedMotionClassName: "wf-connector-motion-none" },
  rework: { stroke: "#cc79a7", strokeWidth: 2.4, strokeDasharray: "12 3 3 3", opacity: 1,
    motionClassName: "wf-connector-motion-loopback", reducedMotionClassName: "wf-connector-motion-none" },
};

export function getConnectorVisualStyle(
  state: ConnectorState,
  options: ConnectorVisualStyleOptions = {},
): ConnectorVisualStyle {
  const base = CONNECTOR_STATE_STYLES[state];
  const highlighted = options.highlighted === true;
  const dimmed = options.dimmed === true && !highlighted;
  return {
    stroke: base.stroke,
    strokeWidth: base.strokeWidth + (highlighted ? 0.8 : 0),
    strokeDasharray: base.strokeDasharray,
    opacity: dimmed ? Math.max(0.12, base.opacity * 0.35) : highlighted ? 1 : base.opacity,
    animationClassName: dimmed || options.reducedMotion === true
      ? base.reducedMotionClassName
      : base.motionClassName,
  };
}
