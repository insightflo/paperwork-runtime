export interface WaitEdge {
  waiterId: string;
  targetId: string;
  runId?: string | null;
  waitedMs?: number;
}

export interface DeadlockCycle {
  nodes: string[];
  edges: WaitEdge[];
  recommendedBreakTarget: WaitEdge;
}

interface CanonicalCycle {
  nodes: string[];
  edges: WaitEdge[];
}

export function detectWaitDeadlocks(edges: readonly WaitEdge[]): DeadlockCycle[] {
  const nodeSet = new Set<string>();
  const endpointEdges = new Map<string, WaitEdge>();

  for (const edge of edges) {
    nodeSet.add(edge.waiterId);
    nodeSet.add(edge.targetId);
    const key = endpointKey(edge.waiterId, edge.targetId);
    const existing = endpointEdges.get(key);
    if (!existing || compareBreakPreference(edge, existing) < 0) {
      endpointEdges.set(key, edge);
    }
  }

  const adjacency = new Map<string, WaitEdge[]>();
  for (const edge of endpointEdges.values()) {
    const targets = adjacency.get(edge.waiterId) ?? [];
    targets.push(edge);
    adjacency.set(edge.waiterId, targets);
  }
  for (const targets of adjacency.values()) {
    targets.sort(compareAdjacencyOrder);
  }

  const nodes = [...nodeSet].sort(compareStrings);
  const cycles = new Map<string, CanonicalCycle>();

  for (const start of nodes) {
    const path = [start];
    const pathEdges: WaitEdge[] = [];
    const visited = new Set([start]);

    const walk = (current: string): void => {
      for (const edge of adjacency.get(current) ?? []) {
        const next = edge.targetId;
        if (compareStrings(next, start) < 0) continue;
        if (next === start) {
          addCycle(cycles, [...path], [...pathEdges, edge]);
          continue;
        }
        if (visited.has(next)) continue;

        visited.add(next);
        path.push(next);
        pathEdges.push(edge);
        walk(next);
        pathEdges.pop();
        path.pop();
        visited.delete(next);
      }
    };

    walk(start);
  }

  return [...cycles.values()]
    .sort((left, right) => compareStringArrays(left.nodes, right.nodes))
    .map(({ nodes: cycleNodes, edges: cycleEdges }) => ({
      nodes: cycleNodes,
      edges: cycleEdges,
      recommendedBreakTarget: chooseBreakTarget(cycleEdges),
    }));
}

function addCycle(cycles: Map<string, CanonicalCycle>, nodes: string[], edges: WaitEdge[]): void {
  const rotated = canonicalRotation(nodes, edges);
  const key = JSON.stringify(rotated.nodes);
  if (!cycles.has(key)) {
    cycles.set(key, rotated);
  }
}

function canonicalRotation(nodes: string[], edges: WaitEdge[]): { nodes: string[]; edges: WaitEdge[] } {
  let bestStart = 0;
  for (let start = 1; start < nodes.length; start += 1) {
    if (compareRotations(nodes, start, bestStart) < 0) {
      bestStart = start;
    }
  }
  return { nodes: rotate(nodes, bestStart), edges: rotate(edges, bestStart) };
}

function compareRotations(nodes: readonly string[], leftStart: number, rightStart: number): number {
  for (let offset = 0; offset < nodes.length; offset += 1) {
    const left = nodes[(leftStart + offset) % nodes.length]!;
    const right = nodes[(rightStart + offset) % nodes.length]!;
    const compared = compareStrings(left, right);
    if (compared !== 0) return compared;
  }
  return 0;
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareStrings(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  return 0;
}

function rotate<T>(items: readonly T[], start: number): T[] {
  return [...items.slice(start), ...items.slice(0, start)];
}

function chooseBreakTarget(edges: readonly WaitEdge[]): WaitEdge {
  let best = edges[0]!;
  for (const edge of edges.slice(1)) {
    if (compareBreakPreference(edge, best) < 0) {
      best = edge;
    }
  }
  return best;
}

function compareBreakPreference(left: WaitEdge, right: WaitEdge): number {
  const leftWaitedMs = left.waitedMs ?? 0;
  const rightWaitedMs = right.waitedMs ?? 0;
  if (leftWaitedMs < rightWaitedMs) return -1;
  if (leftWaitedMs > rightWaitedMs) return 1;

  const waiterCompared = compareStrings(left.waiterId, right.waiterId);
  if (waiterCompared !== 0) return waiterCompared;

  const targetCompared = compareStrings(left.targetId, right.targetId);
  if (targetCompared !== 0) return targetCompared;

  return compareStrings(left.runId ?? "", right.runId ?? "");
}

function compareAdjacencyOrder(left: WaitEdge, right: WaitEdge): number {
  const targetCompared = compareStrings(left.targetId, right.targetId);
  if (targetCompared !== 0) return targetCompared;
  return compareStrings(left.runId ?? "", right.runId ?? "");
}

function endpointKey(waiterId: string, targetId: string): string {
  return JSON.stringify([waiterId, targetId]);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
