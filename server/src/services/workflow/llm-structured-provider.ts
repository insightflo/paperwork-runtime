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
};

export class LlmStructuredProviderError extends Error {
  constructor(readonly code: "unavailable" | "invalid_response" | "unsafe_response" | "unsafe_request") { super(code); }
}

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

export async function callOpenAiCompatibleStructured(input: CallInput) {
  const { baseUrl, apiKey, model, userContent, systemPrompt, jsonSchema, schemaName, responseFormatMode,
    timeoutMs, maxRetries, fetchImpl = fetch, sleepImpl = sleep } = input;
  const payload = {
    model, temperature: 0,
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
          let envelope: Record<string, unknown>;
          let parsedJson: unknown;
          let rawText: string;
          try {
            envelope = readObject(await response.json());
            const choice = Array.isArray(envelope.choices) ? readObject(envelope.choices[0]) : {};
            const message = readObject(choice.message);
            if (typeof message.content !== "string" || message.refusal || choice.finish_reason === "length") throw new Error();
            rawText = message.content;
            parsedJson = JSON.parse(rawText.trim());
          } catch {
            controller.signal.throwIfAborted();
            throw new LlmStructuredProviderError("invalid_response");
          }
          const responseModel = nonEmptyString(envelope.model) ?? model;
          const usage = envelope.usage ?? null;
          if ([rawText, parsedJson, responseModel, usage].some((value) => containsKey(value, apiKey))) {
            throw new LlmStructuredProviderError("unsafe_response");
          }
          return { parsedJson, rawText, model: responseModel, usage, latencyMs: Math.round(performance.now() - start), attempts };
        }
        // Never read upstream error text, which may reflect credentials.
        void response.body?.cancel().catch(() => undefined);
        if (!retryable.has(response.status) || attempts > maxRetries) break;
        delay = retryDelay(response, attempts);
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
