/**
 * Config hygiene pre-flight warnings — universal, non-breaking advisories computed
 * when a workflow definition or agent config is saved. They never reject a write;
 * callers surface them via logger.warn and the CONFIG_HYGIENE_WARNINGS_HEADER
 * response header so existing JSON response contracts stay untouched.
 *
 * Rationale (Oracle A1 2026-11-22 incident): thinking/effort "max" on routine roles
 * burned ~90k output tokens / ~18.5min per step; 7-8 serial LLM step chains set a
 * 30+min latency floor for every run.
 */

export const MAX_RECOMMENDED_SERIAL_LLM_DEPTH = 5;
export const CONFIG_HYGIENE_WARNINGS_HEADER = "X-Paperclip-Config-Warnings";

export interface ConfigHygieneWarning {
  code: string;
  severity: "warn";
  message: string;
}

/** Steps that are not LLM invocations: tool steps and native control nodes. */
const NON_LLM_STEP_TYPES = new Set(["if", "complete"]);

/** Roles allowed a higher reasoning ceiling; exempt from the "max" warning. */
const HIGH_REASONING_ROLES = new Set(["ceo", "qa"]);
/** Non-engineering roles that should pin an explicit low effort on commandcode_local. */
const COMMANDCODE_LIGHT_ROLES = new Set(["pm", "researcher", "general"]);

function isStepRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLlmStep(step: Record<string, unknown>): boolean {
  if (step.toolName) return false;
  return !(typeof step.type === "string" && NON_LLM_STEP_TYPES.has(step.type));
}

function predecessorStepIds(step: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) ids.push(value);
  };
  if (Array.isArray(step.dependencies)) step.dependencies.forEach(push);
  if (Array.isArray(step.dependsOn)) step.dependsOn.forEach(push);
  if (Array.isArray(step.conditionalDependencies)) {
    for (const edge of step.conditionalDependencies) {
      if (isStepRecord(edge)) push(edge.stepId);
    }
  }
  return ids;
}

/**
 * Longest ancestor chain measured in LLM steps. Tool/if/complete steps add 0 but
 * do not break the chain — LLM calls separated by cheap tool steps still execute
 * serially and set the latency floor. Cycles (annotated back-edges) are cut.
 */
export function collectWorkflowAuthoringWarnings(steps: unknown[]): ConfigHygieneWarning[] {
  if (!Array.isArray(steps)) return [];
  const records = steps.filter(isStepRecord);
  const byId = new Map<string, Record<string, unknown>>();
  for (const step of records) {
    if (typeof step.id === "string" && step.id.length > 0) byId.set(step.id, step);
  }

  const memo = new Map<Record<string, unknown>, number>();
  const visiting = new Set<Record<string, unknown>>();
  const depthOf = (step: Record<string, unknown>): number => {
    const cached = memo.get(step);
    if (cached !== undefined) return cached;
    if (visiting.has(step)) return 0;
    visiting.add(step);
    let deepest = 0;
    for (const predId of predecessorStepIds(step)) {
      const pred = byId.get(predId);
      if (pred) deepest = Math.max(deepest, depthOf(pred));
    }
    visiting.delete(step);
    const depth = deepest + (isLlmStep(step) ? 1 : 0);
    memo.set(step, depth);
    return depth;
  };

  let maxLlmDepth = 0;
  for (const step of records) maxLlmDepth = Math.max(maxLlmDepth, depthOf(step));
  if (maxLlmDepth <= MAX_RECOMMENDED_SERIAL_LLM_DEPTH) return [];

  return [{
    code: "workflow_serial_llm_depth_high",
    severity: "warn",
    message: `Workflow chains ${maxLlmDepth} serial LLM steps (recommended <= ${MAX_RECOMMENDED_SERIAL_LLM_DEPTH}); long serial LLM chains set a high per-run latency floor — split, parallelize, or move work into tool steps.`,
  }];
}

export function collectAgentConfigHygieneWarnings(input: {
  role?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}): ConfigHygieneWarning[] {
  const warnings: ConfigHygieneWarning[] = [];
  const role = typeof input.role === "string" ? input.role.trim().toLowerCase() : "";
  const config = input.adapterConfig ?? {};
  const normalizeLevel = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  const thinking = normalizeLevel(config.thinking);
  const effort = normalizeLevel(config.effort);

  if (!HIGH_REASONING_ROLES.has(role) && (thinking === "max" || effort === "max")) {
    warnings.push({
      code: "agent_excessive_thinking",
      severity: "warn",
      message: `Agent role '${input.role ?? "unknown"}' sets thinking/effort 'max' (measured ~90k output tokens / ~18.5min per step); recommended 'low' ('medium' is the ceiling for ceo/qa roles).`,
    });
  }

  if (
    input.adapterType === "commandcode_local" &&
    effort === undefined &&
    COMMANDCODE_LIGHT_ROLES.has(role)
  ) {
    warnings.push({
      code: "agent_unset_commandcode_effort",
      severity: "warn",
      message: `commandcode_local agent role '${role}' leaves adapterConfig.effort unset; set effort: "low" explicitly so routine work does not default to high-effort runs.`,
    });
  }

  return warnings;
}
