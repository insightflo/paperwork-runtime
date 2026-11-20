import { setTimeout as sleep } from "node:timers/promises";
import { nonEmptyString, readObject } from "./http-tool-response.js";

type ProviderConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxRetries: number };
export function resolveLlmStructuredConfig(config: Record<string, unknown>, env?: Record<string, string>): ProviderConfig | null {
  const resolve = (key: string, suffix: string) => {
    const name = `PAPERCLIP_LLM_STRUCTURED_${suffix}`;
    return nonEmptyString(config[key]) ?? nonEmptyString(env?.[name]) ?? nonEmptyString(process.env[name]);
  };
  const baseUrl = resolve("baseUrl", "BASE_URL");
  const apiKey = resolve("apiKey", "API_KEY");
  const model = resolve("model", "MODEL");
  if (!baseUrl || !apiKey || !model || /[\r\n]/.test(apiKey) || baseUrl.includes(apiKey) || model.includes(apiKey)) return null;
  const url = URL.parse(baseUrl);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
  return { baseUrl: url.href, apiKey, model, timeoutMs: clamp(config.timeoutMs, 60_000, 1_000, 180_000),
    maxRetries: clamp(config.maxRetries, 2, 0, 4) };
}

export type LlmStructuredTransport = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<unknown>;
};

type CallInput = ProviderConfig & LlmStructuredTransport & {
  systemPrompt?: string;
  userContent: string;
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
  responseFormatMode?: "json_object" | "json_schema";
  stream?: boolean;
};

export class LlmStructuredProviderError extends Error {
  constructor(readonly code: "unavailable" | "invalid_response" | "unsafe_response" | "unsafe_request") { super(code); }
}

// Marks idle-window or hard-cap expiry during a stream read so the retry loop treats it as transient.
class StreamStallError extends Error {}

const retryable = new Set([429, 502, 503, 504]);
function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("Retry-After")?.trim();
  const delay = value && /^\d+$/.test(value) ? Number(value) * 1_000
    : value ? Date.parse(value) - Date.now() : NaN;
  return Number.isNaN(delay) ? 500 * 2 ** (attempt - 1) : Math.min(15_000, Math.max(0, delay));
}

// Check decoded strings and keys too: a JSON escape must not let a reflected key reach an artifact.
function containsKey(value: unknown, key: string): boolean {
  if (typeof value === "string") return value.includes(key);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([name, child]) => name.includes(key) || containsKey(child, key));
}

type Completion = { parsedJson: unknown; rawText: string; model: string; usage: unknown };

async function readJsonCompletion(response: Response, fallbackModel: string): Promise<Completion> {
  const envelope = readObject(await response.json());
  const choice = Array.isArray(envelope.choices) ? readObject(envelope.choices[0]) : {};
  const message = readObject(choice.message);
  if (typeof message.content !== "string" || message.refusal || choice.finish_reason === "length") throw new Error();
  return { parsedJson: JSON.parse(message.content.trim()), rawText: message.content,
    model: nonEmptyString(envelope.model) ?? fallbackModel, usage: envelope.usage ?? null };
}

// SSE events end at a blank line; their "data:" lines join with "\n" before JSON parsing.
function sseEventData(event: string): string {
  return event.split("\n").filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}

// The idle window re-arms on every received chunk, so token-by-token generation never trips
// the read timeout; only a gap > timeoutMs or the overall hard cap ends the read and uses a retry.
async function readStreamCompletion(response: Response, fallbackModel: string, timeoutMs: number): Promise<Completion> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const deadline = performance.now() + Math.max(timeoutMs * 3, 300_000);
  const decoder = new TextDecoder();
  let buffered = "";
  let rawText = "";
  let usage: unknown = null;
  let responseModel = fallbackModel;
  let done = false;
  const applyEvent = (data: string) => {
    const payload = data.trim();
    if (!payload) return;
    if (payload === "[DONE]") { done = true; return; }
    const chunk = readObject(JSON.parse(payload));
    responseModel = nonEmptyString(chunk.model) ?? responseModel;
    if (chunk.usage != null) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? readObject(chunk.choices[0]) : {};
    const delta = readObject(choice.delta);
    if (delta.refusal || choice.finish_reason === "length") throw new LlmStructuredProviderError("invalid_response");
    if (typeof delta.content === "string") rawText += delta.content;
  };
  const drain = () => {
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";
    for (const event of events) {
      if (done) break;
      applyEvent(sseEventData(event));
    }
  };
  try {
    while (!done) {
      const wait = Math.min(timeoutMs, deadline - performance.now());
      if (wait <= 0) throw new StreamStallError();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => { idleTimer = setTimeout(() => reject(new StreamStallError()), wait); });
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(idleTimer);
      }
      if (chunk.done) break;
      buffered = (buffered + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      drain();
    }
    buffered += `${decoder.decode()}\n\n`;
    drain();
    return { parsedJson: JSON.parse(rawText.trim()), rawText, model: responseModel, usage };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function callOpenAiCompatibleStructured(input: CallInput) {
  const { baseUrl, apiKey, model, userContent, systemPrompt, jsonSchema, schemaName, responseFormatMode,
    timeoutMs, maxRetries, fetchImpl = fetch, sleepImpl = sleep } = input;
  const payload = {
    model, temperature: 0,
    ...(input.stream !== false ? { stream: true, stream_options: { include_usage: true } } : {}),
    messages: [...(systemPrompt === undefined ? [] : [{ role: "system", content: systemPrompt }]),
      { role: "user", content: userContent }],
    response_format: jsonSchema && responseFormatMode !== "json_object"
      ? { type: "json_schema", json_schema: { name: schemaName ?? "structured_output", strict: true, schema: jsonSchema } }
      : { type: "json_object" },
  };
  if (containsKey(payload.messages, apiKey) || containsKey(jsonSchema, apiKey) || schemaName?.includes(apiKey)) {
    throw new LlmStructuredProviderError("unsafe_request");
  }
  const body = JSON.stringify(payload);
  const start = performance.now();
  try {
    for (let attempts = 1; attempts <= maxRetries + 1; attempts++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let delay: number;
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body, signal: controller.signal, redirect: "error",
        });
        if (response.ok) {
          const sse = (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/event-stream");
          if (sse) clearTimeout(timer); // the stream reader enforces its own idle window and hard cap
          let completion: Completion;
          try {
            completion = sse ? await readStreamCompletion(response, model, timeoutMs)
              : await readJsonCompletion(response, model);
          } catch (error) {
            controller.signal.throwIfAborted();
            if (error instanceof StreamStallError || error instanceof LlmStructuredProviderError) throw error;
            throw new LlmStructuredProviderError("invalid_response");
          }
          const { parsedJson, rawText, model: responseModel, usage } = completion;
          if ([rawText, parsedJson, responseModel, usage].some((value) => containsKey(value, apiKey))) {
            throw new LlmStructuredProviderError("unsafe_response");
          }
          return { parsedJson, rawText, model: responseModel, usage, latencyMs: Math.round(performance.now() - start), attempts };
        }
        // Never read upstream error text, which may reflect credentials.
        void response.body?.cancel().catch(() => undefined);
        if (!retryable.has(response.status) || attempts > maxRetries) break;
        delay = retryDelay(response, attempts);
      } catch (error) {
        // Aborted attempts and stalled streams are transient: retry with backoff like a retryable status.
        if (error instanceof LlmStructuredProviderError) throw error;
        if (!(controller.signal.aborted || error instanceof StreamStallError) || attempts > maxRetries) throw error;
        controller.abort();
        delay = 500 * 2 ** (attempts - 1);
      } finally {
        clearTimeout(timer);
      }
      await sleepImpl(delay);
    }
  } catch (error) {
    if (error instanceof LlmStructuredProviderError) throw new LlmStructuredProviderError(error.code);
  }
  throw new LlmStructuredProviderError("unavailable");
}
