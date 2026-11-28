import path from "node:path";
import { renderTemplate, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildPaperclipExecutionEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  redactEnvForLogs,
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { DEVIN_LOCAL_DEFAULT_MODEL } from "./models.js";
import {
  buildDevinLocalArgs,
  devinLocalSessionCodec,
  isDevinLocalUnknownSessionError,
  parseDevinLocalOutput,
} from "./parse.js";

const DEFAULT_PROMPT_TEMPLATE =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. For assignments, use GET /api/agents/me/inbox-lite first. Fall back only to the company issues endpoint filtered by assigneeAgentId with statuses todo,in_progress,blocked. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. If no assignments are returned, exit the heartbeat.";

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function resolveCwd(config: Record<string, unknown>, context: Record<string, unknown>): string {
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const preferConfigured = asString(workspace.source, "") === "agent_home" && configuredCwd.length > 0;
  return (preferConfigured ? "" : workspaceCwd) || configuredCwd || process.cwd();
}

function resolveExtraArgs(config: Record<string, unknown>): string[] {
  const extraArgs = asStringArray(config.extraArgs);
  return extraArgs.length > 0 ? extraArgs : asStringArray(config.args);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const command = asString(config.command, "devin");
  const model = asString(config.model, DEVIN_LOCAL_DEFAULT_MODEL).trim() || DEVIN_LOCAL_DEFAULT_MODEL;
  const permissionMode = asString(config.permissionMode, "dangerous").trim() || "dangerous";
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const cwd = resolveCwd(config, context);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const baseEnv: Record<string, string> = { ...buildPaperclipEnv(agent, { context }) };
  baseEnv.PAPERCLIP_RUN_ID = runId;
  const executionEnv = buildPaperclipExecutionEnv(baseEnv, parseObject(config.env), authToken);
  const runtimeEnv = Object.fromEntries(
    Object.entries(
      ensurePathInEnv({
        ...sanitizeInheritedPaperclipEnv(process.env),
        ...executionEnv,
      }),
    ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const prompt = renderTemplate(promptTemplate, templateData);
  const extraArgs = resolveExtraArgs(config);

  const storedSession = devinLocalSessionCodec.deserialize(runtime.sessionParams) ?? {};
  const storedSessionId = asString(storedSession.sessionId, asString(runtime.sessionId, ""));
  const storedSessionCwd = asString(storedSession.cwd, "");
  const canResume =
    storedSessionId.length > 0 &&
    (storedSessionCwd.length === 0 || path.resolve(storedSessionCwd) === path.resolve(cwd));
  let resumeSessionId = canResume ? storedSessionId : null;

  if (storedSessionId && !canResume) {
    await onLog(
      "stdout",
      `[paperclip] Devin session "${storedSessionId}" was saved for cwd "${storedSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const buildArgs = (sessionId: string | null) =>
    buildDevinLocalArgs({
      model,
      permissionMode,
      sessionId,
      extraArgs,
      prompt,
    });

  if (onMeta) {
    await onMeta({
      adapterType: "devin_local",
      command,
      cwd,
      commandArgs: buildArgs(resumeSessionId),
      env: redactEnvForLogs(executionEnv),
      prompt,
      promptMetrics: { promptChars: prompt.length },
      context,
    });
  }

  const runAttempt = (sessionId: string | null) =>
    runChildProcess(runId, command, buildArgs(sessionId), {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
      stdin: "",
    });

  let proc = await runAttempt(resumeSessionId);
  let sawUnknownSession = false;
  if (
    resumeSessionId &&
    !proc.timedOut &&
    ((proc.exitCode ?? 0) !== 0 || proc.signal) &&
    isDevinLocalUnknownSessionError(proc.stdout, proc.stderr)
  ) {
    sawUnknownSession = true;
    await onLog(
      "stdout",
      `[paperclip] Devin session "${resumeSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    resumeSessionId = null;
    proc = await runAttempt(null);
  }

  const parsed = parseDevinLocalOutput(proc.stdout);
  const sessionId = parsed.sessionId ?? resumeSessionId;
  const sessionParams = sessionId ? { sessionId, cwd } : null;
  const clearSession = sawUnknownSession && !sessionId;

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      sessionId,
      sessionParams,
      sessionDisplayId: sessionId,
      clearSession,
    };
  }

  const exitCode = proc.exitCode;
  const failed = (exitCode ?? 0) !== 0 || Boolean(proc.signal);
  const stderrLine = firstNonEmptyLine(proc.stderr);
  return {
    exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: failed ? stderrLine || `Devin exited with code ${exitCode ?? -1}` : null,
    usage: parsed.usage,
    sessionId,
    sessionParams,
    sessionDisplayId: sessionId,
    provider: "devin",
    biller: "devin",
    model,
    billingType: "unknown",
    costUsd: null,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
    summary: parsed.summary,
    clearSession,
  };
}
