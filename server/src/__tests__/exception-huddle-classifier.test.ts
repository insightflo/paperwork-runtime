import { describe, expect, it } from "vitest";
import { classifyExceptionHuddleEligibility } from "../services/missions/exception-huddle-classifier.js";

const NEGATIVE_MARKERS = [
  ["workproduct_selector_stale_producer", "selector_or_contract_error", "operator_escalation", "selector_or_contract_marker_detected"],
  ["qa_artifact_consumer_receipt_required", "selector_or_contract_error", "operator_escalation", "selector_or_contract_marker_detected"],
  ["producer_rebind_missing", "selector_or_contract_error", "operator_escalation", "selector_or_contract_marker_detected"],
  ["publication_verify_failed", "selector_or_contract_error", "operator_escalation", "selector_or_contract_marker_detected"],
  ["cms-qa-failed", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["tool_execution_failed", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["ENOENT", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["EACCES", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["ECONNREFUSED", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["ERR_MODULE_NOT_FOUND", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["TypeError", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["SyntaxError", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["exit code", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["workflow_reconciler: step_settled_failed", "runtime_tool_error", "operator_escalation", "runtime_tool_marker_detected"],
  ["429", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["rate_limit", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["Rate limit reached", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["quota", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["timeout", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["timed_out", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["ETIMEDOUT", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["ECONNRESET", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["502", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["503", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["504", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["overloaded", "infra_quota_timeout", "backoff_retry", "infra_quota_timeout_marker_detected"],
  ["401", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
  ["403", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
  ["unauthorized", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
  ["forbidden", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
  ["permission_denied", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
  ["secret_missing", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
  ["invalid_api_key", "auth_permission_error", "operator_escalation", "auth_permission_marker_detected"],
] as const;

describe("classifyExceptionHuddleEligibility", () => {
  for (const field of ["errorCode", "errorSummary", "failureKind"] as const) {
    describe(`${field} blocked markers`, () => {
      for (const [marker, category, recommendedRoute, reason] of NEGATIVE_MARKERS) {
        it(`blocks ${marker}`, () => {
          expect(
            classifyExceptionHuddleEligibility({ verdict: "REQUEST_CHANGES", [field]: marker }),
          ).toEqual({ eligible: false, category, recommendedRoute, reason });
        });
      }
    });
  }

  it("prefers the documented category order across fields", () => {
    expect(
      classifyExceptionHuddleEligibility({
        errorCode: "403",
        errorSummary: "503 temporary outage",
        failureKind: "workproduct_selector_not_exactly_one",
        verdict: "REQUEST_CHANGES",
      }),
    ).toEqual({
      eligible: false,
      category: "selector_or_contract_error",
      recommendedRoute: "operator_escalation",
      reason: "selector_or_contract_marker_detected",
    });
  });

  it.each([429, 502, 503, 504])("matches embedded HTTP marker http_%s", (code) => {
    expect(
      classifyExceptionHuddleEligibility({ errorSummary: `http_${code}`, failureKind: "external_source_gap" }),
    ).toMatchObject({ eligible: false, category: "infra_quota_timeout" });
  });

  it.each(["1429", "4290", "1502", "5023", "1503", "5034", "1504", "5040"])(
    "requires digit boundaries around HTTP marker %s",
    (digits) => {
      expect(
        classifyExceptionHuddleEligibility({ errorSummary: `http_${digits}`, failureKind: "external_source_gap" }),
      ).toMatchObject({ eligible: true, category: "external_source_gap" });
    },
  );

  it.each(["REQUEST_CHANGES", "REJECT"] as const)("allows exact QA verdict %s", (verdict) => {
    expect(classifyExceptionHuddleEligibility({ verdict, qaFailureCount: 1 })).toEqual({
      eligible: true,
      category: "qa_content_rejection",
      reason: "structured_qa_rejection_signal",
    });
  });

  it.each(["request_changes", " REJECT", "REQUEST_CHANGES "])("does not normalize verdict %s", (verdict) => {
    expect(classifyExceptionHuddleEligibility({ verdict })).toMatchObject({
      eligible: false,
      reason: "no_structured_collaborative_signal",
    });
  });

  it.each([" qa_rejection ", "QA_REJECTION"])("does not normalize failure kind %s", (failureKind) => {
    expect(classifyExceptionHuddleEligibility({ failureKind })).toMatchObject({ eligible: false });
  });

  it("allows the first QA failure by exact failure kind and defaults a missing count to one", () => {
    expect(classifyExceptionHuddleEligibility({ failureKind: "qa_rejection" })).toMatchObject({
      eligible: true,
      category: "qa_content_rejection",
    });
  });

  it.each([
    ["spec_interpretation_conflict", "spec_interpretation_conflict"],
    ["external_source_gap", "external_source_gap"],
  ] as const)("allows structured failure kind %s", (failureKind, category) => {
    expect(classifyExceptionHuddleEligibility({ failureKind })).toMatchObject({ eligible: true, category });
  });

  it.each([
    { verdict: "REQUEST_CHANGES" },
    { verdict: "REJECT" },
    { failureKind: "qa_rejection" },
    { failureKind: "spec_interpretation_conflict" },
    { failureKind: "external_source_gap" },
  ])("blocks a repeated failure from opening another huddle: %o", (positiveSignal) => {
    expect(classifyExceptionHuddleEligibility({ ...positiveSignal, qaFailureCount: 2 })).toEqual({
      eligible: false,
      category: "unknown_non_collaborative",
      recommendedRoute: "operator_escalation",
      reason: "huddle_mvp_first_qa_failure_only",
    });
  });

  it.each([NaN, Infinity, -1, 1.5])("rejects invalid QA failure count %s", (qaFailureCount) => {
    expect(classifyExceptionHuddleEligibility({ verdict: "REQUEST_CHANGES", qaFailureCount })).toMatchObject({
      eligible: false,
      category: "unknown_non_collaborative",
      reason: "invalid_qa_failure_count",
    });
  });

  it("fails closed for unknown explicit codes and failure kinds", () => {
    expect(classifyExceptionHuddleEligibility({ errorCode: "new_error", verdict: "REQUEST_CHANGES" })).toMatchObject({
      eligible: false,
      reason: "unknown_error_code",
    });
    expect(classifyExceptionHuddleEligibility({ failureKind: "new_failure", verdict: "REJECT" })).toMatchObject({
      eligible: false,
      reason: "unknown_failure_kind",
    });
  });

  it("does not treat prose, an error summary, or a verdict-like phrase as positive authority", () => {
    expect(classifyExceptionHuddleEligibility({ errorSummary: "QA says REQUEST_CHANGES" })).toMatchObject({
      eligible: false,
      reason: "no_structured_collaborative_signal",
    });
    expect(classifyExceptionHuddleEligibility({ errorSummary: "content rejected" })).toMatchObject({
      eligible: false,
      reason: "no_structured_collaborative_signal",
    });
  });

  it("allows a structured signal with unrelated summary prose and preserves the input", () => {
    const input = Object.freeze({
      errorSummary: "The producer could not satisfy an ambiguous requirement.",
      failureKind: "spec_interpretation_conflict",
      stepRole: "producer",
      qaFailureCount: null,
    });
    const before = { ...input };
    const first = classifyExceptionHuddleEligibility(input);
    expect(first).toMatchObject({ eligible: true, category: "spec_interpretation_conflict" });
    expect(classifyExceptionHuddleEligibility(input)).toEqual(first);
    expect(input).toEqual(before);
  });

  it("fails closed for empty and null input", () => {
    for (const input of [{}, { errorCode: null, errorSummary: null, verdict: null, failureKind: null, qaFailureCount: null }]) {
      expect(classifyExceptionHuddleEligibility(input)).toMatchObject({
        eligible: false,
        category: "unknown_non_collaborative",
        recommendedRoute: "operator_escalation",
      });
    }
  });
});
