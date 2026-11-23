import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseJson, parseObject, type RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
  parseClaudeStreamJson,
} from "./parse.js";

export type ClaudeAttemptResult = {
  proc: RunProcessResult;
  parsedStream: ReturnType<typeof parseClaudeStreamJson>;
  parsed: Record<string, unknown> | null;
};

export interface ClaudeSessionContext {
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
}

export function buildClaudeSessionParams(sessionId: string, sctx: ClaudeSessionContext): Record<string, unknown> {
  return {
    sessionId,
    cwd: sctx.cwd,
    ...(sctx.workspaceId ? { workspaceId: sctx.workspaceId } : {}),
    ...(sctx.workspaceRepoUrl ? { repoUrl: sctx.workspaceRepoUrl } : {}),
    ...(sctx.workspaceRepoRef ? { repoRef: sctx.workspaceRepoRef } : {}),
  };
}

export function readApiErrorStatus(parsed: Record<string, unknown>): number | null {
  const raw = parsed.api_error_status;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const parsedNumber = Number(raw.trim());
    if (Number.isInteger(parsedNumber) && parsedNumber > 0) return parsedNumber;
  }
  return null;
}

export function isClaudeApiOverloaded(parsed: Record<string, unknown> | null): boolean {
  const status = readApiErrorStatus(parsed ?? ({} as Record<string, unknown>));
  return status === 429 || status === 500 || status === 503 || status === 529;
}

export function readClaudeResultErrors(parsed: Record<string, unknown>): string[] {
  if (!Array.isArray(parsed.errors)) return [];
  return parsed.errors
    .map((error) => {
      if (typeof error === "string") return error.trim();
      if (typeof error === "object" && error !== null && !Array.isArray(error)) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string") return message.trim();
      }
      return "";
    })
    .filter(Boolean);
}

export function describeClaudeResultError(parsed: Record<string, unknown>) {
  const subtype = asString(parsed.subtype, "");
  const errors = readClaudeResultErrors(parsed);
  const isError = parsed.is_error === true || subtype.startsWith("error") || errors.length > 0;
  if (!isError) return null;

  const apiStatus = readApiErrorStatus(parsed);
  const resultText = asString(parsed.result, "").trim();
  const describedFailure = describeClaudeFailure(parsed);
  return {
    errorCode: apiStatus ? `claude_api_error_${apiStatus}` : "claude_result_error",
    errorMessage: resultText || errors.join(" | ") || describedFailure || "Claude result reported an error",
  };
}

/** Deduplicated session updates for `system/init` stream-json events on stdout. */
export function createClaudeSessionReporter(input: {
  onSessionUpdate?: AdapterExecutionContext["onSessionUpdate"];
  sessionContext: ClaudeSessionContext;
}) {
  const seen = new Set<string>();
  const emit = async (sessionId: string | null) => {
    if (!sessionId || seen.has(sessionId) || !input.onSessionUpdate) return;
    seen.add(sessionId);
    await input.onSessionUpdate({
      sessionId,
      sessionParams: buildClaudeSessionParams(sessionId, input.sessionContext),
      sessionDisplayId: sessionId, source: "stdout",
      confidence: "provider_reported", observedAt: new Date().toISOString(),
    });
  };
  const onStdoutLine = async (line: string) => {
    const event = parseJson(line);
    if (!event) return;
    if (asString(event.type, "") !== "system" || asString(event.subtype, "") !== "init") return;
    const reportedSessionId = asString(event.session_id, "").trim();
    if (reportedSessionId) await emit(reportedSessionId);
  };
  return { emit, onStdoutLine };
}

export function parseFallbackErrorMessage(
  proc: RunProcessResult,
  parsedStream: ReturnType<typeof parseClaudeStreamJson>,
) {
  const stderrLine =
    proc.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  if ((proc.exitCode ?? 0) === 0) {
    if (parsedStream.sessionId || parsedStream.model) {
      return "Claude stream-json ended without a result event or assistant text";
    }
    return "Failed to parse claude JSON output";
  }

  return stderrLine
    ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
    : `Claude exited with code ${proc.exitCode ?? -1}`;
}

export function toClaudeAdapterResult(input: {
  attempt: ClaudeAttemptResult;
  fallbackSessionId: string | null;
  clearSessionOnMissingSession?: boolean;
  timeoutSec: number;
  sessionContext: ClaudeSessionContext;
  model: string;
  billingType: "api" | "subscription";
}): AdapterExecutionResult {
  const { proc, parsedStream, parsed } = input.attempt;
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });
  const errorMeta = loginMeta.loginUrl != null ? { loginUrl: loginMeta.loginUrl } : undefined;

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${input.timeoutSec}s`,
      errorCode: "timeout",
      errorMeta,
      clearSession: Boolean(input.clearSessionOnMissingSession),
    };
  }

  if (!parsed) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: parseFallbackErrorMessage(proc, parsedStream),
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      clearSession: Boolean(input.clearSessionOnMissingSession),
    };
  }

  const usage = parsedStream.usage ?? (() => {
    const usageObj = parseObject(parsed.usage);
    return { inputTokens: asNumber(usageObj.input_tokens, 0), cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0), outputTokens: asNumber(usageObj.output_tokens, 0) };
  })();

  const sessionUnavailable = Boolean(input.clearSessionOnMissingSession && isClaudeUnknownSessionError(parsed));
  const resolvedSessionId = sessionUnavailable
    ? null
    : parsedStream.sessionId ??
      (asString(parsed.session_id, input.fallbackSessionId ?? "") || input.fallbackSessionId);
  const resolvedSessionParams = resolvedSessionId
    ? buildClaudeSessionParams(resolvedSessionId, input.sessionContext)
    : null;
  const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
  const resultError = describeClaudeResultError(parsed);

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage:
      resultError?.errorMessage ??
      ((proc.exitCode ?? 0) === 0
        ? null
        : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`),
    errorCode: loginMeta.requiresLogin ? "claude_auth_required" : resultError?.errorCode ?? null,
    errorMeta,
    usage,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedSessionId,
    provider: "anthropic",
    biller: "anthropic",
    model: parsedStream.model || asString(parsed.model, input.model),
    billingType: input.billingType,
    costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
    resultJson: parsed,
    summary: parsedStream.summary || asString(parsed.result, ""),
    clearSession: clearSessionForMaxTurns || Boolean(input.clearSessionOnMissingSession && !resolvedSessionId),
  };
}
