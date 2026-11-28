import type { AdapterSessionCodec, UsageSummary } from "../types.js";
import { asNumber, parseJson } from "@paperclipai/adapter-utils/server-utils";

export interface DevinLocalParsedOutput {
  summary: string | null;
  sessionId: string | null;
  usage: UsageSummary;
}

const ANSI_CSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ADAPTER_LINE_RE = /^\s*\[(?:adapter|paperclip)\]/i;
const SESSION_LINE_RE = /^\s*(?:devin\s+)?session(?:\s+id|_id)?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._/-]*)["']?\s*$/i;
const UNKNOWN_SESSION_RE =
  /(unknown|invalid|stale)\s+session|session\s+(?:id\s+)?(?:not\s+found|does\s+not\s+exist|is\s+invalid|expired)|no\s+(?:such\s+)?session|could\s+not\s+(?:find|resume)\s+session|resume\s+failed/i;

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI_RE, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSessionId(record: Record<string, unknown>): string | null {
  const direct =
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.session);
  if (direct) return direct;
  const session = asRecord(record.session);
  return session ? readNonEmptyString(session.id) ?? readNonEmptyString(session.sessionId) : null;
}

function readTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function readSummaryCandidate(record: Record<string, unknown>): string | null {
  for (const key of ["summary", "finalMessage", "final_message", "result", "text", "response", "answer"]) {
    const direct = readNonEmptyString(record[key]);
    if (direct) return direct;
    const nested = asRecord(record[key]);
    if (nested) {
      const nestedText = readTextContent(nested.content) || readTextContent(nested.text);
      if (nestedText.trim().length > 0) return nestedText;
    }
  }
  const message = asRecord(record.message);
  if (message) {
    const text = readTextContent(message.content);
    if (text.trim().length > 0) return text;
  }
  return null;
}

function addUsage(target: UsageSummary, rawUsage: unknown): void {
  const usage = asRecord(rawUsage);
  if (!usage) return;
  target.inputTokens += asNumber(usage.inputTokens ?? usage.input_tokens ?? usage.input, 0);
  target.outputTokens += asNumber(usage.outputTokens ?? usage.output_tokens ?? usage.output, 0);
  target.cachedInputTokens =
    (target.cachedInputTokens ?? 0) +
    asNumber(usage.cachedInputTokens ?? usage.cached_input_tokens ?? usage.cacheReadTokens ?? usage.cacheRead ?? usage.cache_read, 0);
}

export function buildDevinLocalArgs(opts: {
  model: string;
  permissionMode: string;
  sessionId?: string | null;
  extraArgs?: string[];
  prompt: string;
}): string[] {
  return [
    "--model",
    opts.model,
    "--process-model",
    "in-process",
    "--permission-mode",
    opts.permissionMode,
    "--respect-workspace-trust",
    "false",
    ...(opts.sessionId ? ["-r", opts.sessionId] : []),
    ...(opts.extraArgs ?? []),
    "-p",
    opts.prompt,
  ];
}

export function parseDevinLocalOutput(stdout: string): DevinLocalParsedOutput {
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const contentLines: string[] = [];
  let sessionId: string | null = null;
  let finalText: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;

    const event = parseJson(trimmed);
    if (event) {
      sessionId = readSessionId(event) ?? sessionId;
      addUsage(usage, event.usage);
      addUsage(usage, asRecord(event.result)?.usage);
      addUsage(usage, asRecord(event.message)?.usage);
      const candidate = readSummaryCandidate(event);
      if (candidate) finalText = candidate;
      continue;
    }

    const sessionMatch = trimmed.match(SESSION_LINE_RE);
    if (sessionMatch) {
      sessionId = sessionMatch[1] ?? sessionId;
      continue;
    }
    if (ADAPTER_LINE_RE.test(trimmed)) continue;
    contentLines.push(line);
  }

  const fallback = contentLines.join("\n").trim();
  const summary = (finalText ?? fallback).trim();
  return {
    summary: summary.length > 0 ? summary : null,
    sessionId,
    usage,
  };
}

export function isDevinLocalUnknownSessionError(_stdout: string, stderr: string): boolean {
  const haystack = stderr
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .join("\n");
  return UNKNOWN_SESSION_RE.test(haystack);
}

export const devinLocalSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};
