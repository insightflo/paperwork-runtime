export const RUST_CORE_CUTOVER_ENV_KEYS = [
  "PAPERWORK_ENGINE_APPROVAL_CUTOVER",
  "PAPERWORK_ENGINE_BUDGET_CUTOVER",
  "PAPERWORK_ENGINE_HEARTBEAT_CUTOVER",
  "PAPERWORK_ENGINE_SCHEDULE_CUTOVER",
  "PAPERWORK_ENGINE_WORKFLOW_CUTOVER",
  "PAPERWORK_RUST_ACTIVITY_CUTOVER",
  "PAPERWORK_RUST_AGENT_CUTOVER",
  "PAPERWORK_RUST_COMPANY_CUTOVER",
  "PAPERWORK_RUST_COST_CUTOVER",
  "PAPERWORK_RUST_DECISION_CUTOVER",
  "PAPERWORK_RUST_HEARTBEAT_RUN_CUTOVER",
  "PAPERWORK_RUST_ISSUE_CUTOVER",
  "PAPERWORK_RUST_KNOWLEDGE_CUTOVER",
  "PAPERWORK_RUST_MISSION_CUTOVER",
  "PAPERWORK_RUST_REDACTOR_CUTOVER",
  "PAPERWORK_RUST_SECRET_CUTOVER",
  "PAPERWORK_RUST_SKILL_CUTOVER",
  "PAPERWORK_RUST_TOOL_CUTOVER",
  "PAPERWORK_RUST_WIKI_CUTOVER",
  "PAPERWORK_RUST_WORKTREE_CUTOVER",
] as const;

function listEnabledKeys(env: NodeJS.ProcessEnv): string[] {
  return RUST_CORE_CUTOVER_ENV_KEYS.filter((key) => env[key] === "1");
}

export function applyUnifiedRustCoreCutoverEnv(
  env: NodeJS.ProcessEnv = process.env,
): { masterEnabled: boolean; enabledKeys: string[]; optedOutKeys: string[] } {
  const masterEnabled = env.PAPERWORK_RUST_CORE_ALL === "1";
  const optedOutKeys: string[] = [];

  if (masterEnabled) {
    for (const key of RUST_CORE_CUTOVER_ENV_KEYS) {
      if (env[key] === "0") {
        optedOutKeys.push(key);
        continue;
      }
      if (env[key] === undefined || env[key] === "") {
        env[key] = "1";
      }
    }
  }

  return {
    masterEnabled,
    enabledKeys: listEnabledKeys(env),
    optedOutKeys,
  };
}

export function getRustCoreCutoverStatus(
  env: NodeJS.ProcessEnv = process.env,
): { masterEnabled: boolean; total: number; enabled: string[]; disabled: string[] } {
  const enabled = listEnabledKeys(env);
  const enabledSet = new Set(enabled);

  return {
    masterEnabled: env.PAPERWORK_RUST_CORE_ALL === "1",
    total: RUST_CORE_CUTOVER_ENV_KEYS.length,
    enabled,
    disabled: RUST_CORE_CUTOVER_ENV_KEYS.filter((key) => !enabledSet.has(key)),
  };
}
