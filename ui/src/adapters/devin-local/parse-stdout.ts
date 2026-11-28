import type { TranscriptEntry } from "../types";

const ANSI_CSI_RE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI_RE, "");
}

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
  if (typeof value === "string") return stripAnsi(value);
  const rec = asRecord(value);
  if (!rec) return "";
  const message =
    asString(rec.message) ||
    asString(rec.error) ||
    asString(rec.code);
  if (message) return stripAnsi(message);
  try {
    return stripAnsi(JSON.stringify(rec));
  } catch {
    return "";
  }
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return stripAnsi(value);
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .map((part) => extractTextContent(part.text) || extractTextContent(part.content))
    .filter(Boolean)
    .join("");
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return stripAnsi(value);
  if (value === null || value === undefined) return "";
  try {
    return stripAnsi(JSON.stringify(value));
  } catch {
    return stripAnsi(String(value));
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

function readToolUseId(record: Record<string, unknown>): string {
  return asString(record.toolUseId ?? record.toolCallId ?? record.tool_use_id ?? record.id);
}

function toolCallEntry(record: Record<string, unknown>, ts: string): TranscriptEntry {
  return {
    kind: "tool_call",
    ts,
    name: asString(record.name ?? record.toolName ?? record.tool_name, "unknown"),
    input: record.input ?? record.args ?? record.arguments ?? {},
    toolUseId: readToolUseId(record) || undefined,
  };
}

function toolResultEntry(record: Record<string, unknown>, ts: string, forceError = false): TranscriptEntry {
  const payload = record.content ?? record.result ?? record.output;
  return {
    kind: "tool_result",
    ts,
    toolUseId: readToolUseId(record) || "unknown",
    toolName: asString(record.toolName ?? record.tool_name ?? record.name) || undefined,
    content: extractTextContent(payload) || stringifyUnknown(payload),
    isError: record.isError === true || record.is_error === true || forceError,
  };
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => Boolean(part));
}

function blockType(block: Record<string, unknown>): string {
  return asString(block.type).toLowerCase();
}

function blockText(block: Record<string, unknown>): string {
  return extractTextContent(block.text) || extractTextContent(block.content);
}

function parseAssistantContent(content: unknown, ts: string): TranscriptEntry[] {
  const blocks = contentBlocks(content);
  if (blocks.length === 0) return [];

  const text = blocks
    .filter((block) => !["tool_use", "tool_call", "thinking", "reasoning"].includes(blockType(block)))
    .map(blockText)
    .filter(Boolean)
    .join("");
  const entries: TranscriptEntry[] = text ? [{ kind: "assistant", ts, text }] : [];

  for (const block of blocks) {
    const type = blockType(block);
    if (type === "thinking" || type === "reasoning") {
      const thinking = extractTextContent(block.thinking) || blockText(block);
      if (thinking) entries.push({ kind: "thinking", ts, text: thinking });
    } else if (type === "tool_use" || type === "tool_call") {
      entries.push(toolCallEntry(block, ts));
    }
  }

  return entries;
}

function parseUserContent(content: unknown, ts: string): TranscriptEntry[] {
  const blocks = contentBlocks(content);
  if (blocks.length === 0) return [];

  const text = blocks
    .filter((block) => blockType(block) !== "tool_result")
    .map(blockText)
    .filter(Boolean)
    .join("");
  const entries: TranscriptEntry[] = text ? [{ kind: "user", ts, text }] : [];

  for (const block of blocks) {
    if (blockType(block) === "tool_result") {
      entries.push(toolResultEntry(block, ts));
    }
  }

  return entries;
}

export function parseDevinStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const cleanLine = stripAnsi(line);
  const trimmed = cleanLine.trim();
  if (!trimmed) return [];

  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: cleanLine }];
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
    const delta = extractTextContent(parsed.delta ?? parsed.text);
    return delta ? [{ kind: "assistant", ts, text: delta, delta: true }] : [];
  }

  if (type === "assistant" || type === "assistant_message") {
    const message = asRecord(parsed.message);
    const content = parsed.text ?? parsed.content ?? message?.content;
    const entries = parseAssistantContent(content, ts);
    if (entries.length > 0) return entries;
    const text = extractTextContent(content);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "thinking" || type === "reasoning") {
    const text = extractTextContent(parsed.text ?? parsed.thinking ?? parsed.content);
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "user") {
    const message = asRecord(parsed.message);
    const content = parsed.text ?? parsed.content ?? message?.content;
    const entries = parseUserContent(content, ts);
    if (entries.length > 0) return entries;
    const text = extractTextContent(content);
    return text ? [{ kind: "user", ts, text }] : [];
  }

  if (type === "tool_call" || type === "tool_use" || type === "tool_execution_start") {
    return [toolCallEntry(parsed, ts)];
  }

  if (type === "tool_result" || type === "tool_execution_end" || type === "tool_errored") {
    return [toolResultEntry(parsed, ts, type === "tool_errored")];
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
      text: extractTextContent(parsed.text ?? parsed.finalText ?? parsed.result ?? parsed.summary),
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

  return [{ kind: "stdout", ts, text: cleanLine }];
}
