import {
  applyRunInputDerivations as applyRunInputDerivationsNode,
  extractYoutubeVideoId as extractYoutubeVideoIdNode,
  validateRunInputDeclarations as validateRunInputDeclarationsNode,
  type RunInputDerivationResult,
  type WorkflowRunInputDeclaration,
} from "./run-input-derivations.js";
import {
  findWorkflowDefinitionStepWarnings as findWorkflowDefinitionStepWarningsNode,
  summarizeDefinitionStepWarnings as summarizeDefinitionStepWarningsNode,
  validateWorkflowDefinitionSteps as validateWorkflowDefinitionStepsNode,
  type WorkflowDefinitionStepWarning,
  type WorkflowSelectorAwareStep,
} from "./definition-step-validation.js";
import type { WorkflowArtifactReferenceStep } from "./step-artifact-references.js";
import { runWithNodeFallback, WorkflowCoreContractError } from "./workflow-core-client.js";

/**
 * [목적] Stage 8C 서브커맨드(extract-youtube-video-id /
 *   validate-run-input-declarations / apply-run-input-derivations /
 *   validate-definition-steps / definition-step-warnings /
 *   summarize-step-warnings)의 Node 브리지.
 *   workflow-core-client.ts 의 runWithNodeFallback/게이트/warn-once 계약을 그대로 재사용한다.
 * [주의] 응답 shape 는 TS 반환 타입 계약으로 엄격히 검증한다 — 선언 계약 밖 값은
 *   계약 위반으로 TS fallback 하고 TS 팔이 원래 동작을 그대로 재현한다.
 *   시맨틱 에러(비문자열 value.match TypeError·zod/정책 거부·비iterable steps·
 *   null destructure)는 Rust 가 exit 1 + 동일 메시지로 재현하므로 Unavailable 과
 *   구분할 수 없어 warn 후 TS 팔이 같은 예외를 다시 던진다
 *   (호출자는 어느 판정이든 동일 실패를 본다).
 *   F4: 서브프로세스 스폰은 db.transaction 밖 async 호출자에서만 — 호출자가 보장한다.
 * [수정시 영향] shape 검증을 느슨히 하면 parity 를 깨뜨린 채 fallback 없이 흐른다.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ok:true}` 봉투 — validator 서브커맨드의 유일한 성공 shape. */
function okEnvelope(response: unknown, reason: string): void {
  if (!isRecord(response) || response.ok !== true) {
    throw new WorkflowCoreContractError(`${reason}_bad_shape`);
  }
}

export function extractYoutubeVideoIdWithNodeFallback(
  value: string,
): Promise<string | null> {
  return runWithNodeFallback({
    subcommand: "extract-youtube-video-id",
    payload: () => ({ value }),
    fallback: () => extractYoutubeVideoIdNode(value),
    interpret: (response) => {
      if (!isRecord(response) || !("videoId" in response)) {
        throw new WorkflowCoreContractError("workflow_core_youtube_id_bad_shape");
      }
      const videoId = response.videoId;
      if (videoId !== null && typeof videoId !== "string") {
        throw new WorkflowCoreContractError("workflow_core_youtube_id_bad_shape");
      }
      return videoId;
    },
  });
}

export function validateRunInputDeclarationsWithNodeFallback(
  runInputs: readonly WorkflowRunInputDeclaration[] | undefined,
): Promise<void> {
  return runWithNodeFallback({
    subcommand: "validate-run-input-declarations",
    payload: () => ({ runInputs }),
    fallback: () => validateRunInputDeclarationsNode(runInputs),
    interpret: (response) =>
      okEnvelope(response, "workflow_core_run_input_declarations"),
  });
}

/** `status: "ok"` arm — metadata 는 선언 계약상 Record 여야 한다(비객체 passthrough 입력은 TS 팔이 재현). */
function derivationOk(response: Record<string, unknown>): RunInputDerivationResult {
  if (!isRecord(response.metadata)) {
    throw new WorkflowCoreContractError("workflow_core_apply_derivations_bad_shape");
  }
  return { status: "ok", metadata: response.metadata };
}

/** `status: "error"` arm — message 필수 문자열, key 는 있으면 문자열(Rust 는 undefined key 를 생략). */
function derivationError(response: Record<string, unknown>): RunInputDerivationResult {
  if (typeof response.message !== "string"
    || (response.key !== undefined && typeof response.key !== "string")) {
    throw new WorkflowCoreContractError("workflow_core_apply_derivations_bad_shape");
  }
  return { status: "error", key: response.key as string, message: response.message };
}

export function applyRunInputDerivationsWithNodeFallback(
  runInputs: readonly WorkflowRunInputDeclaration[] | undefined,
  metadata: Record<string, unknown> | undefined,
): Promise<RunInputDerivationResult> {
  return runWithNodeFallback({
    subcommand: "apply-run-input-derivations",
    payload: () => ({ runInputs, metadata }),
    fallback: () => applyRunInputDerivationsNode(runInputs, metadata),
    interpret: (response) => {
      if (!isRecord(response)) {
        throw new WorkflowCoreContractError("workflow_core_apply_derivations_bad_shape");
      }
      if (response.status === "ok") return derivationOk(response);
      if (response.status === "error") return derivationError(response);
      throw new WorkflowCoreContractError("workflow_core_apply_derivations_bad_shape");
    },
  });
}

export function validateWorkflowDefinitionStepsWithNodeFallback(
  steps: readonly WorkflowArtifactReferenceStep[] | undefined,
): Promise<void> {
  return runWithNodeFallback({
    subcommand: "validate-definition-steps",
    payload: () => ({ steps }),
    fallback: () => validateWorkflowDefinitionStepsNode(steps),
    interpret: (response) =>
      okEnvelope(response, "workflow_core_definition_steps"),
  });
}

export function findWorkflowDefinitionStepWarningsWithNodeFallback(
  steps: readonly WorkflowSelectorAwareStep[],
): Promise<WorkflowDefinitionStepWarning[]> {
  return runWithNodeFallback({
    subcommand: "definition-step-warnings",
    payload: () => ({ steps }),
    fallback: () => findWorkflowDefinitionStepWarningsNode(steps),
    interpret: (response) => {
      const warnings = isRecord(response) ? response.warnings : undefined;
      if (!Array.isArray(warnings)) {
        throw new WorkflowCoreContractError("workflow_core_step_warnings_bad_shape");
      }
      return warnings.map((raw) => {
        if (!isRecord(raw)
          || raw.kind !== "workproduct_selector_missing"
          || (raw.stepId !== undefined && typeof raw.stepId !== "string")
          || typeof raw.referencedStepId !== "string"
          || typeof raw.message !== "string") {
          throw new WorkflowCoreContractError("workflow_core_step_warnings_bad_item");
        }
        // Rust 는 id 없는 step 의 stepId 키를 생략 — TS 는 값 undefined 로 키를 유지한다.
        return { stepId: undefined, ...raw } as unknown as WorkflowDefinitionStepWarning;
      });
    },
  });
}

const SUMMARY_KEYS = new Set(["kind", "stepId", "referencedStepId"]);

/** summary 요소 — 세 키만, kind 는 리터럴·id 필드는 문자열이어야 선언 계약 충족. */
function isSummaryItem(raw: unknown): raw is Record<string, unknown> {
  if (!isRecord(raw)) return false;
  return Object.keys(raw).every((key) => {
    if (!SUMMARY_KEYS.has(key)) return false;
    const value = raw[key];
    if (value === undefined) return true;
    return key === "kind" ? value === "workproduct_selector_missing" : typeof value === "string";
  });
}

export function summarizeDefinitionStepWarningsWithNodeFallback(
  warnings: readonly WorkflowDefinitionStepWarning[],
): Promise<ReturnType<typeof summarizeDefinitionStepWarningsNode>> {
  return runWithNodeFallback({
    subcommand: "summarize-step-warnings",
    payload: () => ({ warnings }),
    fallback: () => summarizeDefinitionStepWarningsNode(warnings),
    interpret: (response) => {
      const summary = isRecord(response) ? response.summary : undefined;
      if (!Array.isArray(summary)) {
        throw new WorkflowCoreContractError("workflow_core_summarize_warnings_bad_shape");
      }
      // Rust 는 부재 키를 생략한다 — TS 는 세 키를 항상 둔다(값 undefined).
      return summary.map((raw) => {
        if (!isSummaryItem(raw)) {
          throw new WorkflowCoreContractError("workflow_core_summarize_warnings_bad_item");
        }
        return {
          kind: raw.kind,
          stepId: raw.stepId,
          referencedStepId: raw.referencedStepId,
        } as ReturnType<typeof summarizeDefinitionStepWarningsNode>[number];
      });
    },
  });
}
