import path from "node:path";
import {
  DRIVER_EVENT_PROTOCOL_VERSION,
  driverArgsList,
  isTrustedProtocolEvent,
  parseDriverFrame,
  resolveDriverCwd,
  stripReservedDriverArgs,
  type AcpFlavor,
  type AcpFlavorRetryDecision,
  type DriverStreamOrigin,
  type ParsedDriverEvent,
  type ProtocolTransport,
} from "./acp-flavor.js";
import { buildPaperclipEnv, buildPaperclipExecutionEnv } from "./paperclip-env.js";
import { joinPromptSections, renderTemplate } from "./prompt-utils.js";
import { buildPaperclipRuntimeBrief } from "./runtime-brief.js";
import {
  asNumber,
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  parseObject,
  redactEnvForLogs,
  runChildProcess,
  type RunProcessResult,
} from "./server-utils.js";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSessionUpdate,
  UsageSummary,
} from "./types.js";

export interface DriverStreamRunOptions {
  runId: string; command: string; args: string[]; cwd: string;
  env: Record<string, string>; timeoutSec: number; graceSec: number;
  stdin?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  onEvent?: (event: ParsedDriverEvent) => void | Promise<void>;
}

export type ChildProcessStreamRunner = (opts: DriverStreamRunOptions) => Promise<RunProcessResult>;

type OSPipe = "stdout" | "stderr";

function lineToDriverEvent(
  stream: OSPipe,
  line: string,
  protocolTransport: ProtocolTransport,
): ParsedDriverEvent {
  if (stream === "stderr") {
    return { protocolVersion: DRIVER_EVENT_PROTOCOL_VERSION, kind: "output", origin: "stderr", text: line };
  }
  const origin: DriverStreamOrigin =
    protocolTransport === "stdout_protocol" ? "provider_protocol" : "agent_output";
  const frame = origin === "provider_protocol" ? parseDriverFrame(line) : null;
  return frame
    ? { ...frame, origin }
    : { protocolVersion: DRIVER_EVENT_PROTOCOL_VERSION, kind: "output", origin, text: line };
}

/**
 * Wraps runChildProcess with transport-derived provenance: stderr is always
 * `stderr`; stdout is `provider_protocol` only under `stdout_protocol` (else
 * `agent_output`). Frames parse only on provider_protocol, so spoofed JSON on
 * stderr or inside agent text can never become a trusted protocol event.
 */
export function createChildProcessStreamRunner(
  protocolTransport: ProtocolTransport,
): ChildProcessStreamRunner {
  return async (opts) => {
    const buffers: Record<OSPipe, string> = { stdout: "", stderr: "" };
    let eventChain: Promise<void> = Promise.resolve();
    const emitLine = (stream: OSPipe, line: string) => {
      const text = line.replace(/\r$/, "");
      if (text.length === 0) return;
      const event = lineToDriverEvent(stream, text, protocolTransport);
      eventChain = eventChain.then(() => opts.onEvent?.(event)).catch(() => undefined);
    };
    const onLog = async (stream: OSPipe, chunk: string) => {
      buffers[stream] += chunk;
      let newline = buffers[stream].indexOf("\n");
      while (newline >= 0) {
        emitLine(stream, buffers[stream].slice(0, newline));
        buffers[stream] = buffers[stream].slice(newline + 1);
        newline = buffers[stream].indexOf("\n");
      }
      await opts.onLog?.(stream, chunk);
    };
    const result = await runChildProcess(opts.runId, opts.command, opts.args, {
      cwd: opts.cwd, env: opts.env, timeoutSec: opts.timeoutSec, graceSec: opts.graceSec,
      onLog, onSpawn: opts.onSpawn, stdin: opts.stdin,
    });
    for (const stream of ["stdout", "stderr"] as const) {
      if (buffers[stream]) emitLine(stream, buffers[stream]);
    }
    await eventChain;
    return result;
  };
}

const MAX_TOTAL_RETRIES = 2;

export function clampRetryDelayMs(delayMs: number | undefined): number {
  return Math.min(5000, Math.max(0, Math.trunc(delayMs ?? 0)));
}

/** Fail-closed flavor retry consult: sanitized inputs only; timeouts opt-in. */
function consultFlavorRetry(flavor: AcpFlavor, proc: RunProcessResult, codes: string[], retriesUsed: number, resumeId: string): AcpFlavorRetryDecision | null {
  const failed = proc.exitCode !== 0 || proc.signal !== null || proc.timedOut || codes.length > 0;
  if (!failed || !flavor.shouldRetry || retriesUsed >= MAX_TOTAL_RETRIES) return null;
  if (proc.timedOut && flavor.retryOnTimeout !== true) return null;
  return flavor.shouldRetry({ exitCode: proc.exitCode, signal: proc.signal, timedOut: proc.timedOut, trustedErrorCodes: codes,
    attempt: retriesUsed + 1, remainingRetries: MAX_TOTAL_RETRIES - retriesUsed, resumeSessionId: resumeId || null });
}

export interface ManagedProviderDriverOptions {
  flavor: AcpFlavor;
}

export interface ManagedProviderDriver {
  type: string;
  sessionCodec: AcpFlavor["sessionCodec"];
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
}

export function createManagedProviderDriver(
  options: ManagedProviderDriverOptions,
): ManagedProviderDriver {
  const { flavor } = options;
  const runner = createChildProcessStreamRunner(flavor.protocolTransport);
  const codec = flavor.sessionCodec;

  async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const { runId, agent, runtime, config, context, onLog, onSpawn, onSessionUpdate, authToken } = ctx;
    const command = asString(config.command, "") || asString(flavor.defaultCommand, "");
    if (!command) throw new Error(`Managed driver "${flavor.key}" requires config.command or defaultCommand`);
    const cwd = resolveDriverCwd(config, context);
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

    const runtimeEnv = buildPaperclipExecutionEnv(
      buildPaperclipEnv(agent, { context }),
      parseObject(config.env),
      authToken,
    );
    const finalEnv = flavor.buildEnv ? await flavor.buildEnv(runtimeEnv, ctx) : runtimeEnv;
    await ensureCommandResolvable(command, cwd, finalEnv);

    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const promptTemplate = asString(config.promptTemplate, "");
    const bootstrapTemplate = asString(config.bootstrapPromptTemplate, "");
    const prompt = joinPromptSections([
      bootstrapTemplate ? renderTemplate(bootstrapTemplate, templateData).trim() : "",
      buildPaperclipRuntimeBrief(context),
      promptTemplate ? renderTemplate(promptTemplate, templateData) : "",
    ]);
    const model = asString(config.model, "");
    const effort = asString(config.effort, "") || asString(config.modelReasoningEffort, "");
    const maxTurns = asNumber(config.maxTurns, 0);
    const timeoutSec = asNumber(config.timeoutSec, 0), graceSec = asNumber(config.graceSec, 20);
    const extraArgs = stripReservedDriverArgs(
      [...driverArgsList(config.args), ...driverArgsList(config.extraArgs)],
      flavor.reservedArgs ?? [],
    );

    const storedParams = codec?.deserialize(runtime.sessionParams) ?? parseObject(runtime.sessionParams);
    const storedSessionId = asString(storedParams.sessionId, "") || asString(runtime.sessionId, "");
    const storedCwd = asString(storedParams.cwd, "");
    const cwdMismatch = storedCwd.length > 0 && path.resolve(storedCwd) !== cwd;
    const canResume = storedSessionId.length > 0 && !cwdMismatch && flavor.supportsSessionResume !== false;
    const resumeId = canResume ? storedSessionId : "";
    if (storedSessionId && !canResume) {
      const msg = `[paperclip] ${flavor.key} session "${storedSessionId}" was saved for cwd "${storedCwd || "unknown"}" and will not be resumed in "${cwd}".\n`;
      await onLog("stdout", msg);
    }

    const seenSessions = new Set<string>();
    let latestSessionId: string | null = null;
    let latestSessionParams: Record<string, unknown> | null = null;
    let latestSessionDisplayId: string | null = null;
    let summaryTail = "";
    let firstErrorMessage: string | null = null;
    const usageRollup: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let sawUnknownSession = false, trustedErrorCodes: string[] = [];

    const handleEvent = async (event: ParsedDriverEvent) => {
      if (isTrustedProtocolEvent(event) && event.kind === "error") {
        trustedErrorCodes.push(event.code); sawUnknownSession ||= event.code === "unknown_session";
      }
      if (event.kind === "output") {
        if (event.origin !== "stderr") summaryTail = (summaryTail + event.text + "\n").slice(-8000);
      } else if (event.kind === "session") {
        if (seenSessions.has(event.sessionId)) return;
        seenSessions.add(event.sessionId);
        latestSessionId = event.sessionId;
        latestSessionParams = event.sessionParams ?? null;
        latestSessionDisplayId = event.sessionDisplayId ?? event.sessionId;
        if (onSessionUpdate) {
          const update: AdapterSessionUpdate = {
            sessionId: event.sessionId, sessionParams: event.sessionParams ?? null,
            sessionDisplayId: event.sessionDisplayId ?? event.sessionId,
            source: "stdout", confidence: "provider_reported",
            observedAt: new Date().toISOString(),
          };
          await onSessionUpdate(update);
        }
      } else if (event.kind === "usage") {
        const u = event.usage;
        usageRollup.inputTokens += u.inputTokens;
        usageRollup.outputTokens += u.outputTokens;
        usageRollup.cachedInputTokens =
          (usageRollup.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0);
      } else if (event.kind === "error" && !firstErrorMessage && event.message) {
        firstErrorMessage = event.message;
      }
    };

    const attempt = async (sessionResumeId: string) => {
      sawUnknownSession = false; trustedErrorCodes = [];
      usageRollup.inputTokens = 0; usageRollup.outputTokens = 0; usageRollup.cachedInputTokens = 0;
      const argsInput = { command, prompt, resumeSessionId: sessionResumeId || null, model, effort, maxTurns, extraArgs, config };
      const args = flavor.buildArgs(argsInput);
      if (ctx.onMeta) await ctx.onMeta({ adapterType: flavor.key, command, cwd, commandArgs: args, env: redactEnvForLogs(finalEnv), prompt });
      const stdin = flavor.buildStdin?.(argsInput);
      const proc = await runner({
        runId, command, args, cwd, env: finalEnv, timeoutSec, graceSec,
        onLog, onSpawn, onEvent: handleEvent, stdin,
      });
      return { proc, unknownSession: sawUnknownSession, trustedErrorCodes };
    };

    // Shared fail-closed retry budget: built-in unknown_session retry runs first.
    let retriesUsed = 0, activeResumeId = resumeId, result = await attempt(activeResumeId);
    for (;;) {
      if (activeResumeId && result.unknownSession && retriesUsed < MAX_TOTAL_RETRIES) {
        await onLog("stdout", `[paperclip] ${flavor.key} session "${activeResumeId}" is unavailable; retrying with a fresh run.\n`);
        retriesUsed += 1; activeResumeId = ""; result = await attempt(activeResumeId); continue;
      }
      const decision = consultFlavorRetry(flavor, result.proc, result.trustedErrorCodes, retriesUsed, activeResumeId);
      if (!decision?.retry) break;
      if (decision.delayMs !== undefined && !Number.isFinite(decision.delayMs)) {
        await onLog("stdout", `[paperclip] ${flavor.key} shouldRetry returned a non-finite delayMs; refusing to retry.\n`);
        break;
      }
      const delayMs = clampRetryDelayMs(decision.delayMs); if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      retriesUsed += 1; if (decision.clearSession) activeResumeId = "";
      await onLog("stdout", `[paperclip] ${flavor.key} retrying attempt ${retriesUsed + 1}${decision.reason ? ` (${decision.reason})` : ""}.\n`);
      result = await attempt(activeResumeId);
    }

    const { proc } = result;
    const resolvedSessionId = latestSessionId ?? (resumeId || null);
    const resolvedParams = latestSessionParams ?? (resolvedSessionId
      ? { ...storedParams, sessionId: resolvedSessionId, cwd }
      : null);
    const summary = summaryTail.trim() || null;
    const stderrLine = proc.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
    const base = {
      exitCode: proc.exitCode,
      signal: proc.signal,
      usage: {
        inputTokens: usageRollup.inputTokens, outputTokens: usageRollup.outputTokens,
        ...(usageRollup.cachedInputTokens ? { cachedInputTokens: usageRollup.cachedInputTokens } : {}),
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedParams,
      sessionDisplayId: latestSessionDisplayId ?? resolvedSessionId,
      provider: flavor.key,
      model: model || null,
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
      summary,
    };
    if (proc.timedOut) {
      return { ...base, timedOut: true, errorMessage: `Timed out after ${timeoutSec}s` };
    }
    const failed = proc.exitCode !== 0 || firstErrorMessage !== null;
    return {
      ...base,
      timedOut: false,
      errorMessage: failed ? (firstErrorMessage ?? (stderrLine || null)) : null,
      errorCode: failed ? "process_failed" : null,
      billingType: "unknown",
    };
  }

  return { type: flavor.key, sessionCodec: codec, execute };
}
