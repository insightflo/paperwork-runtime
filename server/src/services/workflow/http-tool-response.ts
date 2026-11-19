import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { interpretTargetFailureStatusSentence } from "../failure-interpretation.js";
import type { CoreWorkflowToolExecutionResult } from "./core-tool-executor.js";
import type { HttpWorkflowToolExecutionInput } from "./http-tool-adapter.js";

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function result(toolName: string, status: CoreWorkflowToolExecutionResult["status"], error?: string,
  extra?: CoreWorkflowToolExecutionResult["body"]): CoreWorkflowToolExecutionResult {
  return { status, body: { tool: toolName, source: "core", error, ...extra } };
}
type ResponseAssertion =
  | { field: string; kind: "equals"; expected: boolean | number | string }
  | { field: string; kind: "positiveNumber" | "existingFile" | "boolean" };
export type ResponseContract = {
  resultField: string; artifactField: string | null; artifactFileName: string; artifactPathResultField: string;
  assertions: ResponseAssertion[];
};
function resolveResponseAssertions(raw: unknown): ResponseAssertion[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const assertions: ResponseAssertion[] = [];
  for (const item of raw) {
    const entry = readObject(item);
    const field = nonEmptyString(entry.field);
    if (!field) return null;
    const hasEquals = "equals" in entry;
    const type = nonEmptyString(entry.type);
    if (hasEquals && type) return null;
    if (hasEquals) {
      const expected = entry.equals;
      if (typeof expected !== "boolean" && typeof expected !== "number" && typeof expected !== "string") return null;
      assertions.push({ field, kind: "equals", expected });
    } else if (type === "positiveNumber" || type === "existingFile" || type === "boolean") assertions.push({ field, kind: type });
    else return null;
  }
  return assertions;
}
export function resolveResponseContract(response: unknown): ResponseContract | null {
  const cfg = readObject(response);
  const resultField = nonEmptyString(cfg.resultField);
  const artifactField = nonEmptyString(cfg.artifactField);
  const artifactFileName = nonEmptyString(cfg.artifactFileName);
  const artifactPathResultField = nonEmptyString(cfg.artifactPathResultField);
  const assertions = resolveResponseAssertions(cfg.assertions);
  if (!resultField || assertions === null) return null;
  if (artifactField !== null) {
    if (!artifactFileName || !artifactPathResultField || path.basename(artifactFileName) !== artifactFileName || artifactFileName.includes(path.sep)) return null;
    return { resultField, artifactField, artifactFileName, artifactPathResultField, assertions };
  }
  if (artifactFileName || artifactPathResultField) return null;
  return { resultField, artifactField: null, artifactFileName: "", artifactPathResultField: "", assertions };
}
/** Dotted-path field read (e.g. "stateToken.version") over plain objects only; any missing
 *  segment resolves to undefined so the assertion kind fails closed with a named-field error. */
function readAssertionField(base: Record<string, unknown>, field: string): unknown {
  if (!field.includes(".")) return base[field];
  let current: unknown = base;
  for (const segment of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
async function checkResponseAssertions(toolName: string, assertions: ResponseAssertion[], baseResult: Record<string, unknown>, requestId: string) {
  for (const assertion of assertions) {
    const actual = readAssertionField(baseResult, assertion.field);
    let passed = false;
    let expectation: string;
    if (assertion.kind === "equals") {
      passed = actual === assertion.expected;
      expectation = `must equal ${JSON.stringify(assertion.expected)}`;
    } else if (assertion.kind === "positiveNumber") {
      passed = typeof actual === "number" && Number.isFinite(actual) && actual > 0;
      expectation = "must be a finite number > 0";
    } else if (assertion.kind === "boolean") {
      passed = typeof actual === "boolean";
      expectation = "must be a boolean";
    } else {
      const candidate = nonEmptyString(actual);
      if (candidate && path.isAbsolute(candidate)) {
        try { const info = await stat(candidate); passed = info.isFile() && info.size > 0; } catch { /* missing file */ }
      }
      expectation = "must be an absolute path to an existing non-empty file";
    }
    if (!passed) return `Workflow tool "${toolName}" response contract violated: field "${assertion.field}" ${expectation} (request id: ${requestId})`;
  }
  return null;
}
export function redactSecret(value: string, secret: string): string {
  if (!secret || !value.includes(secret)) return value;
  return value.split(secret).join("");
}
/** [사람 해석 프리픽스 — 2026-11-17 운영자 요구] scrapling 계열 원격 도구는 대상 수집 실패를
 *  HTTP 424 + {"error":"target fetch failed","message":"target returned HTTP <n>","url":"…",
 *  "targetStatus":<n>} 구조로 보고한다. 이 진단 문자열은 미션 오너를 거쳐 사람 카드 증상에
 *  그대로 실리므로, 운영자가 기계 JSON을 해독하지 않아도 되게 한국어 해석 문장을 앞에 붙이고
 *  원본 diagnostic은 뒤에 보존한다. 절단 대상은 (원본: …) 안의 원본뿐 — 해석 문장은 잘리지
 *  않는다. targetStatus(number)·url(string)이 없거나 해석 계열이 없는 상태 코드, 그리고
 *  JSON 파싱 실패·구조 불일치에는 기존 동작(원본 1000자 절단)을 그대로 반환한다. */
export function humanizeRemoteDiagnostic(diagnostic: string): string {
  const bounded = diagnostic.slice(0, 1000);
  let parsed: unknown;
  try { parsed = JSON.parse(diagnostic); } catch { return bounded; }
  const record = readObject(parsed);
  const targetStatus = record.targetStatus;
  const url = nonEmptyString(record.url);
  if (typeof targetStatus !== "number" || !Number.isFinite(targetStatus) || url === null) return bounded;
  // 상태 코드→문장 매핑은 failure-interpretation.ts의 단일 레지스트리가 담당한다 — 사람 카드의
  //   원인 해석이 같은 문구를 공유하므로 여기서 별도 분기를 두지 않는다.
  const sentence = interpretTargetFailureStatusSentence(targetStatus);
  if (sentence === null) return bounded;
  return `[사람 해석] ${sentence} (대상: ${url}) (원본: ${bounded})`;
}
export async function persistArtifact(stepOutputDir: string, fileName: string, artifactValue: unknown, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const dir = path.resolve(stepOutputDir);
  const finalPath = path.join(dir, fileName);
  const tempPath = path.join(dir, `.${fileName}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  signal?.throwIfAborted();
  try {
    await writeFile(tempPath, JSON.stringify(artifactValue), { mode: 0o600 });
    signal?.throwIfAborted();
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return finalPath;
}
export async function consumeHttpToolResponse(res: Response, input: HttpWorkflowToolExecutionInput,
  contract: ResponseContract, secrets: string[], signal: AbortSignal): Promise<CoreWorkflowToolExecutionResult> {
  const { toolName } = input;
  const failure = (message: string) => result(toolName, 500, message);
  if (res.status === 401 || res.status === 403) return result(toolName, 403, `Workflow tool "${toolName}" was rejected by the remote endpoint`);
  if (!res.ok) {
    let diagnostic = "";
    try { diagnostic = await res.text(); } catch { /* bounded timeout handled by caller */ }
    signal.throwIfAborted();
    for (const secret of secrets) diagnostic = redactSecret(diagnostic, secret);
    // 이 진단은 미션 오너를 거쳐 사람 카드 증상으로 전파되므로, 비밀 마스킹 뒤 구조화 진단에는
    //   한국어 해석을 선행시킨다. 1000자 절단은 (원본: …) 안의 원본에만 적용되어 해석 문장은
    //   잘리지 않는다(비구조화 진단은 기존과 동일하게 절단된 원본만 반환).
    diagnostic = humanizeRemoteDiagnostic(diagnostic);
    return failure(`Workflow tool "${toolName}" remote endpoint returned status ${res.status}${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  let envelope: unknown;
  try { envelope = await res.json(); }
  catch {
    signal.throwIfAborted();
    return failure(`Workflow tool "${toolName}" remote endpoint returned a non-JSON response`);
  }
  signal.throwIfAborted();
  const envRecord = readObject(envelope);
  const resultValue = envRecord[contract.resultField];
  if (resultValue === undefined) return failure(`Workflow tool "${toolName}" remote response is missing required fields`);
  const baseResult = readObject(resultValue);
  let artifactPath: string | undefined;
  if (contract.artifactField !== null) {
    const artifactValue = envRecord[contract.artifactField];
    if (artifactValue === undefined) return failure(`Workflow tool "${toolName}" remote response is missing required fields`);
    const dir = typeof input.stepOutputDir === "string" ? input.stepOutputDir.trim() : "";
    if (!dir) return failure(`Workflow tool "${toolName}" could not resolve a step output directory for the artifact`);
    try { artifactPath = await persistArtifact(dir, contract.artifactFileName, artifactValue, signal); }
    catch {
      signal.throwIfAborted();
      return failure(`Workflow tool "${toolName}" could not persist the response artifact`);
    }
  }
  // Keep raw artifact evidence on assertion failure, without authorizing success.
  const violation = await checkResponseAssertions(toolName, contract.assertions, baseResult, input.requestId);
  signal.throwIfAborted();
  if (violation) return failure(`${violation}${artifactPath ? `; raw response retained at ${artifactPath}` : ""}`);
  const data = artifactPath ? { ...baseResult, [contract.artifactPathResultField]: artifactPath } : baseResult;
  return { status: 200, body: { content: JSON.stringify(data), data, tool: toolName, source: "core" } };
}
