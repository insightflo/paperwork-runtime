import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeLlmStructuredTool } from "../services/workflow/llm-structured-executor.js";

const apiKey = "test-provider-credential";
const adapterConfig = { baseUrl: "https://provider.invalid/v1/", apiKey, model: "test-model" };
const success = (content: string) => Response.json({ choices: [{ message: { content } }], usage: { total_tokens: 12 } });
const setup = () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => success('{"answer":true}'));
  return { toolName: "test-tool", parameters: { instruction: "Summarize" }, adapterConfig, fetchImpl };
};
afterEach(() => vi.unstubAllEnvs());

describe("llm-structured", () => {
  it("fails closed without an API key", async () => {
    vi.stubEnv("PAPERCLIP_LLM_STRUCTURED_API_KEY", undefined);
    const input = setup();
    const response = await executeLlmStructuredTool({ ...input, adapterConfig: { ...adapterConfig, apiKey: undefined } });
    expect(response).toMatchObject({ status: 422, body: { error: "llm_structured_missing_or_invalid_config" } });
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects artifact traversal before fetch", async () => {
    const input = setup();
    expect(await executeLlmStructuredTool({ ...input, parameters: { ...input.parameters, artifactFileName: "../evil.json" } }))
      .toMatchObject({ status: 422 });
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts input and does not return the API key even when an upstream failure reflects it", async () => {
    const input = setup();
    const inputSecret = "sk-0123456789012345678901234";
    const request = { ...input, parameters: { ...input.parameters, inputData: { token: inputSecret } } };
    const response = await executeLlmStructuredTool(request);
    expect(response).toMatchObject({ status: 200, body: { data: { egressStatus: "checked_redacted" } } });
    const init = input.fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toContain("REDACTED_API_KEY");
    expect(init?.body).not.toContain(inputSecret);
    expect(init?.body).not.toContain(apiKey);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(JSON.stringify(response)).not.toContain(apiKey);
    input.fetchImpl.mockResolvedValueOnce(new Response(apiKey, { status: 400 }));
    input.fetchImpl.mockResolvedValueOnce(success(JSON.stringify({ answer: apiKey })));
    for (let i = 0; i < 2; i++) {
      const error = await executeLlmStructuredTool(request);
      expect(error.status).toBe(503);
      expect(JSON.stringify(error)).not.toContain(apiKey);
    }
  });

  it("blocks failed redaction and secret-classified data before fetch", async () => {
    const input = setup();
    for (const [inputData, status] of [[{ a: 1n }, 422], [{ originPolicy: { a: "secret" }, a: "sensitive" }, 403]] as const) {
      expect(await executeLlmStructuredTool({ ...input, parameters: { ...input.parameters, inputData } })).toMatchObject({ status });
    }
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("honors Retry-After on HTTP 429 and succeeds on attempt 2", async () => {
    const input = setup();
    input.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "2" } }));
    const sleepImpl = vi.fn(async () => undefined);
    expect(await executeLlmStructuredTool({ ...input, sleepImpl })).toMatchObject({ status: 200, body: { data: { attempts: 2 } } });
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(input.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Here is your result: {"answer":true}', "llm_structured_invalid_response"],
    ['{"other":1}', "llm_structured_schema_mismatch"],
    ['[]', "llm_structured_schema_mismatch"],
  ])("rejects invalid output %s", async (content, error) => {
    const input = setup();
    input.fetchImpl.mockResolvedValueOnce(success(content));
    expect(await executeLlmStructuredTool({ ...input, parameters: { ...input.parameters, requiredFields: ["answer"] } }))
      .toMatchObject({ status: 422, body: { error } });
  });

  it("reads a real UTF-8 file, sends strict schema mode, and persists formatted JSON", async () => {
    const input = setup();
    const dir = await mkdtemp(path.join(tmpdir(), "llm-structured-"));
    try {
      const source = path.join(dir, "source.txt");
      const stepOutputDir = path.join(dir, "out");
      await writeFile(source, "입력 내용");
      const schema = { type: "object", properties: { answer: { type: "boolean" } }, required: ["answer"], additionalProperties: false };
      const request = { ...input, stepOutputDir, parameters: { ...input.parameters,
        inputFiles: [{ label: "source", path: source }], jsonSchema: schema,
        requiredFields: ["answer"], artifactFileName: "result.json" } };
      const response = await executeLlmStructuredTool(request);
      const outputPath = path.join(stepOutputDir, "result.json");
      expect(response).toMatchObject({ status: 200, artifactPath: outputPath, body: { data: { output: { answer: true } } } });
      expect(await readFile(outputPath, "utf8")).toBe('{\n  "answer": true\n}\n');
      const [url, init] = input.fetchImpl.mock.calls[0]!;
      expect(url).toBe("https://provider.invalid/v1/chat/completions");
      const payload = JSON.parse(String(init?.body));
      expect(payload.response_format).toEqual({ type: "json_schema", json_schema: { name: "structured_output", strict: true, schema } });
      expect(JSON.parse(payload.messages[0].content).inputFiles).toEqual([{ label: "source", content: "입력 내용" }]);
      await writeFile(source, Buffer.from([0xff]));
      expect(await executeLlmStructuredTool(request)).toMatchObject({ status: 422, body: { error: "llm_structured_invalid_input_file" } });
      expect(input.fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("consumes a streamed SSE completion end to end", async () => {
    const input = setup();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of ['{"ans', 'wer":true}']) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(piece)}}}]}\n\n`));
        }
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"total_tokens":4}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    input.fetchImpl.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await executeLlmStructuredTool(input);
    expect(response).toMatchObject({ status: 200, body: { data: { output: { answer: true }, usage: { total_tokens: 4 } } } });
    expect(JSON.parse(String(input.fetchImpl.mock.calls[0]?.[1]?.body)).stream).toBe(true);
  });
});
