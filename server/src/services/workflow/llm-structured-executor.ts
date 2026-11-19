import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { findSecretOriginPolicyFields, redactForEgress } from "../judgment/redact.js";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import type { Db } from "@paperclipai/db";
import { secretService } from "../secrets.js";
import { resolveWorkflowRunStepOutputDir } from "./remote-tool-context.js";
import { readObject, result } from "./http-tool-response.js";
import { callOpenAiCompatibleStructured, LlmStructuredProviderError, resolveLlmStructuredConfig,
  type LlmStructuredTransport } from "./llm-structured-provider.js";

const payloadLimit = 120_000;
const parametersSchema = z.object({
  instruction: z.string().max(16_000).refine((value) => value.trim().length > 0),
  systemPrompt: z.string().max(16_000).optional(),
  inputData: z.record(z.unknown()).optional(),
  inputFiles: z.array(z.object({
    label: z.string().min(1).max(payloadLimit),
    path: z.string().refine((value) => path.isAbsolute(value) && !value.includes("\0")),
    maxChars: z.number().int().positive().optional(),
  })).max(8).optional(),
  jsonSchema: z.record(z.unknown()).optional(),
  schemaName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  requiredFields: z.array(z.string()).optional(),
  artifactFileName: z.string().regex(/^[a-zA-Z0-9._-]+$/)
    .refine((name) => name !== "." && name !== ".." && !/\s/.test(name)).optional(),
});

async function readInputFile(filePath: string): Promise<string> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    // At most three UTF-8 bytes per UTF-16 code unit, plus an optional BOM.
    const maxBytes = payloadLimit * 3 + 3;
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    await file.close();
  }
}

// Like persistArtifact, publish by rename; retain human-readable indentation.
async function persistFormattedJson(dir: string, name: string, output: object): Promise<string> {
  const finalPath = path.resolve(dir, name);
  const tmp = path.join(path.dirname(finalPath), `.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmp, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, finalPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return finalPath;
}

export async function executeLlmStructuredWorkflowStep(input: {
  db: Db; companyId: string; toolName: string; parameters: unknown; adapterConfig: Record<string, unknown>;
  workflowRunId?: string | null; stepId?: string | null; issueId?: string | null; agentId?: string; heartbeatRunId?: string;
}): Promise<CoreWorkflowToolExecutionResult> {
  const { adapterConfig, companyId, db, toolName } = input;
  if (!input.workflowRunId?.trim() || !input.stepId?.trim() || input.issueId || input.heartbeatRunId || input.agentId) {
    return result(toolName, 403, "llm_structured_requires_issueless_workflow_step");
  }
  if (adapterConfig.requiresApproval === true) return result(toolName, 403, "llm_structured_requires_approval");
  let stepOutputDir: string | null;
  let resolvedEnv: Record<string, string> | undefined;
  try {
    stepOutputDir = await resolveWorkflowRunStepOutputDir(db, input);
    if (adapterConfig.env !== undefined) {
      const env = readObject(adapterConfig.env);
      const bindings = Object.fromEntries(Object.entries(env).filter(([key]) =>
        /^PAPERCLIP_LLM_STRUCTURED_(BASE_URL|API_KEY|MODEL)$/.test(key)));
      ({ env: resolvedEnv } = await secretService(db).resolveEnvBindings(companyId, bindings));
    }
  } catch {
    return result(toolName, 422, "llm_structured_context_resolution_failed");
  }
  return executeLlmStructuredTool({ ...input, resolvedEnv, stepOutputDir });
}

export async function executeLlmStructuredTool(input: LlmStructuredTransport & {
  toolName: string;
  parameters: unknown;
  adapterConfig: Record<string, unknown>;
  resolvedEnv?: Record<string, string>;
  stepOutputDir?: string | null;
}): Promise<CoreWorkflowToolExecutionResult> {
  const fail = (status: CoreWorkflowToolExecutionResult["status"], code: string) => result(input.toolName, status, code);
  const validated = parametersSchema.safeParse(input.parameters);
  if (!validated.success) return fail(422, "llm_structured_invalid_parameters");
  const config = resolveLlmStructuredConfig(input.adapterConfig, input.resolvedEnv);
  if (!config) return fail(422, "llm_structured_missing_or_invalid_config");
  const { instruction, systemPrompt, inputData, inputFiles, jsonSchema, schemaName, requiredFields, artifactFileName } = validated.data;
  const files: Array<{ label: string; content: string }> = [];
  try {
    let remaining = payloadLimit;
    for (const file of inputFiles ?? []) {
      const text = await readInputFile(file.path);
      const content = text.slice(0, file.maxChars ?? text.length);
      remaining -= file.label.length + content.length;
      if (remaining < 0) return fail(422, "llm_structured_payload_too_large");
      files.push({ label: file.label, content });
    }
  } catch {
    return fail(422, "llm_structured_invalid_input_file");
  }
  const payload = { user: { instruction, inputData: inputData ?? {}, inputFiles: files },
    systemPrompt: systemPrompt ?? "", jsonSchema: jsonSchema ?? null, schemaName: schemaName ?? "structured_output" };
  let outbound: typeof payload;
  let egressStatus: string;
  try {
    const redaction = redactForEgress(payload);
    if (redaction.status === "error") return fail(422, "llm_structured_egress_check_failed");
    if (findSecretOriginPolicyFields(payload).length) return fail(403, "llm_structured_egress_blocked");
    if (JSON.stringify(payload).length > payloadLimit) return fail(422, "llm_structured_payload_too_large");
    outbound = redaction.redacted as typeof payload;
    const serialized = JSON.stringify(outbound);
    if (serialized.length > payloadLimit) return fail(422, "llm_structured_payload_too_large");
    // The shared detector masks values, not keys. Block any remaining matches rather than rewriting keys.
    if (redactForEgress(serialized).status !== "checked_no_findings") return fail(403, "llm_structured_egress_blocked");
    egressStatus = redaction.status;
  } catch {
    return fail(422, "llm_structured_egress_check_failed");
  }
  try {
    const { parsedJson, model, usage, latencyMs, attempts } = await callOpenAiCompatibleStructured({
      ...config, fetchImpl: input.fetchImpl, sleepImpl: input.sleepImpl,
      userContent: JSON.stringify(outbound.user), systemPrompt: systemPrompt === undefined ? undefined : outbound.systemPrompt,
      jsonSchema: outbound.jsonSchema ?? undefined, schemaName: outbound.schemaName,
      responseFormatMode: input.adapterConfig.responseFormatMode === "json_object" ? "json_object" : undefined,
    });
    if (!parsedJson || typeof parsedJson !== "object" || Object.getPrototypeOf(parsedJson) !== Object.prototype
      || requiredFields?.some((key) => !Object.hasOwn(parsedJson, key) || (parsedJson as Record<string, unknown>)[key] === undefined)) {
      return fail(422, "llm_structured_schema_mismatch");
    }
    let artifactPath: string | undefined;
    if (artifactFileName && input.stepOutputDir) {
      if (path.resolve(input.stepOutputDir, artifactFileName).includes(config.apiKey)) return fail(422, "llm_structured_unsafe_artifact_path");
      artifactPath = await persistFormattedJson(input.stepOutputDir, artifactFileName, parsedJson);
    }
    return { status: 200, artifactPath, body: { content: JSON.stringify(parsedJson),
      data: { output: parsedJson, model, usage, latencyMs, attempts, egressStatus }, tool: input.toolName, source: "core" } };
  } catch (error) {
    if (error instanceof LlmStructuredProviderError) {
      if (error.code === "invalid_response") return fail(422, "llm_structured_invalid_response");
      if (error.code === "unsafe_request") return fail(403, "llm_structured_egress_blocked");
      return fail(503, "llm_structured_provider_failed");
    }
    return fail(500, "llm_structured_execution_failed");
  }
}
