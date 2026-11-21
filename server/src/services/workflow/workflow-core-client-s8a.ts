import { forwardReachable as forwardReachableNode } from "./resume/graph.js";
import type { ResumeNode } from "./resume/types.js";
import {
  normalizeWorkflowStepContract as normalizeWorkflowStepContractNode,
  normalizeWorkflowStepMachineChecks as normalizeWorkflowStepMachineChecksNode,
} from "./step-contract.js";
import type { WorkflowStepContract, WorkflowStepMachineCheck } from "@paperclipai/shared";
import { runWithNodeFallback, WorkflowCoreContractError } from "./workflow-core-client.js";

/**
 * [목적] Stage 8A 서브커맨드(forward-reachable / normalize-step-contract /
 *   normalize-step-machine-checks)의 Node 브리지.
 *   workflow-core-client.ts 의 runWithNodeFallback/게이트/warn-once 계약을 그대로 재사용한다.
 * [주의] 응답 shape 는 TS 반환 타입 계약으로 엄격히 검증한다 — 선언 계약 밖 값
 *   (비문자열 reachable id, 알 수 없는 contract 키, kind 집합 밖 machine check)는
 *   계약 위반으로 TS fallback 하고 TS 팔이 원래 동작을 그대로 재현한다.
 *   시맨틱 에러(unsupported_graph, 비iterable deps·null node TypeError)는 Rust 가
 *   exit 1 로 재현하므로 Unavailable 과 구분할 수 없어 warn 후 TS 팔이 같은 예외를
 *   다시 던진다(호출자는 어느 판정이든 동일 실패를 본다).
 *   F4: 서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `{key: [...]}` 봉투에서 문자열 배열 필드를 꺼낸다 — shape 불량은 계약 위반.
 *   빈 배열도 거부한다(reachable 은 start 를 항상 포함해 TS 가 [] 를 내지 않는다). */
function stringArrayField(response: unknown, key: string, reason: string): string[] {
  const value = isRecord(response) ? response[key] : undefined;
  if (!isStringArray(value) || value.length === 0) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
  return value;
}

/** machineStepCheckSchema 분기별 필드 — "int" 는 Number.isInteger + 최솟값. */
const MACHINE_CHECK_FIELDS = {
  file_exists: { path: "string" },
  file_glob: { dir: "string", glob: "string", minCount: "int:1" },
  min_size_bytes: { path: "string", minBytes: "int:0" },
  content_sha256: { path: "string", sha256: "string" },
} as const;

/** WorkflowStepMachineCheck 판정 — kind·필드 집합·타입·정수 하한이 선언 계약과 다르면 false. */
function isMachineCheck(value: unknown): value is WorkflowStepMachineCheck {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  const fields = MACHINE_CHECK_FIELDS[value.kind as keyof typeof MACHINE_CHECK_FIELDS];
  if (!fields) return false;
  const keys = Object.keys(value);
  const spec = Object.entries(fields);
  if (keys.length !== spec.length + 1) return false;
  return spec.every(([key, rule]) => {
    const field = value[key];
    if (rule === "string") return typeof field === "string";
    const min = rule === "int:1" ? 1 : 0;
    return typeof field === "number" && Number.isInteger(field) && field >= min;
  });
}

/** `{machineChecks: [...]|null}` — TS 는 전부 drop 시 undefined 를 반환한다. */
function machineChecksField(response: unknown, key: string, reason: string): WorkflowStepMachineCheck[] | undefined {
  if (!isRecord(response) || !(key in response)) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
  const value = response[key];
  if (value === null) return undefined;
  // TS 는 전부 drop 시 undefined — 빈 배열은 계약 밖.
  if (!Array.isArray(value) || value.length === 0 || !value.every(isMachineCheck)) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
  return value;
}

export function forwardReachableWithNodeFallback(
  nodes: ResumeNode[],
  startId: string,
): Promise<string[]> {
  return runWithNodeFallback({
    subcommand: "forward-reachable",
    payload: () => ({ nodes, startId }),
    fallback: () => forwardReachableNode(nodes, startId),
    interpret: (response) =>
      stringArrayField(response, "reachable", "workflow_core_forward_reachable"),
  });
}

const CONTRACT_SECTION_KEYS = new Set([
  "preconditions",
  "postconditions",
  "undefinedBehaviors",
]);

/** `{contract: <obj|null>}` — 섹션은 문자열 배열, machineChecks 는 검증 술어 배열만 허용. */
function contractField(response: unknown, reason: string): WorkflowStepContract | null {
  if (!isRecord(response) || !("contract" in response)) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
  const contract = response.contract;
  if (contract === null) return null;
  if (!isRecord(contract)) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
  const keys = Object.keys(contract);
  if (keys.length === 0) throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  for (const key of keys) {
    const value = contract[key];
    if (CONTRACT_SECTION_KEYS.has(key)) {
      // TS 는 빈 섹션을 키 자체를 생략해 표현 — 빈 배열은 계약 밖.
      if (!isStringArray(value) || value.length === 0) {
        throw new WorkflowCoreContractError(`${reason}_bad_shape`);
      }
    } else if (key === "machineChecks") {
      if (!Array.isArray(value) || value.length === 0 || !value.every(isMachineCheck)) {
        throw new WorkflowCoreContractError(`${reason}_bad_shape`);
      }
    } else {
      throw new WorkflowCoreContractError(`${reason}_bad_shape`);
    }
  }
  return contract as unknown as WorkflowStepContract;
}

export function normalizeWorkflowStepContractWithNodeFallback(
  value: unknown,
): Promise<WorkflowStepContract | null> {
  return runWithNodeFallback({
    subcommand: "normalize-step-contract",
    payload: () => ({ value }),
    fallback: () => normalizeWorkflowStepContractNode(value),
    interpret: (response) => contractField(response, "workflow_core_step_contract"),
  });
}

export function normalizeWorkflowStepMachineChecksWithNodeFallback(
  value: unknown,
): Promise<WorkflowStepMachineCheck[] | undefined> {
  return runWithNodeFallback({
    subcommand: "normalize-step-machine-checks",
    payload: () => ({ value }),
    fallback: () => normalizeWorkflowStepMachineChecksNode(value),
    interpret: (response) =>
      machineChecksField(response, "machineChecks", "workflow_core_step_machine_checks"),
  });
}
