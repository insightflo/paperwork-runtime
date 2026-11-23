import fs from "node:fs/promises";
import path from "node:path";
import { buildPaperclipRuntimeBrief, joinPromptSections, renderTemplate, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { instructionInjectionRequiresSameSession } from "@paperclipai/adapter-utils/instructions";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { asString, asNumber, asBoolean, parseObject, parseJson, redactEnvForLogs, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { detectClaudeLoginRequired, isClaudeUnknownSessionError, parseClaudeStreamJson } from "./parse.js";
import { runClaudeRetryAttempt } from "./retry-start-result.js";
import { buildClaudeArgs, buildClaudeVisionDelegationBrief } from "./claude-flavor.js";
import {
  buildClaudeRuntimeConfig,
  buildSkillsDir,
  clearStalePyenvShimLock,
  hasClaudeToolFlag,
  prepareClaudeInstructionsFile,
  resolveClaudeBillingType,
  resolvePlanningRunDisallowedTools,
  shouldApplyPlanningRunToolRestrictions,
} from "./runtime-config.js";
import {
  createClaudeSessionReporter,
  isClaudeApiOverloaded,
  readApiErrorStatus,
  toClaudeAdapterResult,
  type ClaudeAttemptResult,
  type ClaudeSessionContext,
} from "./result-mapping.js";

function buildLoginResult(input: { proc: RunProcessResult; loginUrl: string | null }) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

/**
 * API overload(429/500/503/529) 시 같은 세션으로 backoff 재시도 설정.
 *
 * [목적] Claude/Anthropic API(또는 z.ai 등 wrapper endpoint)가 일시적 overload(529) 를
 *        반환할 때, adapter 가 즉시 failed 로 끝나면 workflow 엔진이 step 을 재dispatch
 *        하며 매번 새 issue 를 찍어내는 증식(가즈아 CMPA-5371/5373/5375...) 을 유발한다.
 *        이 대기-재시도는 adapter 안에서 같은 run/session 으로 backoff 후 재시도해 issue
 *        를 새로 만들지 않고 overload 를 극복한다(Anthropic SDK 의 exponential backoff 차용).
 * [주의] 각 runAttempt 는 timeoutSec 상한을 그대로 쓴다. N회 초과 시 그제 failed.
 * [수정시 영향] 기본값은 maxOverloadRetries=3, backoff=5s(exponential+jitter).
 *        agent config 의 maxOverloadRetries / overloadBackoffMs 로 조정.
 */
const DEFAULT_MAX_OVERLOAD_RETRIES = 3;
const DEFAULT_OVERLOAD_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({ proc, loginUrl: loginMeta.loginUrl });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. Use the local runtime from the PAPERCLIP_API_URL environment variable as the only API base URL, and include Authorization: Bearer $PAPERCLIP_API_KEY when the key is present. Never use https://runtime.paperclip.ai or any other legacy remote runtime during a local Papercompany heartbeat. For assignments, call GET $PAPERCLIP_API_URL/api/agents/me/inbox-lite first. Fall back only to GET $PAPERCLIP_API_URL/api/companies/{{agent.companyId}}/issues?assigneeAgentId={{agent.id}}&status=todo,in_progress,blocked when you need full issue objects. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. Never claim work by PATCHing an issue to in_progress; only POST $PAPERCLIP_API_URL/api/issues/{issueId}/checkout may move work into in_progress. Do not invent alternate completion routes such as mark-done; use PATCH $PAPERCLIP_API_URL/api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"} for done updates, PATCH with {\"status\":\"blocked\",\"comment\":\"blocker details\"} for blocked updates, and POST $PAPERCLIP_API_URL/api/issues/{issueId}/release only to give work back. If no assignments are returned from the local runtime, exit the heartbeat.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const configuredVisionCommand = asString(config.visionCommand, "").trim();
  const configuredVisionModel = asString(config.visionModel, "").trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, config.dangerouslySkipPermissions !== false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  const runtimeConfig = await buildClaudeRuntimeConfig({ runId, agent, config, context, authToken });
  const { command, cwd, workspaceId, workspaceRepoUrl, workspaceRepoRef, env, timeoutSec, graceSec, extraArgs } = runtimeConfig;
  const sessionContext: ClaudeSessionContext = { cwd, workspaceId, workspaceRepoUrl, workspaceRepoRef };
  const effectiveEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const billingType = resolveClaudeBillingType(effectiveEnv);
  await clearStalePyenvShimLock({ env: effectiveEnv, onLog });
  const skillsDir = await buildSkillsDir(config);
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  const commandNotes = resolvedInstructionsFilePath
    ? [`Injected agent instructions via --append-system-prompt-file ${resolvedInstructionsFilePath} (with path directive appended)`]
    : [];
  const shouldRestrictPlanningTools = shouldApplyPlanningRunToolRestrictions({ config, context });
  const extraArgsHaveDisallowedTools = hasClaudeToolFlag(extraArgs, ["--disallowedTools", "--disallowed-tools"]);
  const planningRunDisallowedTools = shouldRestrictPlanningTools && !extraArgsHaveDisallowedTools
    ? resolvePlanningRunDisallowedTools(config)
    : [];
  if (planningRunDisallowedTools.length > 0) {
    commandNotes.push(`Director/mission-owner planning run tool restriction: --disallowedTools ${planningRunDisallowedTools.join(",")}`);
  } else if (shouldRestrictPlanningTools && extraArgsHaveDisallowedTools) {
    commandNotes.push("Director/mission-owner planning run tool restriction skipped because extraArgs already define --disallowedTools.");
  }

  const effectiveInstructionsFilePath = resolvedInstructionsFilePath
    ? await prepareClaudeInstructionsFile({
        instructionsFilePath: resolvedInstructionsFilePath,
        context,
        skillsDir,
        onLog,
        commandNotes,
      })
    : undefined;

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession = runtimeSessionId.length > 0 && (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog("stdout", `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`);
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id, companyId: agent.companyId, runId,
    company: { id: agent.companyId }, agent, run: { id: runId, source: "on_demand" }, context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt = !sessionId && bootstrapPromptTemplate.trim().length > 0 ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "";
  const runtimeBrief = buildPaperclipRuntimeBrief(context);
  const visionDelegationBrief = buildClaudeVisionDelegationBrief({ visionCommand: configuredVisionCommand, visionModel: configuredVisionModel });
  const prompt = joinPromptSections([renderedBootstrapPrompt, runtimeBrief, visionDelegationBrief, renderedPrompt]);
  const promptMetrics = {
    promptChars: prompt.length, bootstrapPromptChars: renderedBootstrapPrompt.length, sessionHandoffChars: runtimeBrief.length,
    visionDelegationPromptChars: visionDelegationBrief.length, heartbeatPromptChars: renderedPrompt.length,
  };

  const sessionReporter = createClaudeSessionReporter({ onSessionUpdate: ctx.onSessionUpdate, sessionContext });

  const runAttempt = async (resumeSessionId: string | null): Promise<ClaudeAttemptResult> => {
    const args = buildClaudeArgs({
      resumeSessionId, model, effort, maxTurns, dangerouslySkipPermissions, chrome,
      instructionsFilePath: effectiveInstructionsFilePath, disallowedTools: planningRunDisallowedTools,
      skillsDir, extraArgs,
    });
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local", command, cwd, commandArgs: args, commandNotes,
        env: redactEnvForLogs(env), prompt, promptMetrics, context,
      });
    }

    let stdoutBuffer = "";
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      fatalOnLogError: true,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            await sessionReporter.onStdoutLine(line);
            await onLog(stream, `${line}\n`);
          }
          return;
        }
        await onLog(stream, chunk);
      },
    });
    if (stdoutBuffer) {
      await sessionReporter.onStdoutLine(stdoutBuffer);
      await onLog("stdout", stdoutBuffer);
    }

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: ClaudeAttemptResult,
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ) => toClaudeAdapterResult({ attempt, timeoutSec, sessionContext, model, billingType, ...opts });

  const maxOverloadRetries = Math.max(0, asNumber(config.maxOverloadRetries, DEFAULT_MAX_OVERLOAD_RETRIES));
  const overloadBackoffMs = Math.max(0, asNumber(config.overloadBackoffMs, DEFAULT_OVERLOAD_BACKOFF_MS));
  try {
    let attempt = await runAttempt(sessionId ?? null);
    for (
      let overloadAttempt = 0;
      overloadAttempt < maxOverloadRetries && isClaudeApiOverloaded(attempt.parsed);
      overloadAttempt += 1
    ) {
      const waitMs = overloadBackoffMs * 2 ** overloadAttempt + Math.floor(Math.random() * 500);
      await ctx.onLog(
        "stdout",
        `[paperclip] Claude API overloaded (status ${readApiErrorStatus(attempt.parsed ?? ({} as Record<string, unknown>))}); retry ${overloadAttempt + 1}/${maxOverloadRetries} after ~${Math.round(waitMs / 1000)}s with the same session (no new issue).\n`,
      );
      await sleep(waitMs);
      const retry = await runClaudeRetryAttempt(attempt, () => runAttempt(sessionId ?? null));
      attempt = retry.attempt;
      if (retry.startBlocked) break;
    }
    const initial = attempt;
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      if (instructionInjectionRequiresSameSession(context)) {
        return toAdapterResult(initial, { fallbackSessionId: null, clearSessionOnMissingSession: true });
      }
      await onLog("stdout", `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`);
      const retry = await runClaudeRetryAttempt(initial, () => runAttempt(null));
      return toAdapterResult(retry.attempt, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}
