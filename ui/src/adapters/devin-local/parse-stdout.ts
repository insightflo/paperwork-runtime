import type { TranscriptEntry } from "../types";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const message =
    asString(rec.message) ||
    asString(rec.error) ||
    asString(rec.code);
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .map((part) => asString(part.text) || asString(part.content))
    .filter(Boolean)
    .join("");
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readUsageNumbers(usage: unknown) {
  const record = asRecord(usage);
  return {
    inputTokens: asNumber(record?.inputTokens ?? record?.input_tokens ?? record?.input),
    outputTokens: asNumber(record?.outputTokens ?? record?.output_tokens ?? record?.output),
    cachedTokens: asNumber(record?.cachedTokens ?? record?.cached_tokens ?? record?.cacheReadTokens ?? record?.cache_read_input_tokens),
  };
}

export function parseDevinStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type).toLowerCase();
  const subtype = asString(parsed.subtype).toLowerCase();

  if (
    (type === "system" && subtype === "init") ||
    type === "init" ||
    type === "session_start" ||
    type === "session_started"
  ) {
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "devin"),
      sessionId: asString(parsed.sessionId ?? parsed.session_id),
    }];
  }

  if (type === "text_delta" || type === "assistant_delta") {
    const delta = asString(parsed.delta ?? parsed.text);
    return delta ? [{ kind: "assistant", ts, text: delta, delta: true }] : [];
  }

  if (type === "assistant" || type === "assistant_message") {
    const message = asRecord(parsed.message);
    const text = extractTextContent(parsed.text ?? parsed.content ?? message?.content);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "thinking" || type === "reasoning") {
    const text = extractTextContent(parsed.text ?? parsed.thinking ?? parsed.content);
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "user") {
    const message = asRecord(parsed.message);
    const text = extractTextContent(parsed.text ?? parsed.content ?? message?.content);
    return text ? [{ kind: "user", ts, text }] : [];
  }

  if (type === "tool_call" || type === "tool_use" || type === "tool_execution_start") {
    const name = asString(parsed.name ?? parsed.toolName ?? parsed.tool_name, "unknown");
    return [{
      kind: "tool_call",
      ts,
      name,
      input: parsed.input ?? parsed.args ?? parsed.arguments ?? {},
      toolUseId: asString(parsed.toolUseId ?? parsed.toolCallId ?? parsed.tool_use_id ?? parsed.id) || undefined,
    }];
  }

  if (type === "tool_result" || type === "tool_execution_end" || type === "tool_errored") {
    const payload = parsed.content ?? parsed.result ?? parsed.output;
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(parsed.toolUseId ?? parsed.toolCallId ?? parsed.tool_use_id ?? parsed.id, "unknown"),
      toolName: asString(parsed.toolName ?? parsed.tool_name ?? parsed.name) || undefined,
      content: extractTextContent(payload) || stringifyUnknown(payload),
      isError: parsed.isError === true || parsed.is_error === true || type === "tool_errored",
    }];
  }

  if (type === "result" || type === "final" || type === "completed") {
    const usage = readUsageNumbers(parsed.usage);
    const error = errorText(parsed.error);
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.map(errorText).filter(Boolean)
      : error
        ? [error]
        : [];
    const resultSubtype = asString(parsed.subtype ?? parsed.status, parsed.isError === true || parsed.is_error === true ? "error" : "success");
    return [{
      kind: "result",
      ts,
      text: asString(parsed.text ?? parsed.finalText ?? parsed.result ?? parsed.summary),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      costUsd: asNumber(parsed.costUsd ?? parsed.cost_usd ?? parsed.total_cost_usd),
      subtype: resultSubtype,
      isError: parsed.isError === true || parsed.is_error === true || resultSubtype === "error",
      errors,
    }];
  }

  if (type === "error") {
    return [{ kind: "stderr", ts, text: errorText(parsed.error ?? parsed.message ?? parsed) || "Devin error" }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
