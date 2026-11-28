export type ExceptionHuddleEligibility =
  | {
      eligible: true;
      category: "qa_content_rejection" | "spec_interpretation_conflict" | "external_source_gap";
      reason: string;
    }
  | {
      eligible: false;
      category:
        | "runtime_tool_error"
        | "infra_quota_timeout"
        | "auth_permission_error"
        | "selector_or_contract_error"
        | "unknown_non_collaborative";
      recommendedRoute: "backoff_retry" | "operator_escalation";
      reason: string;
    };

type ClassifierInput = {
  errorCode?: string | null;
  errorSummary?: string | null;
  verdict?: string | null;
  stepRole?: string | null;
  failureKind?: string | null;
  qaFailureCount?: number | null;
};

const SELECTOR_PREFIXES = [
  "workproduct_selector_",
  "qa_artifact_",
  "producer_rebind_",
  "publication_verify_",
];

function hasToken(value: string, token: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`, "i").test(value);
}

function hasPrefix(value: string, prefix: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${prefix}`, "i").test(value);
}

function hasHttpCode(value: string, codes: readonly number[]): boolean {
  return codes.some((code) => new RegExp(`(?:^|[^0-9])${code}(?:$|[^0-9])`).test(value));
}

function hasAny(values: readonly string[], matcher: (value: string) => boolean): boolean {
  return values.some(matcher);
}

function reject(
  category: Extract<ExceptionHuddleEligibility, { eligible: false }>["category"],
  recommendedRoute: Extract<ExceptionHuddleEligibility, { eligible: false }>["recommendedRoute"],
  reason: string,
): ExceptionHuddleEligibility {
  return { eligible: false, category, recommendedRoute, reason };
}

function scanBlockedMarkers(fields: readonly string[]): ExceptionHuddleEligibility | null {
  if (hasAny(fields, (value) => SELECTOR_PREFIXES.some((prefix) => hasPrefix(value, prefix)))) {
    return reject("selector_or_contract_error", "operator_escalation", "selector_or_contract_marker_detected");
  }

  if (
    hasAny(fields, (value) =>
      hasPrefix(value, "cms-qa-") ||
      hasPrefix(value, "ERR_") ||
      ["tool_execution_failed", "ENOENT", "EACCES", "ECONNREFUSED", "TypeError", "SyntaxError", "workflow_reconciler"]
        .some((marker) => hasToken(value, marker)) ||
      /(?:^|[^a-z0-9])exit\s+code(?:$|[^a-z0-9])/i.test(value),
    )
  ) {
    return reject("runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected");
  }

  if (
    hasAny(fields, (value) =>
      hasHttpCode(value, [429, 502, 503, 504]) ||
      ["rate_limit", "quota", "timeout", "timed_out", "ETIMEDOUT", "ECONNRESET", "overloaded"]
        .some((marker) => hasToken(value, marker)) ||
      /(?:^|[^a-z0-9])rate(?:_|\s+)limit(?:$|[^a-z0-9])/i.test(value),
    )
  ) {
    return reject("infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected");
  }

  if (
    hasAny(fields, (value) =>
      hasHttpCode(value, [401, 403]) ||
      ["unauthorized", "forbidden", "permission_denied", "secret_missing", "invalid_api_key"]
        .some((marker) => hasToken(value, marker)),
    )
  ) {
    return reject("auth_permission_error", "operator_escalation", "auth_permission_marker_detected");
  }

  return null;
}

/** Pure, deterministic gate for structured exception huddles. */
export function classifyExceptionHuddleEligibility(input: ClassifierInput): ExceptionHuddleEligibility {
  const fields = [input.errorCode ?? "", input.errorSummary ?? "", input.failureKind ?? ""];
  const blocked = scanBlockedMarkers(fields);
  if (blocked) return blocked;

  if (input.errorCode?.trim()) {
    return reject("unknown_non_collaborative", "operator_escalation", "unknown_error_code");
  }

  const allowedFailureKinds = ["qa_rejection", "spec_interpretation_conflict", "external_source_gap"];
  if (input.failureKind?.trim() && !allowedFailureKinds.includes(input.failureKind)) {
    return reject("unknown_non_collaborative", "operator_escalation", "unknown_failure_kind");
  }

  const count = input.qaFailureCount;
  if (count != null && (!Number.isFinite(count) || count < 0 || !Number.isInteger(count))) {
    return reject("unknown_non_collaborative", "operator_escalation", "invalid_qa_failure_count");
  }
  if (count != null && count > 1) {
    return reject("unknown_non_collaborative", "operator_escalation", "huddle_mvp_first_qa_failure_only");
  }

  if (input.verdict === "REQUEST_CHANGES" || input.verdict === "REJECT" || input.failureKind === "qa_rejection") {
    return {
      eligible: true,
      category: "qa_content_rejection",
      reason: "structured_qa_rejection_signal",
    };
  }
  if (input.failureKind === "spec_interpretation_conflict") {
    return {
      eligible: true,
      category: "spec_interpretation_conflict",
      reason: "structured_spec_interpretation_conflict_signal",
    };
  }
  if (input.failureKind === "external_source_gap") {
    return {
      eligible: true,
      category: "external_source_gap",
      reason: "structured_external_source_gap_signal",
    };
  }

  return reject("unknown_non_collaborative", "operator_escalation", "no_structured_collaborative_signal");
}
