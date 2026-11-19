import fs from "node:fs/promises";

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

const MODEL_CAPACITY_RE =
  /\bMODEL_CAPACITY_EX(?:HAUSTED|CEEDED)\b|\b[Nn]o capacity available for model\b[^\n]*/u;
const QUOTA_LOG_RE = /RESOURCE_EXHAUSTED \(code 429\):\s*([^\n]+)/i;
const QUOTA_TEXT_RE =
  /^\s*(?:\u26A0\uFE0F?\s*)?Usage Limit Reached\b[\s\S]*$|\bIndividual quota reached\b[^\n]*|\bquota\b.{0,40}\b(?:reached|exceeded|exhausted)\b[^\n]*/iu;
const AUTH_VERIFICATION_RE =
  /^\s*(?:\u26A0\uFE0F?\s*)?Verification Required\b[\s\S]*$|https:\/\/accounts\.google\.com\/signin\/[^\s<>"'`)\]]*auth_success_gemini[^\s<>"'`)\]]*|\b(?:API key not valid|API_KEY_INVALID)\b[^\n]*/iu;
const SESSION_CONNECTION_LOST_RE =
  /^\s*Agent connection was lost and could not be re-established:\s*([\s\S]+)$/u;
const MCP_LOAD_FAILED_RE =
  /^\s*(?:\u26A0\uFE0F?\s*)?The MCP server '([A-Za-z0-9_-]+)' failed to initialize(?::\s*([^\n]+))?|\bMCP load failed for ([A-Za-z0-9_-]+):\s*([^\n]+)/u;
const EMPTY_MODEL_OUTPUT_RE =
  /\bmodel output must contain either output text or tool calls, these cannot both be empty\b|\bModel produced invalid output\b/iu;
const EXECUTION_ERROR_ANSWER_RE = /^\s*Agent execution error:\s*([\s\S]+)$/u;
const CLI_WARNING_ANSWER_RE = /^(?:\n|\s)*\u26A0\s+([\s\S]+)$/u;

const RAW_API_NS = ["default", "api"].join("_");
const RAW_FENCE_TAG = ["tool", "code"].join("_");
const UNEXECUTED_TOOL_CALL_RE = new RegExp(
  `^\\s*(?:\`\`\`${RAW_FENCE_TAG}\\s*)?(?:call:${RAW_API_NS}:[\\w-]+\\s*\\{[\\s\\S]*\\}|print\\(${RAW_API_NS}\\.[\\w-]+\\([\\s\\S]*\\)\\))\\s*(?:\`\`\`\\s*)?$`,
  "u",
);

function singleLineDetail(text: string): string {
  return text.replace(/^\s*\u26A0\uFE0F?\s*/u, "").replace(/\s+/g, " ").trim();
}

function extractAntigravityOverloadMessage(text: string): string | null {
  const match = text.match(MODEL_CAPACITY_RE);
  return match?.[0] ? singleLineDetail(match[0]) : null;
}

function extractAntigravityQuotaMessage(diagnosticLog: string, answerText = ""): string | null {
  const logMatch = diagnosticLog.match(QUOTA_LOG_RE);
  if (logMatch) {
    return `RESOURCE_EXHAUSTED (code 429): ${logMatch[1]?.trim() ?? "quota exhausted"}`;
  }
  const textMatch = answerText.match(QUOTA_TEXT_RE) ?? diagnosticLog.match(QUOTA_TEXT_RE);
  return textMatch?.[0] ? singleLineDetail(textMatch[0]) : null;
}

function extractAntigravityMonitorDenial(diagnosticLog: string): string | null {
  const matches = [...diagnosticLog.matchAll(/Monitor\s+\S+\s+FINISHED:\s+triggered=true,\s+reason="([^"]+)"/gi)];
  const last = matches.at(-1);
  return last?.[1]?.trim() || null;
}

function classifyAntigravityInlineFailureText(
  candidateText: string,
  diagnosticLog: string,
): { errorMessage: string; errorCode: string } | null {
  const trimmed = candidateText.trim();
  if (!trimmed) return null;

  if (UNEXECUTED_TOOL_CALL_RE.test(trimmed)) {
    return {
      errorMessage: "Antigravity model emitted an unexecuted text tool call instead of running the tool",
      errorCode: "antigravity_unexecuted_tool_call",
    };
  }
  if (EMPTY_MODEL_OUTPUT_RE.test(trimmed)) {
    return {
      errorMessage: `Antigravity model produced invalid empty step output: ${singleLineDetail(trimmed)}`,
      errorCode: "antigravity_invalid_model_output",
    };
  }
  const mcpMatch = trimmed.match(MCP_LOAD_FAILED_RE);
  if (mcpMatch) {
    const serverName = mcpMatch[1] ?? mcpMatch[3] ?? "unknown";
    const reason = singleLineDetail(mcpMatch[2] ?? mcpMatch[4] ?? trimmed);
    return {
      errorMessage: `Antigravity MCP server '${serverName}' failed to initialize: ${reason}`,
      errorCode: "antigravity_mcp_load_failed",
    };
  }
  if (SESSION_CONNECTION_LOST_RE.test(trimmed)) {
    return {
      errorMessage: singleLineDetail(trimmed),
      errorCode: "antigravity_session_lost",
    };
  }
  if (AUTH_VERIFICATION_RE.test(trimmed)) {
    return {
      errorMessage: `Antigravity account verification or authentication required: ${singleLineDetail(trimmed)}`,
      errorCode: "antigravity_auth_required",
    };
  }
  const isWarningOrExecError =
    EXECUTION_ERROR_ANSWER_RE.test(trimmed) || CLI_WARNING_ANSWER_RE.test(candidateText);
  const overloadMessage =
    extractAntigravityOverloadMessage(trimmed) ??
    (isWarningOrExecError ? extractAntigravityOverloadMessage(diagnosticLog) : null);
  if (overloadMessage) {
    return {
      errorMessage: `Antigravity model temporarily overloaded: ${overloadMessage}`,
      errorCode: "provider_overloaded",
    };
  }
  if ( QUOTA_TEXT_RE.test(trimmed) ) {
    const quota = extractAntigravityQuotaMessage(diagnosticLog, trimmed) ?? singleLineDetail(trimmed);
    return {
      errorMessage: `Antigravity provider quota exhausted: ${quota}`,
      errorCode: "provider_quota_exhausted",
    };
  }
  if (isWarningOrExecError) {
    return {
      errorMessage: singleLineDetail(trimmed),
      errorCode: "adapter_failed",
    };
  }
  return null;
}

/**
 * Determine whether a completed `agy --print` invocation failed, including
 * zero-exit runs that produced no stdout response or emitted inline CLI failure answers.
 */
export function resolveAntigravityFailure(
  input: ResolveAntigravityFailureInput,
): { errorMessage: string; errorCode: string } | null {
  const diagnosticLog = input.diagnosticLog ?? "";
  if (input.timedOut) {
    return { errorMessage: input.latestResponse || "Antigravity CLI timed out", errorCode: "adapter_failed" };
  }
  if ((input.exitCode ?? 0) !== 0) {
    const overload = extractAntigravityOverloadMessage(`${input.stderr}\n${input.stdout}\n${diagnosticLog}`);
    if (overload) {
      return {
        errorMessage: `Antigravity model temporarily overloaded: ${overload}`,
        errorCode: "provider_overloaded",
      };
    }
    const monitorDenial = extractAntigravityMonitorDenial(diagnosticLog);
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

  const inlineFailure =
    classifyAntigravityInlineFailureText(input.stdout, diagnosticLog) ??
    classifyAntigravityInlineFailureText(input.latestResponse, diagnosticLog);
  if (inlineFailure) {
    return inlineFailure;
  }

  if (!input.latestResponse.trim() && !input.stdout.trim()) {
    const overloadMessage = extractAntigravityOverloadMessage(`${input.stderr}\n${diagnosticLog}`);
    if (overloadMessage) {
      return {
        errorMessage: `Antigravity model temporarily overloaded: ${overloadMessage}`,
        errorCode: "provider_overloaded",
      };
    }
    const quotaMessage = extractAntigravityQuotaMessage(diagnosticLog, input.stderr);
    if (quotaMessage) {
      return {
        errorMessage: `Antigravity provider quota exhausted: ${quotaMessage}`,
        errorCode: "provider_quota_exhausted",
      };
    }
    const monitorDenial = extractAntigravityMonitorDenial(diagnosticLog);
    if (monitorDenial) {
      return {
        errorMessage: `Antigravity safety monitor denied execution: ${monitorDenial}`,
        errorCode: "adapter_failed",
      };
    }
    const stderrMessage = extractLatestAntigravityResponse(input.stderr);
    if (stderrMessage) {
      return (
        classifyAntigravityInlineFailureText(stderrMessage, diagnosticLog) ?? {
          errorMessage: stderrMessage,
          errorCode: "adapter_failed",
        }
      );
    }
    return { errorMessage: "Antigravity CLI exited without producing a response", errorCode: "adapter_failed" };
  }
  return null;
}

const DEFAULT_DIAGNOSTIC_ACTIVITY_INTERVAL_MS = 60_000;

export interface DiagnosticLogActivityMonitorOptions {
  logFilePath: string;
  intervalMs?: number;
  onActivity: (bytes: number) => Promise<void>;
}

/**
 * Poll `agy`'s `--log-file` and emit activity updates while buffered `--print`
 * runs stay silent on stdout so heartbeat `updatedAt` tracks real progress.
 */
export function startDiagnosticLogActivityMonitor(
  opts: DiagnosticLogActivityMonitorOptions,
): () => Promise<void> {
  const intervalMs = Math.max(10, opts.intervalMs ?? DEFAULT_DIAGNOSTIC_ACTIVITY_INTERVAL_MS);
  let lastBytes = 0;
  let stopped = false;
  let activeTick: Promise<void> | null = null;

  const pollOnce = async () => {
    if (stopped) return;
    const stat = await fs.stat(opts.logFilePath).catch(() => null);
    if (stopped || !stat || stat.size <= lastBytes) return;
    lastBytes = stat.size;
    await opts.onActivity(stat.size).catch(() => undefined);
  };

  const timer = setInterval(() => {
    if (stopped || activeTick) return;
    activeTick = pollOnce().finally(() => {
      activeTick = null;
    });
  }, intervalMs);
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (activeTick) await activeTick;
  };
}
