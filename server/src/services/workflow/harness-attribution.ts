// server/src/services/workflow/harness-attribution.ts
//
// Pure, database-free TypeScript parity of
// crates/workflow-core/src/harness_gate/attribution.rs: verification backprop
// attribution applied to an EWMA success-rate prior, plus the local part of the
// Beta-mean posterior. Deterministic — same input, same output.

/** EWMA decay γ (harness_gate.rs `GAMMA`). */
export const HARNESS_GAMMA = 0.92;
/** Virtual prior sample mass M0 (harness_gate.rs `M0`). */
export const HARNESS_PRIOR_MASS = 6.0;
/** `rawSamples >= N_MIN` → measured flag (harness_gate.rs `N_MIN`). */
export const HARNESS_N_MIN = 5;
/** Weight of a verifier-rejected sample (harness_gate.rs `VERDICT_FAIL_PENALTY`). */
export const HARNESS_VERDICT_FAIL_PENALTY = 2.0;

export type HarnessStepAttributionKind =
  | "success"
  | "failed"
  | "rework"
  | "stalled"
  | "isolated"
  | "unrecognized";

/** camelCase wire shape of Rust `SuccessRatePrior`. */
export interface HarnessSuccessRatePrior {
  ewmaSuccess: number;
  ewmaFail: number;
  rawSamples: number;
  consecutiveErrors: number;
}

/** camelCase wire shape of Rust `StepVerdictAttribution`; `null` = verifier did not intervene. */
export interface HarnessStepVerdictAttribution {
  runId: string;
  stepRunId: string;
  /** ok | fail | rework | config_error | interrupted | rerouted | skipped */
  outcome: string;
  verdictPass: boolean | null;
  stallDetected: boolean;
  durationMs: number;
}

export interface HarnessAttributionUpdate {
  runId: string;
  stepRunId: string;
  kind: HarnessStepAttributionKind;
  /** false ⇒ prior unchanged (isolated · unrecognized · missing run/step binding). */
  recorded: boolean;
  weight: number;
  prior: HarnessSuccessRatePrior;
}

/** Rust `SuccessRatePrior::default()` — all zeros. */
export const DEFAULT_SUCCESS_RATE_PRIOR: Readonly<HarnessSuccessRatePrior> = Object.freeze({
  ewmaSuccess: 0,
  ewmaFail: 0,
  rawSamples: 0,
  consecutiveErrors: 0,
});

export interface HarnessSuccessRatePosterior {
  p: number;
  measured: boolean;
  samples: number;
}

/** `(M0·p0 + s) / (M0 + s + f)` — Beta mean with prior mass; measured once n ≥ N_MIN. */
export function computePosterior(
  prior: HarnessSuccessRatePrior,
  p0: number,
): HarnessSuccessRatePosterior {
  const alpha = HARNESS_PRIOR_MASS * p0;
  return {
    p: (alpha + prior.ewmaSuccess) / (HARNESS_PRIOR_MASS + prior.ewmaSuccess + prior.ewmaFail),
    measured: prior.rawSamples >= HARNESS_N_MIN,
    samples: prior.rawSamples,
  };
}

const SUCCESS_OUTCOMES = new Set(["ok", "completed", "success"]);
const FAIL_OUTCOMES = new Set(["fail", "failed", "error"]);
const ISOLATED_OUTCOMES = new Set(["config_error", "interrupted", "rerouted", "skipped"]);

/** Rust `str::to_ascii_lowercase` — non-ASCII bytes are left untouched. */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

function classify(attr: HarnessStepVerdictAttribution): HarnessStepAttributionKind | null {
  if (attr.stallDetected) return "stalled";
  const outcome = asciiLowercase(attr.outcome.trim());
  if (SUCCESS_OUTCOMES.has(outcome)) {
    return attr.verdictPass === false ? "failed" : "success";
  }
  if (FAIL_OUTCOMES.has(outcome)) return "failed";
  if (outcome === "rework") return "rework";
  if (ISOLATED_OUTCOMES.has(outcome)) return "isolated";
  return null;
}

const U32_MAX = 0xffff_ffff;
const saturatingAdd = (value: number, max: number): number => (value >= max ? max : value + 1);

/**
 * Sample-recording port — stall > verifier rejection (w=2) > outcome string.
 * Environmental outcomes are isolated (logged, never counted). Never mutates `prior`.
 */
export function applyStepVerdictAttribution(
  prior: HarnessSuccessRatePrior,
  attr: HarnessStepVerdictAttribution,
): HarnessAttributionUpdate {
  const out: HarnessAttributionUpdate = {
    runId: attr.runId,
    stepRunId: attr.stepRunId,
    kind: "unrecognized",
    recorded: false,
    weight: 0,
    prior: { ...prior },
  };
  const kind = classify(attr);
  if (kind === null) return out;
  out.kind = kind;
  const bound = attr.runId.trim() !== "" && attr.stepRunId.trim() !== "";
  if (!bound || kind === "isolated") return out;

  const ok = kind === "success";
  out.weight = kind === "failed" && attr.verdictPass === false ? HARNESS_VERDICT_FAIL_PENALTY : 1.0;
  out.prior = {
    ewmaSuccess: prior.ewmaSuccess * HARNESS_GAMMA + (ok ? out.weight : 0.0),
    ewmaFail: prior.ewmaFail * HARNESS_GAMMA + (ok ? 0.0 : out.weight),
    rawSamples: saturatingAdd(prior.rawSamples, Number.MAX_SAFE_INTEGER),
    consecutiveErrors: ok ? 0 : saturatingAdd(prior.consecutiveErrors, U32_MAX),
  };
  out.recorded = true;
  return out;
}
