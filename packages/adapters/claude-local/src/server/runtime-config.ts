import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { applyInstructionInjectionPolicy, clearInstructionInjectionDelivery, loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import { asBoolean, asNumber, asString, asStringArray, buildPaperclipEnv, ensureAbsoluteDirectory, ensureCommandResolvable, ensurePathInEnv, parseObject, readPaperclipRuntimeSkillEntries } from "@paperclipai/adapter-utils/server-utils";
import { resolveClaudeDesiredSkillNames } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

export interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

export function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

export function resolvePyenvShimLockPath(env: Record<string, string>): string {
  const pyenvRoot = env.PYENV_ROOT?.trim();
  if (pyenvRoot) return path.join(pyenvRoot, "shims", ".pyenv-shim");
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, ".pyenv", "shims", ".pyenv-shim");
}

export async function clearStalePyenvShimLock(input: {
  env: Record<string, string>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const disable = input.env.PAPERCLIP_DISABLE_PYENV_SHIM_LOCK_PREFLIGHT?.trim();
  if (disable === "1" || disable === "true") return;

  const rawStaleMs = Number(input.env.PAPERCLIP_PYENV_SHIM_LOCK_STALE_MS ?? "90000");
  const staleMs = Number.isFinite(rawStaleMs) && rawStaleMs >= 0 ? rawStaleMs : 90000;
  const lockPath = resolvePyenvShimLockPath(input.env);
  const nowMs = input.nowMs ?? Date.now();

  try {
    const stat = await fs.stat(lockPath);
    const ageMs = nowMs - stat.mtimeMs;
    if (ageMs < staleMs) return;
    await fs.rm(lockPath, { force: true });
    await input.onLog("stderr", `[paperclip] Removed stale pyenv shim lock before Claude launch: ${lockPath} ageMs=${Math.round(ageMs)}\n`);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "ENOENT") return;
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Warning: pyenv shim lock preflight failed for ${lockPath}: ${reason}\n`);
  }
}

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills from
 * the repo's `skills/` directory, so `--add-dir` makes Claude Code discover
 * them as proper registered skills.
 */
export async function buildSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveClaudeDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return tmp;
}

const DEFAULT_PLANNING_RUN_DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "Task"];

export function hasClaudeToolFlag(args: string[], flagNames: string[]): boolean {
  return args.some((arg) => flagNames.some((flagName) => arg === flagName || arg.startsWith(`${flagName}=`)));
}

export function resolveMissionOwnerPlanningContext(context: Record<string, unknown>): Record<string, unknown> | null {
  const manifest = parseObject(context.paperclipStepInputManifest);
  const manifestInputs = parseObject(manifest.inputs);
  const manifestPlanningContext = parseObject(manifestInputs.missionOwnerPlanningContext);
  if (manifestPlanningContext.available === true) return manifestPlanningContext;

  const directPlanningContext = parseObject(context.paperclipMissionOwnerPlanningContext);
  return Object.keys(directPlanningContext).length > 0 ? directPlanningContext : null;
}

export function resolvePlanningRunDisallowedTools(config: Record<string, unknown>): string[] {
  const configured = asStringArray(config.planningRunDisallowedTools).map((tool) => tool.trim()).filter(Boolean);
  const tools = configured.length > 0 ? configured : DEFAULT_PLANNING_RUN_DISALLOWED_TOOLS;
  return Array.from(new Set(tools));
}

export function shouldApplyPlanningRunToolRestrictions(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
}): boolean {
  return asBoolean(input.config.planningRunToolRestrictions, true) === true
    && resolveMissionOwnerPlanningContext(input.context) !== null;
}

export async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceField = (key: string) => asString(workspaceContext[key], "") || null;
  const workspaceId = workspaceField("workspaceId");
  const workspaceRepoUrl = workspaceField("repoUrl");
  const workspaceRepoRef = workspaceField("repoRef");
  const workspaceBranch = workspaceField("branchName");
  const workspaceWorktreePath = workspaceField("worktreePath");
  const agentHome = workspaceField("agentHome");
  const recordArray = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
  const workspaceHints = recordArray(context.paperclipWorkspaces);
  const runtimeServiceIntents = recordArray(context.paperclipRuntimeServiceIntents);
  const runtimeServices = recordArray(context.paperclipRuntimeServices);
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey = typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent, { context }) };
  env.PAPERCLIP_RUN_ID = runId;

  // papercompany: Support isolated agent config directory when explicitly configured.
  // Do not set CLAUDE_CONFIG_DIR by default: Claude Code's subscription login is tied
  // to its default config resolution, and pointing CLAUDE_CONFIG_DIR at either an empty
  // value or ~/.claude makes the CLI report "Not logged in" on this host.
  const agentConfigDir = asString(config.claudeConfigDir, "") || process.env.PAPERCLIP_AGENT_CLAUDE_CONFIG_DIR || "";
  if (agentConfigDir) env.CLAUDE_CONFIG_DIR = agentConfigDir;

  const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
  const wakeTaskId = nonEmpty(context.taskId) ?? nonEmpty(context.issueId);
  const wakeReason = nonEmpty(context.wakeReason);
  const wakeCommentId = nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId);
  const approvalId = nonEmpty(context.approvalId);
  const approvalStatus = nonEmpty(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const envEntries: Array<[string, string | null]> = [
    ["PAPERCLIP_TASK_ID", wakeTaskId],
    ["PAPERCLIP_WAKE_REASON", wakeReason],
    ["PAPERCLIP_WAKE_COMMENT_ID", wakeCommentId],
    ["PAPERCLIP_APPROVAL_ID", approvalId],
    ["PAPERCLIP_APPROVAL_STATUS", approvalStatus],
    ["PAPERCLIP_LINKED_ISSUE_IDS", linkedIssueIds.length > 0 ? linkedIssueIds.join(",") : null],
    ["PAPERCLIP_WORKSPACE_CWD", effectiveWorkspaceCwd || null],
    ["PAPERCLIP_WORKSPACE_SOURCE", workspaceSource || null],
    ["PAPERCLIP_WORKSPACE_STRATEGY", workspaceStrategy || null],
    ["PAPERCLIP_WORKSPACE_ID", workspaceId],
    ["PAPERCLIP_WORKSPACE_REPO_URL", workspaceRepoUrl],
    ["PAPERCLIP_WORKSPACE_REPO_REF", workspaceRepoRef],
    ["PAPERCLIP_WORKSPACE_BRANCH", workspaceBranch],
    ["PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspaceWorktreePath],
    ["AGENT_HOME", agentHome],
    ["PAPERCLIP_WORKSPACES_JSON", workspaceHints.length > 0 ? JSON.stringify(workspaceHints) : null],
    ["PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON", runtimeServiceIntents.length > 0 ? JSON.stringify(runtimeServiceIntents) : null],
    ["PAPERCLIP_RUNTIME_SERVICES_JSON", runtimeServices.length > 0 ? JSON.stringify(runtimeServices) : null],
    ["PAPERCLIP_RUNTIME_PRIMARY_URL", runtimePrimaryUrl || null],
  ];
  for (const [key, value] of envEntries) {
    if (value) env[key] = value;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extra = asStringArray(config.extraArgs);
  const extraArgs = extra.length > 0 ? extra : asStringArray(config.args);

  return { command, cwd, workspaceId, workspaceRepoUrl, workspaceRepoRef, env, timeoutSec, graceSec, extraArgs };
}

// When instructionsFilePath is configured, create a combined temp file that
// includes both the file content and the path directive, so we only need
// --append-system-prompt-file (Claude CLI forbids using both flags together).
export async function prepareClaudeInstructionsFile(input: {
  instructionsFilePath: string;
  context: Record<string, unknown>;
  skillsDir: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  commandNotes: string[];
}): Promise<string | undefined> {
  const resolvedInstructionsFilePath = input.instructionsFilePath;
  const instructionsFileDir = `${path.dirname(resolvedInstructionsFilePath)}/`;
  try {
    const loadedInstructions = applyInstructionInjectionPolicy(
      await loadInstructionsWithInlinedReferences(resolvedInstructionsFilePath),
      input.context,
    );
    const pathDirective = `\nThe above agent instructions were loaded from ${resolvedInstructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
    const combinedPath = path.join(input.skillsDir, "agent-instructions.md");
    await fs.writeFile(combinedPath, loadedInstructions.content + pathDirective, "utf-8");
    await input.onLog("stderr", `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`);
    for (const includedPath of loadedInstructions.includedPaths) {
      await input.onLog("stderr", `[paperclip] Inlined referenced agent instructions file: ${includedPath}\n`);
    }
    for (const warning of loadedInstructions.warnings) {
      await input.onLog("stderr", `[paperclip] Warning: ${warning}\n`);
    }
    return combinedPath;
  } catch (err) {
    clearInstructionInjectionDelivery(input.context);
    const injectedNoteIndex = input.commandNotes.findIndex((note) => note.startsWith("Injected agent instructions"));
    if (injectedNoteIndex >= 0) input.commandNotes.splice(injectedNoteIndex, 1);
    input.commandNotes.push(`Instructions file ${resolvedInstructionsFilePath} could not be read; continuing without it.`);
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`);
    return undefined;
  }
}
