// server/src/services/workflow/harness-advisor-gate.ts
//
// Fail-closed verifier for a workflow advisor-gate checkpoint document (Stage S23-4).
//
// A checkpoint is the ONLY authority an advisor has over gate progress. It must be a
// machine-produced JSON object with an exact, versioned shape; nothing derived from
// natural language (e.g. "[advisor:pass]" markers in comments or stdout) can ever
// produce `allowsProgress: true` (AGENTS.md rule 9).

import {
  HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION,
  type HarnessAdvisorVerdict,
} from "./workflow-harness-rust-client.js";

/** Short gate ids used by this verifier (g1 pre-plan · g2 second error · g3 pre-closeout). */
export const HARNESS_ADVISOR_GATE_IDS = ["g1", "g2", "g3"] as const;
export type HarnessAdvisorGateId = (typeof HARNESS_ADVISOR_GATE_IDS)[number];

export interface AdvisorGateCheckpointExpectation {
  companyId: string;
  runId: string;
  stepId: string;
  gate: HarnessAdvisorGateId;
}

export type AdvisorGateCheckpointVerdict = HarnessAdvisorVerdict["decision"];

export interface AdvisorGateCheckpointVerification {
  /** true only when the document is a well-formed, attributable, unexpired checkpoint. */
  valid: boolean;
  /** true only for a valid checkpoint whose verdict is `pass`. */
  allowsProgress: boolean;
  /** Machine-readable outcome code. Never free text from the document. */
  reason: string;
  /** Present only when `valid` is true. */
  verdict?: AdvisorGateCheckpointVerdict;
}

export interface AdvisorGateCheckpointVerificationOptions {
  /** Clock used for expiry checks (epoch ms). Defaults to `Date.now()`. */
  nowMs?: number;
}

export const ADVISOR_GATE_CHECKPOINT_KEYS = [
  "schemaVersion",
  "companyId",
  "runId",
  "stepId",
  "gate",
  "verdict",
  "issuedAt",
  "expiresAt",
] as const;

const REASON = {
  pass: "advisor_checkpoint_pass",
  challenge: "advisor_checkpoint_challenge",
  notAnObject: "advisor_checkpoint_not_an_object",
  unrecognizedKey: "advisor_checkpoint_unrecognized_key",
  unsupportedSchemaVersion: "advisor_checkpoint_unsupported_schema_version",
  invalidField: "advisor_checkpoint_invalid_field",
  unknownGate: "advisor_checkpoint_unknown_gate",
  invalidVerdict: "advisor_checkpoint_invalid_verdict",
  companyIdMismatch: "advisor_checkpoint_company_mismatch",
  runIdMismatch: "advisor_checkpoint_run_mismatch",
  stepIdMismatch: "advisor_checkpoint_step_mismatch",
  gateMismatch: "advisor_checkpoint_gate_mismatch",
  notYetValid: "advisor_checkpoint_not_yet_valid",
  expired: "advisor_checkpoint_expired",
  expectedInvalid: "advisor_checkpoint_expected_invalid",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function invalid(reason: string): AdvisorGateCheckpointVerification {
  return { valid: false, allowsProgress: false, reason };
}

function parseVerdict(value: unknown): HarnessAdvisorVerdict | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (value.decision === "pass") {
    // `pass` carries no reason; any extra key is a contract violation.
    return keys.length === 1 ? { decision: "pass" } : null;
  }
  if (value.decision === "challenge" && keys.length === 2 && isNonEmptyString(value.reason)) {
    return { decision: "challenge", reason: value.reason };
  }
  return null;
}

function checkTimeWindow(
  doc: Record<string, unknown>,
  nowMs: number,
): AdvisorGateCheckpointVerification | null {
  const { issuedAt, expiresAt } = doc;
  if (!isEpochMs(issuedAt) || !isEpochMs(expiresAt) || expiresAt <= issuedAt) {
    return invalid(REASON.invalidField);
  }
  if (issuedAt > nowMs) return invalid(REASON.notYetValid);
  if (expiresAt <= nowMs) return invalid(REASON.expired);
  return null;
}

/**
 * Verify an advisor-gate checkpoint strictly and fail closed.
 *
 * Accepted shape (every key required, no extra keys):
 *   `{ schemaVersion: 1, companyId, runId, stepId, gate: "g1"|"g2"|"g3",
 *      verdict: { decision: "pass" } | { decision: "challenge", reason },
 *      issuedAt: epochMs, expiresAt: epochMs }`
 *
 * Never throws: any defect (non-object, natural-language string, missing/unsupported
 * version, unknown gate, bad verdict, company/run/step/gate mismatch, malformed or
 * expired window, invalid expectation) yields `valid:false, allowsProgress:false`
 * with a machine reason code.
 */
export function verifyAdvisorGateCheckpoint(
  raw: unknown,
  expected: AdvisorGateCheckpointExpectation,
  options: AdvisorGateCheckpointVerificationOptions = {},
): AdvisorGateCheckpointVerification {
  if (!isRecord(expected)
    || !isNonEmptyString(expected.companyId) || !isNonEmptyString(expected.runId)
    || !isNonEmptyString(expected.stepId) || !isOneOf(expected.gate, HARNESS_ADVISOR_GATE_IDS)) {
    return invalid(REASON.expectedInvalid);
  }
  // A string (e.g. "[advisor:pass]") or any other non-object is never a checkpoint.
  if (!isRecord(raw)) return invalid(REASON.notAnObject);
  if (Object.keys(raw).some((key) => !(ADVISOR_GATE_CHECKPOINT_KEYS as readonly string[]).includes(key))) {
    return invalid(REASON.unrecognizedKey);
  }
  if (raw.schemaVersion !== HARNESS_ADVISOR_CHECKPOINT_SCHEMA_VERSION) {
    return invalid(REASON.unsupportedSchemaVersion);
  }
  if (!isNonEmptyString(raw.companyId) || !isNonEmptyString(raw.runId) || !isNonEmptyString(raw.stepId)) {
    return invalid(REASON.invalidField);
  }
  if (!isOneOf(raw.gate, HARNESS_ADVISOR_GATE_IDS)) return invalid(REASON.unknownGate);
  const verdict = parseVerdict(raw.verdict);
  if (verdict === null) return invalid(REASON.invalidVerdict);

  // Attribution: the document must be bound to exactly the expected company/run/step/gate.
  if (raw.companyId !== expected.companyId) return invalid(REASON.companyIdMismatch);
  if (raw.runId !== expected.runId) return invalid(REASON.runIdMismatch);
  if (raw.stepId !== expected.stepId) return invalid(REASON.stepIdMismatch);
  if (raw.gate !== expected.gate) return invalid(REASON.gateMismatch);

  const nowMs = options.nowMs ?? Date.now();
  if (!isEpochMs(nowMs)) return invalid(REASON.expectedInvalid);
  const timeFailure = checkTimeWindow(raw, nowMs);
  if (timeFailure !== null) return timeFailure;

  return verdict.decision === "pass"
    ? { valid: true, allowsProgress: true, reason: REASON.pass, verdict: "pass" }
    : { valid: true, allowsProgress: false, reason: REASON.challenge, verdict: "challenge" };
}
