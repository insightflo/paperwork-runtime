// Stage 26 Wave 3c: human_wait resume/continuation directive mapper.
// Consumes ONLY the structured HumanWaitGateDecision verdict from human-wait-gate and
// maps it into per-step continuation directives. There is no natural-language parsing
// anywhere in this module (rule 8: comments/prose are never execution authority) and no
// run dispatch happens here — the mapper only decides what the caller may do next:
// hold the step, complete it and wake downstream, or fail it.
import {
  resolveStepLogicalClass,
  type WorkflowStepLogicalClassSource,
} from "@paperclipai/shared/types/workflow";
import type { HumanWaitGateDecision } from "./human-wait-gate.js";

/** What the caller should do with the human_wait step for this gate evaluation. */
export type HumanWaitStepAction =
  | "hold_waiting_approval"
  | "complete_and_continue"
  | "fail_step";

/** Structured reason codes — stable contract values, never free-form prose. */
export type HumanWaitStepReasonCode =
  | "awaiting_human_decision"
  | "human_decision_approved"
  | "human_decision_rejected"
  | "human_decision_expired";

/** Run/step identity the directive is bound to (echoed onto every directive). */
export interface HumanWaitStepDirectiveContext {
  workflowRunId: string;
  stepKey: string;
  generation: number;
}

/** Self-contained continuation directive for one human_wait step gate evaluation. */
export interface HumanWaitStepDirective extends HumanWaitStepDirectiveContext {
  stepAction: HumanWaitStepAction;
  /** Always false: the run is already dispatched; the gate only governs continuation. */
  shouldDispatchRun: boolean;
  /** true only when the step completed via structured human approval. */
  shouldWakeDownstream: boolean;
  /** operator_decisions card identity the verdict came from. */
  decisionId: string;
  requestKey: string;
  reasonCode: HumanWaitStepReasonCode;
}

/**
 * Maps a structured gate verdict into the per-step continuation directive.
 * Deterministic over (gateResult, context): pause holds the step, resume completes it
 * and wakes downstream, fail ends the step with expired/rejected derived strictly from
 * the structured resolution field. Run dispatch is never re-triggered here.
 */
export function buildHumanWaitStepDirective(
  gateResult: HumanWaitGateDecision,
  context: HumanWaitStepDirectiveContext,
): HumanWaitStepDirective {
  switch (gateResult.action) {
    case "pause":
      return {
        ...context,
        stepAction: "hold_waiting_approval",
        shouldDispatchRun: false,
        shouldWakeDownstream: false,
        decisionId: gateResult.decisionId,
        requestKey: gateResult.requestKey,
        reasonCode: "awaiting_human_decision",
      };
    case "resume":
      return {
        ...context,
        stepAction: "complete_and_continue",
        shouldDispatchRun: false,
        shouldWakeDownstream: true,
        decisionId: gateResult.decisionId,
        requestKey: gateResult.requestKey,
        reasonCode: "human_decision_approved",
      };
    case "fail":
      return {
        ...context,
        stepAction: "fail_step",
        shouldDispatchRun: false,
        shouldWakeDownstream: false,
        decisionId: gateResult.decisionId,
        requestKey: gateResult.requestKey,
        reasonCode: gateResult.resolution === "expired"
          ? "human_decision_expired"
          : "human_decision_rejected",
      };
  }
}

/**
 * True when a workflow step definition materializes as a human_wait wait: explicit
 * type === "human_wait", a declared decision template, or the legacy graph approval
 * flag. Classification is delegated to the shared resolveStepLogicalClass vocabulary
 * so server and UI cannot drift apart.
 */
export function isHumanWaitStepDefinition(
  step: WorkflowStepLogicalClassSource | null | undefined,
): boolean {
  return resolveStepLogicalClass(step) === "human_wait";
}
