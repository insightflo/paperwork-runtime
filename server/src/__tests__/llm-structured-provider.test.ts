import { describe, expect, it, vi } from "vitest";
import { callOpenAiCompatibleStructured } from "../services/workflow/llm-structured-provider.js";

const apiKey = "test-provider-credential";
const base = { baseUrl: "https://provider.invalid/v1/", apiKey, model: "fallback/model",
  userContent: "{}", timeoutMs: 100, maxRetries: 0 };
const encoder = new TextEncoder();
const sleepImpl = async () => undefined;

const sseResponse = (events: string[]) => new Response(
  events.map((event) => `data: ${event}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const deltaChunk = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ choices: [{ delta: { content }, ...extra }] });
const lastBody = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
  JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));

// Delivers each part after gapMs so chunk pacing can exceed/under-run the idle window deterministically.
function pacedSse(parts: string[], gapMs: number): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= parts.length) { controller.close(); return; }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(encoder.encode(parts[index++]));
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
const stalledResponse = () => new Response(
  new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }),
  { headers: { "Content-Type": "text/event-stream" } });

describe("callOpenAiCompatibleStructured streaming", () => {
  it("requests stream mode and accumulates multi-chunk deltas, model, and usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      deltaChunk('{"ans'),
      JSON.stringify({ model: "vendor/streamed", choices: [{ delta: { content: 'wer":true}' } }] }),
      JSON.stringify({ choices: [], usage: { total_tokens: 7 } }),
      "[DONE]",
    ]));
    const result = await callOpenAiCompatibleStructured({ ...base, fetchImpl });
    expect(result).toMatchObject({ parsedJson: { answer: true }, rawText: '{"answer":true}',
      model: "vendor/streamed", usage: { total_tokens: 7 }, attempts: 1 });
    const sent = lastBody(fetchImpl);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it("resets the idle timer per chunk so active generation outlives one timeout window", async () => {
    const parts = ['{"v":[', "1", ",2", ",3", ",", "4", "]}"]
      .map((piece) => `data: ${deltaChunk(piece)}\n\n`)
      .concat("data: [DONE]\n\n");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pacedSse(parts, 40));
    const result = await callOpenAiCompatibleStructured({ ...base, timeoutMs: 100, fetchImpl });
    expect(result.parsedJson).toEqual({ v: [1, 2, 3, 4] });
  });

  it("retries a stalled stream and succeeds on the next attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(stalledResponse())
      .mockResolvedValueOnce(sseResponse([deltaChunk('{"ok":1}'), "[DONE]"]));
    const result = await callOpenAiCompatibleStructured({ ...base, timeoutMs: 50, maxRetries: 1, fetchImpl, sleepImpl });
    expect(result.attempts).toBe(2);
    expect(result.parsedJson).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails unavailable when every stream stalls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => stalledResponse());
    await expect(callOpenAiCompatibleStructured({ ...base, timeoutMs: 50, maxRetries: 1, fetchImpl, sleepImpl }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a delta refusal", JSON.stringify({ choices: [{ delta: { refusal: "declined" } }] })],
    ["finish_reason length", JSON.stringify({ choices: [{ delta: { content: "{" }, finish_reason: "length" }] })],
    ["a malformed event payload", "{not json"],
  ])("rejects %s as invalid_response", async (_name, event) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([event, "[DONE]"]));
    await expect(callOpenAiCompatibleStructured({ ...base, fetchImpl })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("flags a secret reflected in streamed output as unsafe_response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      deltaChunk(JSON.stringify({ echo: apiKey })), "[DONE]",
    ]));
    await expect(callOpenAiCompatibleStructured({ ...base, fetchImpl })).rejects.toMatchObject({ code: "unsafe_response" });
  });

  it("accepts a plain JSON response when the provider ignores stream", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "vendor/plain", usage: { total_tokens: 3 }, choices: [{ message: { content: '{"plain":true}' } }] }));
    const result = await callOpenAiCompatibleStructured({ ...base, fetchImpl });
    expect(result).toMatchObject({ parsedJson: { plain: true }, model: "vendor/plain", usage: { total_tokens: 3 } });
  });

  it("omits stream fields when stream is false", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: "{}" } }] }));
    await callOpenAiCompatibleStructured({ ...base, stream: false, fetchImpl });
    const sent = lastBody(fetchImpl);
    expect(sent).not.toHaveProperty("stream");
    expect(sent).not.toHaveProperty("stream_options");
  });
});
