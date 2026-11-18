import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPaperclipRuntimeBrief,
  joinPromptSections,
  renderTemplate,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  applyInstructionInjectionPolicy,
  clearInstructionInjectionDelivery,
  loadInstructionsWithInlinedReferences,
} from "@paperclipai/adapter-utils/instructions";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  buildPaperclipExecutionEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  sanitizeInheritedPaperclipEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveAntigravitySkillPrompt } from "./skills.js";
import {
  buildAntigravityArgs,
  buildAntigravityExecutionNote,
  resolveAntigravityBypassPermissions,
  resolveAntigravityModelAndEffort,
  resolveAntigravityPrintTimeout,
  type BuildAntigravityArgsInput,
} from "./args.js";

export {
  buildAntigravityArgs,
  buildAntigravityExecutionNote,
  resolveAntigravityBypassPermissions,
  resolveAntigravityPrintTimeout,
  type BuildAntigravityArgsInput,
};

export function extractLatestAntigravityResponse(stdout: string): string {
  const normalized = stdout.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const blocks = normalized
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const latestBlock = blocks.length > 0 ? blocks[blocks.length - 1] : normalized;
  const lines = latestBlock.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (blocks.length <= 1 && lines.length > 1) {
    return lines[lines.length - 1]?.trim() ?? "";
  }
  return lines.join("\n").trim();
}

export interface ResolveAntigravityFailureInput {
  exitCode: number | null | undefined;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  latestResponse: string;
  diagnosticLog?: string;
}

function extractAntigravityQuotaMessage(diagnosticLog: string): string | null {
  const match = diagnosticLog.match(/RESOURCE_EXHAUSTED \(code 429\):\s*([^\n]+)/i);
  if (!match) return null;
  return `RESOURCE_EXHAUSTED (code 429): ${match[1]?.trim() ?? "quota exhausted"}`;
}

function extractAntigravityMonitorDenial(diagnosticLog: string): string | null {
  const matches = [...diagnosticLog.matchAll(/Monitor\s+\S+\s+FINISHED:\s+triggered=true,\s+reason="([^"]+)"/gi)];
  const last = matches.at(-1);
  return last?.[1]?.trim() || null;
}

export function resolveAntigravityFailure(
  input: ResolveAntigravityFailureInput,
): { errorMessage: string; errorCode: string } | null {
  if (input.timedOut) {
    return { errorMessage: input.latestResponse || "Antigravity CLI timed out", errorCode: "adapter_failed" };
  }
  if ((input.exitCode ?? 0) !== 0) {
    const monitorDenial = extractAntigravityMonitorDenial(input.diagnosticLog ?? "");
    return {
      errorMessage:
        extractLatestAntigravityResponse(input.stderr) ||
        input.latestResponse ||
        (monitorDenial ? `Antigravity safety monitor denied execution: ${monitorDenial}` : null) ||
        "Antigravity CLI failed",
      errorCode: "adapter_failed",
    };
  }
  if (/^Error:\s*timed out waiting for response\s*$/i.test(input.latestResponse.trim())) {
    return { errorMessage: input.latestResponse.trim(), errorCode: "adapter_failed" };
  }
  if (!input.latestResponse.trim() && !input.stdout.trim() && !input.stderr.trim()) {
    const quotaMessage = extractAntigravityQuotaMessage(input.diagnosticLog ?? "");
    if (quotaMessage) {
      return {
        errorMessage: `Antigravity provider quota exhausted: ${quotaMessage}`,
        errorCode: "provider_quota_exhausted",
      };
    }
    const monitorDenial = extractAntigravityMonitorDenial(input.diagnosticLog ?? "");
    if (monitorDenial) {
      return {
        errorMessage: `Antigravity safety monitor denied execution: ${monitorDenial}`,
        errorCode: "adapter_failed",
      };
    }
    return { errorMessage: "Antigravity CLI exited without producing a response", errorCode: "adapter_failed" };
  }
  return null;
}

function antigravityConversationCachePath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "cache", "last_conversations.json");
}

export async function readConversationIdForCwdFromCache(
  cwd: string,
  readCache: () => Promise<string> = () => fs.readFile(antigravityConversationCachePath(), "utf8"),
): Promise<string | null> {
  let raw = "";
  try {
    raw = await readCache();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const resolvedCwd = path.resolve(cwd);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (path.resolve(key) === resolvedCwd && typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readRuntimeSession(runtime: AdapterExecutionContext["runtime"], cwd: string): string | null {
  const params = parseObject(runtime.sessionParams);
  const sessionId = asString(params.sessionId, runtime.sessionId ?? "").trim();
  const sessionCwd = asString(params.cwd, "").trim();
  if (!sessionId) return null;
  if (sessionCwd && path.resolve(sessionCwd) !== path.resolve(cwd)) return null;
  return sessionId;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. Use the Paperclip API and assigned issue context before taking action.",
  );
  const command = asString(config.command, "agy");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent, { context }), PAPERCLIP_RUN_ID: runId };
  const configuredEnv = buildPaperclipExecutionEnv(env, envConfig, authToken);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...configuredEnv })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const loadedInstructions = applyInstructionInjectionPolicy(
        await loadInstructionsWithInlinedReferences(resolvedInstructionsFilePath),
        ctx.context,
      );
      instructionsPrefix = `${loadedInstructions.content}\n\n`;
      await onLog("stderr", `[paperclip] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`);
      for (const includedPath of loadedInstructions.includedPaths) {
        await onLog("stderr", `[paperclip] Inlined referenced agent instructions file: ${includedPath}\n`);
      }
      for (const warning of loadedInstructions.warnings) {
        await onLog("stderr", `[paperclip] Warning: ${warning}\n`);
      }
    } catch (err) {
      clearInstructionInjectionDelivery(ctx.context);
      instructionsPrefix = "";
      await onLog("stderr", `[paperclip] Failed to read instructions file ${resolvedInstructionsFilePath}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const model = asString(config.model, "auto").trim() || "auto";
  const effort = asString(config.effort, "").trim();
  const chrome = asBoolean(config.chrome, false);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const bypassPermissions = resolveAntigravityBypassPermissions(config);
  const sandbox = asBoolean(config.sandbox, false);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const printTimeout = resolveAntigravityPrintTimeout({
    printTimeout: config.printTimeout,
    printTimeoutSec: config.printTimeoutSec,
    timeoutSec,
    extraArgs,
  });
  const prompt = joinPromptSections([
    instructionsPrefix.trim(),
    await resolveAntigravitySkillPrompt(config),
    renderTemplate(promptTemplate, { agent, runtime, context, config }),
    buildPaperclipRuntimeBrief({ agent, runtime, context }),
    buildAntigravityExecutionNote({ sandbox }),
  ]);

  const { conflictWarning } = resolveAntigravityModelAndEffort({ model, effort, extraArgs });
  if (conflictWarning) {
    await onLog("stderr", `[paperclip] ${conflictWarning}\n`);
  }
  const sessionId = readRuntimeSession(runtime, cwd);
  const diagnosticLogFilePath = path.join(os.tmpdir(), `paperclip-antigravity-${runId}.log`);
  await fs.rm(diagnosticLogFilePath, { force: true });
  const args = buildAntigravityArgs({
    cwd,
    prompt,
    printTimeout,
    bypassPermissions,
    sandbox,
    sessionId,
    extraArgs,
    diagnosticLogFilePath,
    model,
    effort,
  });

  await onMeta?.({
    adapterType: "antigravity_local",
    command,
    cwd,
    commandArgs: args,
    env: configuredEnv,
    prompt,
    context: { sessionId, model, effort, chromeSupportedByCurrentCli: false, chromeRequested: chrome },
  });

  const graceSec = asNumber(config.graceSec, 20);
  const child = await runChildProcess(`antigravity-${runId}`, command, args, {
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
  });

  const nextSessionId = await readConversationIdForCwdFromCache(cwd);
  let diagnosticLog = "";
  try {
    diagnosticLog = await fs.readFile(diagnosticLogFilePath, "utf8");
  } catch {
    diagnosticLog = "";
  }
  const summary = extractLatestAntigravityResponse(child.stdout);
  const failure = resolveAntigravityFailure({
    exitCode: child.exitCode,
    timedOut: child.timedOut,
    stdout: child.stdout,
    stderr: child.stderr,
    latestResponse: summary,
    diagnosticLog,
  });
  await fs.rm(diagnosticLogFilePath, { force: true });
  if (nextSessionId) {
    await ctx.onSessionUpdate?.({
      sessionId: nextSessionId,
      sessionParams: { sessionId: nextSessionId, cwd },
      sessionDisplayId: nextSessionId,
      source: "adapter",
      confidence: "provider_reported",
      observedAt: new Date().toISOString(),
    });
  }

  return {
    exitCode: child.exitCode,
    signal: child.signal,
    timedOut: child.timedOut,
    summary,
    sessionId: nextSessionId ?? sessionId,
    sessionParams: nextSessionId ? { sessionId: nextSessionId, cwd } : sessionId ? { sessionId, cwd } : null,
    sessionDisplayId: nextSessionId ?? sessionId,
    provider: "google",
    biller: "antigravity",
    model,
    billingType: "unknown",
    resultJson: {
      stdout: child.stdout,
      stderr: child.stderr,
      latestResponse: summary,
      diagnosticLogExcerpt: diagnosticLog.slice(-4000),
    },
    ...(failure ?? {}),
  };
}
