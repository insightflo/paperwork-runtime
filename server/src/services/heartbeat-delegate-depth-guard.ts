export interface DelegationGuardInput {
  parentAgentId: string;
  targetAgentId: string;
  currentDepth: number;
  activeChildrenCount: number;
  ancestorAgentIds?: readonly string[];
  maxDepth?: number;
  maxActiveChildren?: number;
}

export type DelegationRejectReason =
  | "max_depth_exceeded"
  | "max_active_children_exceeded"
  | "cycle_detected";

export type DelegationGuardResult =
  | { allowed: true }
  | { allowed: false; reason: DelegationRejectReason; detail: string };

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ACTIVE_CHILDREN = 4;

export function evaluateDelegationGuard(input: DelegationGuardInput): DelegationGuardResult {
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxActiveChildren = input.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN;

  if (input.targetAgentId === input.parentAgentId
    || input.ancestorAgentIds?.includes(input.targetAgentId)) {
    return {
      allowed: false,
      reason: "cycle_detected",
      detail: `Delegation target "${input.targetAgentId}" is the parent or an ancestor of "${input.parentAgentId}".`,
    };
  }

  if (input.currentDepth >= maxDepth) {
    return {
      allowed: false,
      reason: "max_depth_exceeded",
      detail: `Delegation depth ${input.currentDepth} reaches the configured maximum of ${maxDepth}.`,
    };
  }

  if (input.activeChildrenCount >= maxActiveChildren) {
    return {
      allowed: false,
      reason: "max_active_children_exceeded",
      detail: `Active child count ${input.activeChildrenCount} reaches the configured maximum of ${maxActiveChildren}.`,
    };
  }

  return { allowed: true };
}
