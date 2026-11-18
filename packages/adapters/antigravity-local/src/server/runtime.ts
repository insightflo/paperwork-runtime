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

/**
 * Determine whether a completed `agy --print` invocation failed, including
 * zero-exit runs that produced no stdout response (e.g. headless permission denials).
 */
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
  if (!input.latestResponse.trim() && !input.stdout.trim()) {
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
    const stderrMessage = extractLatestAntigravityResponse(input.stderr);
    if (stderrMessage) {
      return { errorMessage: stderrMessage, errorCode: "adapter_failed" };
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
